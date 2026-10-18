import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { folderOfWorkspaceJson, latestStoragePerFolder, listWorkspaceStorages, parseWorktreeList, samePath } from '../../src/folders';
import { pushHistory, undoTargets } from '../../src/history';
import { WAIT_AND_APPLY_SH, planBaseName, readPlanFiles, removePlanFiles, sqlForTarget, writePlanFiles } from '../../src/plan';
import { runRestartPlan } from '../../src/restartHelper';
import { readItems } from '../../src/stateDb';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-apply-'));

function vscodeDb(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('other.key', 'keep me');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('extensionsIdentifiers/disabled', '[{"id":"old.one"}]');
  db.close();
  return file;
}

const sqlite = ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3'].find((p) => fs.existsSync(p));

test('sqlForTarget escapes quotes and runs against a VS Code-shaped database with the sqlite3 CLI', { skip: !sqlite && 'sqlite3 CLI not installed' }, () => {
  const file = vscodeDb(tmp());
  const target = {
    dbPath: file,
    items: { 'extensionsIdentifiers/enabled': `[{"id":"it's.quoted"}]`, 'extensionsIdentifiers/disabled': null },
  };
  const sql = sqlForTarget(target);
  assert.match(sql, /^-- db: /);
  execFileSync(sqlite!, [file], { input: sql });
  assert.deepEqual(readItems(file, ['extensionsIdentifiers/enabled', 'extensionsIdentifiers/disabled', 'other.key']), {
    'extensionsIdentifiers/enabled': `[{"id":"it's.quoted"}]`,
    'extensionsIdentifiers/disabled': undefined,
    'other.key': 'keep me',
  });
});

test('plan files: one per database, the latest request wins, and they can be removed per database', () => {
  const dir = tmp();
  writePlanFiles(dir, [{ dbPath: '/a/state.vscdb', items: { k: '1' } }, { dbPath: '/b/state.vscdb', items: { k: '1' } }]);
  writePlanFiles(dir, [{ dbPath: '/a/state.vscdb', items: { k: '2' } }]);
  const plans = readPlanFiles(dir).map((p) => p.target).sort((x, y) => x.dbPath.localeCompare(y.dbPath));
  assert.deepEqual(plans, [
    { dbPath: '/a/state.vscdb', items: { k: '2' } },
    { dbPath: '/b/state.vscdb', items: { k: '1' } },
  ]);
  assert.ok(fs.existsSync(path.join(dir, `${planBaseName('/a/state.vscdb')}.sql`)));
  removePlanFiles(dir, ['/a/state.vscdb']);
  assert.deepEqual(readPlanFiles(dir).map((p) => p.target.dbPath), ['/b/state.vscdb']);
});

test('runRestartPlan writes every target and pending plan files after the process exits, then relaunches', async () => {
  const root = tmp();
  const a = vscodeDb(path.join(root, 'a'));
  const b = vscodeDb(path.join(root, 'b'));
  const planDir = path.join(root, 'plans');
  writePlanFiles(planDir, [{ dbPath: b, items: { 'extensionsIdentifiers/enabled': '[{"id":"from.plan"}]' } }]);
  const marker = path.join(root, 'relaunched');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  const started = Date.now();
  // 실제 도우미는 ELECTRON_RUN_AS_NODE=1로 실행되므로 같은 조건을 만든다.
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const result = await runRestartPlan({
    mainPid: sleeper.pid!,
    targets: [
      { dbPath: a, items: { 'extensionsIdentifiers/disabled': null, 'extensionsIdentifiers/enabled': '[{"id":"a.b"}]' } },
      { dbPath: path.join(root, 'missing', 'state.vscdb'), items: { k: 'v' } },
    ],
    planDir,
    relaunch: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.ELECTRON_RUN_AS_NODE ?? 'unset')`] },
    pollMs: 50,
  }).finally(() => delete process.env.ELECTRON_RUN_AS_NODE);
  assert.equal(result, 'applied');
  assert.ok(Date.now() - started >= 350, 'should not write while the process is alive');
  assert.deepEqual(readItems(a, ['extensionsIdentifiers/disabled', 'extensionsIdentifiers/enabled', 'other.key']), {
    'extensionsIdentifiers/disabled': undefined,
    'extensionsIdentifiers/enabled': '[{"id":"a.b"}]',
    'other.key': 'keep me',
  });
  assert.equal(readItems(b, ['extensionsIdentifiers/enabled'])['extensionsIdentifiers/enabled'], '[{"id":"from.plan"}]');
  assert.deepEqual(readPlanFiles(planDir), [], 'applied plan files are removed');
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'unset', 'relaunch must not inherit ELECTRON_RUN_AS_NODE');
});

test('runRestartPlan still accepts the single-target plan of 0.4', async () => {
  const file = vscodeDb(tmp());
  const result = await runRestartPlan({ mainPid: 999999, dbPath: file, items: { k: 'v' }, pollMs: 10 });
  assert.equal(result, 'applied');
  assert.equal(readItems(file, ['k']).k, 'v');
});

test('runRestartPlan gives up without writing if the process never exits', async () => {
  const file = vscodeDb(tmp());
  const result = await runRestartPlan({ mainPid: process.pid, targets: [{ dbPath: file, items: { k: 'v' } }], timeoutMs: 150, pollMs: 50 });
  assert.equal(result, 'timeout');
  assert.equal(readItems(file, ['k']).k, undefined);
});

test('the sh helper waits for the process, applies .sql plans and removes them', { skip: (process.platform === 'win32' || !sqlite) && 'needs sh and sqlite3' }, async () => {
  const root = tmp();
  const file = vscodeDb(path.join(root, 'ws'));
  const planDir = path.join(root, 'plans');
  writePlanFiles(planDir, [{ dbPath: file, items: { 'extensionsIdentifiers/enabled': '[{"id":"on.quit"}]' } }]);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
  const log = path.join(root, 'log.txt');
  const helper = spawn('/bin/sh', ['-c', WAIT_AND_APPLY_SH, 'test-helper', String(sleeper.pid), planDir, log, sqlite!]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.existsSync(path.join(planDir, 'helper.pid')), 'helper records its pid while waiting');
  assert.equal(readItems(file, ['extensionsIdentifiers/enabled'])['extensionsIdentifiers/enabled'], undefined, 'nothing written while VS Code runs');
  await new Promise((r) => helper.on('exit', r));
  assert.equal(readItems(file, ['extensionsIdentifiers/enabled'])['extensionsIdentifiers/enabled'], '[{"id":"on.quit"}]');
  assert.deepEqual(fs.readdirSync(planDir), [], 'plans and pid file are cleaned up');
  assert.match(fs.readFileSync(log, 'utf8'), /applied on quit/);
});

test('parseWorktreeList reads git porcelain output', () => {
  const out = 'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt-1\nHEAD def\ndetached\n\n';
  assert.deepEqual(parseWorktreeList(out), ['/repo/main', '/repo/wt-1']);
});

test('samePath ignores trailing slashes, and case except on Linux', () => {
  assert.ok(samePath('/a/B/', '/a/b', 'darwin'));
  assert.ok(samePath('/a/B', '/a/b', 'win32'));
  assert.ok(!samePath('/a/B', '/a/b', 'linux'));
});

test('workspace storages are found from workspace.json, newest first, one per folder', async () => {
  const root = tmp();
  const mk = (name: string, json: object | string, mtime: number) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'workspace.json'), typeof json === 'string' ? json : JSON.stringify(json));
    fs.writeFileSync(path.join(dir, 'state.vscdb'), '');
    fs.utimesSync(path.join(dir, 'state.vscdb'), mtime, mtime);
  };
  mk('old', { folder: 'file:///repo/wt-1' }, 1000);
  mk('new', { folder: 'file:///repo/wt-1' }, 2000);
  mk('other', { folder: 'file:///repo/main' }, 1500);
  mk('multi', { workspace: 'file:///x.code-workspace' }, 3000);
  mk('remote', { folder: 'vscode-remote://ssh/x' }, 3000);
  mk('broken', '{', 3000);
  const uriToPath = (u: string) => decodeURIComponent(u.replace(/^file:\/\//, ''));
  const found = latestStoragePerFolder(await listWorkspaceStorages(root, uriToPath), 'linux');
  assert.deepEqual(found.map((e) => [path.basename(e.dir), e.folder]), [
    ['new', '/repo/wt-1'],
    ['other', '/repo/main'],
  ]);
  assert.equal(folderOfWorkspaceJson('{"folder":"file:///a%20b"}', uriToPath), '/a b');
});

test('history keeps the newest ten and undo restores every target', () => {
  let list: Parameters<typeof pushHistory>[0] = [];
  for (let i = 0; i < 12; i++) list = pushHistory(list, { time: i, label: `#${i}`, targets: [] });
  assert.equal(list.length, 10);
  assert.equal(list[0].label, '#11');
  const plan = undoTargets({
    time: 0,
    label: 'x',
    targets: [{ dbPath: '/a', before: { 'extensionsIdentifiers/enabled': null, 'extensionsIdentifiers/disabled': '[{"id":"z.z"}]' } }],
  });
  assert.deepEqual(plan, [{ dbPath: '/a', label: undefined, items: { 'extensionsIdentifiers/enabled': null, 'extensionsIdentifiers/disabled': '[{"id":"z.z"}]' } }]);
});
