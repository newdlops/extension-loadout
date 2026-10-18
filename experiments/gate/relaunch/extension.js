// 가능성 시험 2: 확장이 분리된 도우미를 띄우고 VS Code를 종료한다.
// 도우미는 VS Code 메인 프로세스가 끝나기를 기다린 뒤 state.vscdb를 고치고 같은 인자로 다시 실행한다.
const vscode = require('vscode'), fs = require('fs'), path = require('path'), cp = require('child_process');
const G = path.resolve(__dirname, '../../../.vscode-test/gate');
const LOG = path.join(G, 'log.jsonl'), PH = path.join(G, 'phase');
const ID = 'gatetest.dummy';

const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const next = (p) => fs.writeFileSync(PH, p);
const quit = () => vscode.commands.executeCommand('workbench.action.quit');
const cmdOf = (pid) => { try { return cp.execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString().trim(); } catch { return ''; } };

const HELPER = `
const { DatabaseSync } = require('node:sqlite'); const cp = require('child_process'); const fs = require('fs');
const [mainPid, db, key, value, log, bin, ...args] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(mainPid), 0); return true; } catch { return false; } };
const t0 = Date.now();
(function wait() {
  if (alive()) { if (Date.now() - t0 > 30000) { fs.appendFileSync(log, JSON.stringify({ helper: 'timeout' }) + '\\n'); return; } return setTimeout(wait, 200); }
  const d = new DatabaseSync(db); d.exec('BEGIN');
  d.prepare('INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)').run(key, value); d.exec('COMMIT'); d.close();
  fs.appendFileSync(log, JSON.stringify({ t: Date.now(), helper: 'wrote-after-exit', waitedMs: Date.now() - t0 }) + '\\n');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  cp.spawn(bin, args, { detached: true, stdio: 'ignore', env }).unref();
})();
`;

exports.activate = async (ctx) => {
  try {
    const db = path.join(path.dirname(ctx.storageUri.fsPath), 'state.vscdb');
    const phase = fs.existsSync(PH) ? fs.readFileSync(PH, 'utf8') : 'start';
    const dummyVisible = !!vscode.extensions.getExtension(ID);
    const mainPid = process.ppid;
    log({ phase, dummyVisible, extHostPid: process.pid, mainPid, mainCmd: cmdOf(mainPid).slice(0, 160), execPath: process.execPath });

    if (phase === 'start') {
      const bin = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
      const args = ['--user-data-dir', path.join(G, 'ud'), '--extensions-dir', path.join(G, 'exts'),
        `--extensionDevelopmentPath=${__dirname}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', path.join(G, 'ws')];
      const child = cp.spawn(process.execPath,
        ['-e', HELPER, String(mainPid), db, 'extensionsIdentifiers/disabled', JSON.stringify([{ id: ID }]), LOG, bin, ...args],
        { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      child.unref();
      log({ helperPid: child.pid });
      next('after-helper');
      await quit();
    } else {
      next('done');
      await quit();
    }
  } catch (e) {
    log({ err: String((e && e.stack) || e).slice(0, 400) });
    quit();
  }
};
