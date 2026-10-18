// E2E 드라이버: 격리된 VS Code 안에서 Extension Loadout 명령을 실행하고, 재시작을 넘나들며 결과를 기록한다.
// 단계는 E2E 폴더의 phase 파일로 이어간다. scripts/run-e2e.mjs가 결과를 검사한다.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const DIR = process.env.EXTENSION_LOADOUT_E2E_DIR;
const ON = 'loadouttest.dummy-on'; // 전역에서 켜진 확장
const OFF = 'loadouttest.dummy-off'; // 전역에서 꺼진 확장

const log = (o) => fs.appendFileSync(path.join(DIR, 'driver.jsonl'), JSON.stringify({ t: Date.now(), ...o }) + '\n');
const phaseFile = () => path.join(DIR, 'phase');
const running = (id) => !!vscode.extensions.getExtension(id);
const quit = () => vscode.commands.executeCommand('workbench.action.quit');

exports.activate = async () => {
  if (!DIR) return;
  const phase = fs.existsSync(phaseFile()) ? fs.readFileSync(phaseFile(), 'utf8') : '1';
  const setPhase = (p) => fs.writeFileSync(phaseFile(), p);
  try {
    await vscode.extensions.getExtension('newdlops.extension-loadout').activate();
    const config = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', 'extension-loadout.json');
    log({ phase, on: running(ON), off: running(OFF), config: JSON.parse(fs.readFileSync(config, 'utf8')) });
    if (phase === '1') {
      setPhase('2');
      await vscode.commands.executeCommand('extensionLoadout.applyAndRestart');
    } else if (phase === '2') {
      await vscode.commands.executeCommand('extensionLoadout.followGlobal', ON);
      await vscode.commands.executeCommand('extensionLoadout.followGlobal', OFF);
      log({ phase, configAfterFollowGlobal: JSON.parse(fs.readFileSync(config, 'utf8')) });
      setPhase('3');
      await vscode.commands.executeCommand('extensionLoadout.applyAndRestart');
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
