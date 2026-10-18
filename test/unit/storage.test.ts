import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readInstalledExtensions } from '../../src/catalog';
import { runRestartPlan } from '../../src/restartHelper';
import { readItems, writeItems } from '../../src/stateDb';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-test-'));

function vscodeDb(dir: string): string {
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('other.key', 'keep me');
  db.close();
  return file;
}

test('writeItems sets and deletes keys without touching others', () => {
  const file = vscodeDb(tmp());
  writeItems(file, { a: '[1]', b: '[2]' });
  writeItems(file, { b: null });
  assert.deepEqual(readItems(file, ['a', 'b', 'other.key']), { a: '[1]', b: undefined, 'other.key': 'keep me' });
});

test('readInstalledExtensions reads names, skips obsolete and missing folders', () => {
  const dir = tmp();
  const ext = (folder: string, manifest: object, nls?: object) => {
    fs.mkdirSync(path.join(dir, folder));
    fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(manifest));
    if (nls) fs.writeFileSync(path.join(dir, folder, 'package.nls.json'), JSON.stringify(nls));
  };
  ext('pub.plain-1.0.0', { name: 'plain', displayName: 'Plain One', description: 'd' });
  ext('pub.nls-2.0.0', { name: 'nls', displayName: '%dn%' }, { dn: 'Localized Name' });
  ext('pub.old-1.0.0', { name: 'old', displayName: 'Old' });
  fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify({ 'pub.old-1.0.0': true }));
  fs.writeFileSync(
    path.join(dir, 'extensions.json'),
    JSON.stringify([
      { identifier: { id: 'Pub.Plain', uuid: 'u1' }, version: '1.0.0', relativeLocation: 'pub.plain-1.0.0' },
      { identifier: { id: 'pub.nls' }, version: '2.0.0', relativeLocation: 'pub.nls-2.0.0' },
      { identifier: { id: 'pub.old' }, version: '1.0.0', relativeLocation: 'pub.old-1.0.0' },
      { identifier: { id: 'pub.gone' }, version: '1.0.0', relativeLocation: 'pub.gone-1.0.0' },
    ]),
  );
  const list = readInstalledExtensions(dir);
  assert.deepEqual(
    list.map((e) => [e.id, e.displayName, e.uuid]),
    [
      ['pub.nls', 'Localized Name', undefined],
      ['pub.plain', 'Plain One', 'u1'],
    ],
  );
});

test('runRestartPlan waits for the process to exit, then writes and relaunches', async () => {
  const dir = tmp();
  const file = vscodeDb(dir);
  const marker = path.join(dir, 'relaunched');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)']);
  const started = Date.now();
  // 실제 도우미는 ELECTRON_RUN_AS_NODE=1로 실행되므로 같은 조건을 만든다.
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const result = await runRestartPlan({
    mainPid: sleeper.pid!,
    dbPath: file,
    items: { 'extensionsIdentifiers/disabled': '[{"id":"a.b"}]' },
    relaunch: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.ELECTRON_RUN_AS_NODE ?? 'unset')`] },
    pollMs: 50,
  }).finally(() => delete process.env.ELECTRON_RUN_AS_NODE);
  assert.equal(result, 'applied');
  assert.ok(Date.now() - started >= 400, 'should not write while the process is alive');
  assert.equal(readItems(file, ['extensionsIdentifiers/disabled'])['extensionsIdentifiers/disabled'], '[{"id":"a.b"}]');
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'unset', 'relaunch must not inherit ELECTRON_RUN_AS_NODE');
});

test('runRestartPlan gives up without writing if the process never exits', async () => {
  const file = vscodeDb(tmp());
  const result = await runRestartPlan({ mainPid: process.pid, dbPath: file, items: { k: 'v' }, timeoutMs: 150, pollMs: 50 });
  assert.equal(result, 'timeout');
  assert.equal(readItems(file, ['k']).k, undefined);
});
