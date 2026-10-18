// README 스크린샷용 드라이버: 예제 파일을 열어 언어 서버를 띄우고, 패널과 대시보드를 차례로 보여 준다.
// 각 단계가 준비되면 SHOTS_DIR에 표시 파일을 남기고, scripts/screenshots.mjs가 창을 캡처한다.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const DIR = process.env.EXTENSION_LOADOUT_SHOTS_DIR;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (name) => fs.writeFileSync(path.join(DIR, name), String(Date.now()));
const log = (m) => fs.appendFileSync(path.join(DIR, 'driver.log'), `${new Date().toISOString()} ${m}\n`);
const waitFor = async (name) => {
  while (!fs.existsSync(path.join(DIR, name))) await wait(300);
};

exports.activate = async () => {
  if (!DIR) return;
  try {
    await run();
  } catch (e) {
    log(`error: ${(e && e.stack) || e}`);
  }
};

async function run() {
  log('activated');
  const ws = vscode.workspace.workspaceFolders[0].uri;
  await vscode.extensions.getExtension('newdlops.extension-loadout').activate();
  log('loadout active');
  // 언어 서버가 뜨도록 파일을 연다.
  await vscode.window.showTextDocument(vscode.Uri.joinPath(ws, 'app', 'views.py'), { preview: false });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(ws, 'web', 'src', 'App.tsx'), { preview: false, viewColumn: vscode.ViewColumn.Active });
  log('files open');
  await wait(25000);
  await vscode.commands.executeCommand('_extensionLoadout.memory');
  log('memory measured');
  await vscode.commands.executeCommand('_extensionLoadout.recommendations');
  log('recommendations loaded');
  await vscode.commands.executeCommand('extensionLoadout.extensions.focus');
  // 캡처를 가리는 것 치우기: 오른쪽 채팅 패널, 알림. 사이드바는 넓혀서 설명이 덜 잘리게 한다.
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  // 너비 늘리기는 포커스가 있는 영역에 적용되므로 사이드바에 다시 포커스를 준다.
  await vscode.commands.executeCommand('extensionLoadout.extensions.focus');
  await vscode.commands.executeCommand('workbench.action.focusSideBar');
  for (let i = 0; i < 10; i++) {
    await vscode.commands.executeCommand('workbench.action.increaseViewSize');
    await wait(100);
  }
  await wait(4000);
  await vscode.commands.executeCommand('notifications.clearAll');
  await wait(800);
  mark('sidebar-ready');
  await waitFor('sidebar-done');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('extensionLoadout.openDashboard');
  await wait(5000);
  await vscode.commands.executeCommand('notifications.clearAll');
  await wait(800);
  mark('dashboard-ready');
  await waitFor('dashboard-done');
  await vscode.commands.executeCommand('workbench.action.quit');
}
