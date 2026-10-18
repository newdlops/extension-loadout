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

/** 멀티 루트·프로필 시험(scripts/run-e2e-extra.mjs). 한 번 띄워 확인하고 끝낸다. */
async function extraMode(mode) {
  await vscode.extensions.getExtension('newdlops.extension-loadout').activate();
  if (mode === 'multiroot') {
    const st = await run('_extensionLoadout.state');
    log({ mode, overrides: st.overrides, conflicts: st.conflicts, location: await run('_extensionLoadout.location') });
    await run('extensionLoadout.disableHere', RUST);
    const loc = await run('_extensionLoadout.location');
    log({ mode, afterEdit: JSON.parse(fs.readFileSync(loc.editable, 'utf8')), stateAfterEdit: (await run('_extensionLoadout.state')).overrides });
  } else if (mode === 'noop') {
    // 프로필을 만들기 위해 한 번 띄울 때.
  } else if (mode === 'profile') {
    log({ mode, installed: await run('_extensionLoadout.installedIds'), info: await run('_extensionLoadout.catalogInfo') });
  }
  fs.writeFileSync(path.join(DIR, `${mode}-done`), '1');
  await quit();
}

exports.activate = async (context) => {
  if (!DIR) return;
  const extra = process.env.EXTENSION_LOADOUT_E2E_MODE;
  if (extra) {
    try {
      await extraMode(extra);
    } catch (e) {
      log({ mode: extra, error: String((e && e.stack) || e) });
      fs.writeFileSync(path.join(DIR, `${extra}-done`), '1');
      await quit();
    }
    return;
  }
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
      log({ phase, recs: await run('_extensionLoadout.recommendations') });
      log({ phase, tree: await run('_extensionLoadout.tree') });
      await run('_extensionLoadout.setViewOptions', { show: 'always' });
      log({ phase, treeAlways: await run('_extensionLoadout.tree') });
      await run('_extensionLoadout.setViewOptions', { show: 'all' });
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
      // 의존 관계: 라이브러리를 끄면 필요한 확장도 함께, 필요한 확장을 켜면 라이브러리도 함께.
      await run('_extensionLoadout.set', ['loadouttest.dummy-base'], 'off', 'all');
      log({ phase, afterBaseOff: readConfig() });
      await run('_extensionLoadout.set', ['loadouttest.dummy-dep'], undefined, 'all');
      log({ phase, afterDepOn: readConfig() });
      // 프리셋: 저장 → 다른 상태로 바꿈 → 적용하면 저장한 상태로.
      fs.writeFileSync(config, JSON.stringify({ enable: [OFF], disable: [ON] }));
      await run('_extensionLoadout.savePreset', 'e2e');
      fs.writeFileSync(config, JSON.stringify({ enable: [], disable: [RUST] }));
      await run('_extensionLoadout.applyPreset', 'e2e');
      log({ phase, afterPreset: readConfig() });
      // 대시보드: 열어서 데이터를 받고, 표에서 끄는 것과 같은 메시지를 보낸다.
      log({ phase, dashboard: await run('_extensionLoadout.dashboard') });
      await run('_extensionLoadout.dashboard', { type: 'set', ids: [RUST], value: 'off' });
      log({ phase, afterDashboard: readConfig() });
      setPhase('done');
      await quit();
    }
  } catch (e) {
    log({ phase, error: String((e && e.stack) || e) });
    setPhase('done');
    await quit();
  }
};
