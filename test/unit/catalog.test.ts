import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { activationText, describeActivation, readInstalledExtensions } from '../../src/catalog';

test('describeActivation tells always-on, triggered and code-less extensions apart', () => {
  assert.deepEqual(describeActivation({ main: './x.js', activationEvents: ['onStartupFinished'] }), { kind: 'always', languages: [], files: [] });
  assert.deepEqual(describeActivation({ main: './x.js', activationEvents: ['*'] }).kind, 'always');
  assert.deepEqual(
    describeActivation({ main: './x.js', activationEvents: ['onLanguage:python', 'onLanguage:python', 'workspaceContains:**/gradlew'] }),
    { kind: 'triggered', languages: ['python'], files: ['gradlew'] },
  );
  // 1.74 이후 명령·뷰만 기여하는 확장은 이벤트가 비어 있어도 필요할 때만 켜진다.
  assert.equal(describeActivation({ main: './x.js' }).kind, 'triggered');
  assert.equal(describeActivation({ browser: './web.js' }).kind, 'triggered');
  assert.equal(describeActivation({ contributes: { themes: [] } }).kind, 'none');
});

test('activationText is short enough for a tree description', () => {
  assert.equal(activationText({ kind: 'always', languages: [], files: [] }), 'starts always');
  assert.equal(activationText({ kind: 'none', languages: [], files: [] }), 'no code');
  assert.equal(activationText({ kind: 'triggered', languages: ['a', 'b', 'c', 'd'], files: [] }), 'a, b, c, …');
  assert.equal(activationText({ kind: 'triggered', languages: [], files: ['gradlew'] }), 'when gradlew exists');
  assert.equal(activationText({ kind: 'triggered', languages: [], files: [] }), 'on demand');
});

test('readInstalledExtensions fills icon, publisher, categories and caches until extensions.json changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-catalog-'));
  const folder = path.join(dir, 'pub.one-1.0.0');
  fs.mkdirSync(path.join(folder, 'media'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'media', 'icon.png'), 'png');
  const manifest = { name: 'one', displayName: 'One', publisher: 'pub', icon: 'media/icon.png', categories: ['Linters'], main: './x.js', activationEvents: ['onLanguage:python'] };
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(manifest));
  const index = path.join(dir, 'extensions.json');
  fs.writeFileSync(index, JSON.stringify([{ identifier: { id: 'pub.one' }, version: '1.0.0', relativeLocation: 'pub.one-1.0.0' }]));

  const [one] = await readInstalledExtensions(dir);
  assert.equal(one.icon, path.join(folder, 'media', 'icon.png'));
  assert.equal(one.publisher, 'pub');
  assert.deepEqual(one.categories, ['Linters']);
  assert.deepEqual(one.activation, { kind: 'triggered', languages: ['python'], files: [] });

  // 매니페스트만 바뀌면 캐시를 그대로 쓴다.
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ ...manifest, displayName: 'Renamed' }));
  assert.equal((await readInstalledExtensions(dir))[0].displayName, 'One');
  // extensions.json이 바뀌면(설치·업데이트·제거) 다시 읽는다.
  fs.writeFileSync(index, JSON.stringify([{ identifier: { id: 'pub.one' }, version: '1.0.1', relativeLocation: 'pub.one-1.0.0' }]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(index, later, later);
  assert.equal((await readInstalledExtensions(dir))[0].displayName, 'Renamed');
});
