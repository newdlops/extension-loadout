// E2E 드라이버: 격리된 VS Code 안에서 Extension Loadout 명령을 실행하고, 재시작을 넘나들며 결과를 기록한다.
// 단계는 E2E 폴더의 phase 파일로 이어간다. scripts/run-e2e.mjs가 결과를 검사한다.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const DIR = process.env.EXTENSION_LOADOUT_E2E_DIR;
const WS2 = process.env.EXTENSION_LOADOUT_E2E_WS2;
const ON = 'loadouttest.dummy-on'; // 전역에서 켜진 확장
const OFF = 'loadouttest.dummy-off'; // 전역에서 꺼진 확장
const RUST = 'loadouttest.dummy-rust'; // Rust 파일에서만 켜지는 확장

const log = (o) => fs.appendFileSync(path.join(DIR, 'driver.jsonl'), JSON.stringify({ t: Date.now(), ...o }) + '\n');
const phaseFile = () => path.join(DIR, 'phase');
const running = (id) => !!vscode.extensions.getExtension(id);
const quit = () => vscode.commands.executeCommand('workbench.action.quit');
const run = (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args);

/** 다른 폴더(ws2)의 VS Code 저장소에 적힌 확장 활성 상태. */
function ws2Stored(context) {
  const root = path.dirname(path.dirname(context.storageUri.fsPath));
  for (const d of fs.readdirSync(root)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, d, 'workspace.json'), 'utf8'));
      if (!j.folder || vscode.Uri.parse(j.folder).fsPath.toLowerCase() !== WS2.toLowerCase()) continue;
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(root, d, 'state.vscdb'), { readOnly: true });
      const get = (k) => {
        const r = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(k);
        return r ? JSON.parse(String(r.value)).map((x) => x.id) : null;
      };
      const out = { enabled: get('extensionsIdentifiers/enabled'), disabled: get('extensionsIdentifiers/disabled') };
      db.close();
      return out;
    } catch {
      // 다음 폴더
    }
  }
  return 'not found';
}

exports.activate = async (context) => {
  if (!DIR) return;
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return log({ error: 'no folder open' });
  if (WS2 && folder.uri.fsPath.toLowerCase() === WS2.toLowerCase()) {
    // 0단계: 저장소만 만들고 끝낸다.
    log({ ws2: 'prepared' });
    await new Promise((r) => setTimeout(r, 1500));
    return quit();
  }
  const phase = fs.existsSync(phaseFile()) ? fs.readFileSync(phaseFile(), 'utf8') : '1';
  const setPhase = (p) => fs.writeFileSync(phaseFile(), p);
  const config = path.join(folder.uri.fsPath, '.vscode', 'extension-loadout.json');
  const readConfig = () => {
    const { enable, disable } = JSON.parse(fs.readFileSync(config, 'utf8'));
    return { enable, disable };
  };
  try {
    await vscode.extensions.getExtension('newdlops.extension-loadout').activate();
    log({ phase, on: running(ON), off: running(OFF), config: readConfig() });
    if (phase === '1') {
      log({ phase, suggestions: await run('_extensionLoadout.suggestions') });
      // 시험용 확장이 자식 프로세스를 띄울 시간을 준다.
      await new Promise((r) => setTimeout(r, 3000));
      const memory = await run('_extensionLoadout.memory');
      log({ phase, heavy: memory.find((m) => m.id === 'loadouttest.dummy-heavy') ?? null });
      log({ phase, pressure: (await run('_extensionLoadout.pressure')).level });
      setPhase('2');
      await run('extensionLoadout.applyAndRestart');
    } else if (phase === '2') {
      // 체크박스로 고른 것을 한꺼번에 끈다.
      await run('_extensionLoadout.select', [ON, RUST]);
      await run('extensionLoadout.disableSelected');
      log({ phase, configAfterSelectedOff: readConfig() });
      // 여러 개를 한 번에 전역 따름으로 되돌린다.
      await run('extensionLoadout.followGlobal', [ON, OFF, RUST]);
      log({ phase, configAfterFollowGlobal: readConfig() });
      setPhase('3');
      await run('extensionLoadout.applyAndRestart');
    } else if (phase === '3') {
      await run('extensionLoadout.disableHere', ON);
      await run('_extensionLoadout.applyOnQuit');
      const st = await run('_extensionLoadout.state');
      log({ phase, scheduled: st.scheduled });
      setPhase('4');
      fs.writeFileSync(path.join(DIR, 'relaunch-needed'), '1');
      await quit();
    } else if (phase === '4') {
      setPhase('5');
      const picked = await run('_extensionLoadout.applyToFolders', [WS2], 'now');
      log({ phase, picked });
    } else if (phase === '5') {
      log({ phase, ws2: ws2Stored(context) });
      setPhase('6');
      await run('_extensionLoadout.undo');
    } else if (phase === '6') {
      log({ phase, ws2: ws2Stored(context) });
      setPhase('7');
      await run('_extensionLoadout.undo');
    } else {
      setPhase('done');
      await quit();
    }
  } catch (e) {
    log({ phase, error: String((e && e.stack) || e) });
    setPhase('done');
    await quit();
  }
};
