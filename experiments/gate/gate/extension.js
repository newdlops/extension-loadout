// 가능성 시험: 실행 중인 창에서 워크스페이스 state.vscdb의 확장 비활성 목록을 고친 뒤
// 어떤 창 전환 경로에서 반영되는지 확인한다. 결과는 .vscode-test/gate/log.jsonl에 남긴다.
const vscode = require('vscode'), fs = require('fs'), path = require('path');
const G = path.resolve(__dirname, '../../../.vscode-test/gate');
const LOG = path.join(G, 'log.jsonl'), PH = path.join(G, 'phase');
const KEY = 'extensionsIdentifiers/disabled', ID = 'gatetest.dummy';

const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const next = (p) => fs.writeFileSync(PH, p);

function setKey(db, val) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(db);
  d.exec('BEGIN');
  d.prepare('INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)').run(KEY, JSON.stringify(val));
  d.exec('COMMIT');
  const r = d.prepare('SELECT value FROM ItemTable WHERE key=?').get(KEY);
  d.close();
  return r && r.value;
}

const openFolder = (dir) =>
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: false }).then(() => {}, () => {});
const quit = () => vscode.commands.executeCommand('workbench.action.quit');

exports.activate = async (ctx) => {
  try {
    const db = path.join(path.dirname(ctx.storageUri.fsPath), 'state.vscdb');
    for (let i = 0; i < 20 && !fs.existsSync(db); i++) await new Promise((r) => setTimeout(r, 500));
    const phase = fs.existsSync(PH) ? fs.readFileSync(PH, 'utf8') : 'start';
    const here = path.basename(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const dummyVisible = !!vscode.extensions.getExtension(ID);
    log({ phase, here, dummyVisible });

    if (here === 'ws2') {
      if (phase === 'bounce') { next('after-bounce'); await openFolder(path.join(G, 'ws')); }
      return;
    }
    if (phase === 'start') {
      log({ wrote: setKey(db, [{ id: ID }]) });
      // 같은 폴더를 같은 창에서 다시 여는 것은 VS Code가 무시하므로 다른 폴더를 거쳐 돌아온다.
      next('bounce');
      await openFolder(path.join(G, 'ws2'));
    } else if (phase === 'after-bounce' && dummyVisible) {
      next('after-relaunch');
      await quit();
    } else {
      next('done');
      await quit();
    }
  } catch (e) {
    log({ err: String((e && e.stack) || e).slice(0, 300) });
    quit();
  }
};
