// Ruff 흉내: Markdown 파일만 있어도 켜지고, 켜지면 다른 확장(dummy-chained, Pylance 흉내)을 API로 켠다.
const vscode = require('vscode');
exports.activate = async () => {
  await vscode.extensions.getExtension('loadouttest.dummy-chained')?.activate();
};
