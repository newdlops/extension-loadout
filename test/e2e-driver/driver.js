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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEAVY = 'loadouttest.dummy-heavy';
/** 프로세스가 살아 있는지(신호 0은 Windows에서도 존재 확인으로 동작한다). Linux의 좀비(끝났지만 아직 거둬지지 않음)는 끝난 것으로 본다. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
};

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
    log({ mode, overrides: st.overrides, conflicts: st.conflicts, location: await run('_extensionLoadout.location'), installed: await run('_extensionLoadout.installedIds') });
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
      const heavy = memory.find((m) => m.id === HEAVY) ?? null;
      log({ phase, heavy });
      // 메모리 압박 알림이 "여기서 끄기"로 제안할 확장.
      log({ phase, heaviest: await run('_extensionLoadout.heaviestSwitchable') });
      log({ phase, pressure: (await run('_extensionLoadout.pressure')).level });
      log({ phase, recs: await run('_extensionLoadout.recommendations') });
      log({ phase, tree: await run('_extensionLoadout.tree') });
      await run('_extensionLoadout.setViewOptions', { show: 'always' });
      log({ phase, treeAlways: await run('_extensionLoadout.tree') });
      await run('_extensionLoadout.setViewOptions', { show: 'all' });
      // 확장 호스트 재시작: 이 확장 호스트와 무거운 확장의 자식 프로세스가 끝나고, 새 확장 호스트에서 드라이버가 1b단계로 이어간다.
      const heavyPids = heavy ? heavy.pidList : [];
      const procs = await run('_extensionLoadout.processes', [process.pid, ...heavyPids]);
      const commands = Object.fromEntries(procs.map((p) => [p.pid, p.command]));
      fs.writeFileSync(path.join(DIR, 'host-before.json'), JSON.stringify({ host: process.pid, heavyPids, commands }));
      setPhase('1b');
      await run('_extensionLoadout.restartExtensionHost').catch(() => undefined);
      // 여기까지 오면(30초 넘게 이 확장 호스트가 살아 있으면) 재시작되지 않은 것이다.
      await sleep(30_000);
      log({ phase, error: 'the extension host was not restarted' });
      setPhase('done');
      await quit();
    } else if (phase === '1b') {
      const before = JSON.parse(fs.readFileSync(path.join(DIR, 'host-before.json'), 'utf8'));
      // 같은 번호를 다른 프로세스가 받았을 수 있으므로(Windows는 번호를 곧바로 다시 쓴다) 명령줄까지 같을 때만 옛 프로세스가 살아 있다고 본다.
      const stillRunning = async (pids) => {
        const live = pids.filter(alive);
        if (!live.length) return [];
        const procs = await run('_extensionLoadout.processes', live);
        return procs.filter((p) => p.command === before.commands[p.pid]).map((p) => p.pid);
      };
      // 옛 확장 호스트와 그 자식(1초마다 부모를 확인한다)이 끝나고, 새 확장 호스트의 무거운 확장이 자식을 다시 띄우기를 기다린다.
      let now = null;
      for (const until = Date.now() + 20_000; Date.now() < until; await sleep(1000)) {
        const memory = await run('_extensionLoadout.memory');
        now = memory.find((m) => m.id === HEAVY) ?? null;
        const respawned = !!now && now.pidList.some((p) => !before.heavyPids.includes(p));
        if (respawned && !(await stillRunning([before.host, ...before.heavyPids])).length) break;
      }
      log({
        phase,
        hostRestart: {
          hostBefore: before.host,
          hostNow: process.pid,
          commandsBefore: Object.keys(before.commands).length,
          oldHostAlive: (await stillRunning([before.host])).length > 0,
          heavyBefore: before.heavyPids,
          oldHeavyAlive: await stillRunning(before.heavyPids),
          heavyNow: now && { bytes: now.bytes, pids: now.pidList },
        },
      });
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
      // ws2는 이 저장소의 git worktree다. "다른 폴더에 적용"이 미리 골라 두는 worktree 목록에 들어 있어야 한다.
      const candidates = await run('_extensionLoadout.folderCandidates');
      log({ phase, candidates });
      setPhase('5');
      const picked = await run('_extensionLoadout.applyToFolders', candidates.worktrees, 'now');
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
