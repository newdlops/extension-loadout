import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { activationText, describeActivation, extensionFromManifest, pickProfile, profileSources, readInstalledExtensions } from '../../src/catalog';

test('describeActivation tells always-on, triggered and code-less extensions apart', () => {
  assert.deepEqual(describeActivation({ main: './x.js', activationEvents: ['onStartupFinished'] }), {
    kind: 'always',
    languages: [],
    files: [],
    globs: [],
    events: ['onStartupFinished'],
  });
  assert.deepEqual(describeActivation({ main: './x.js', activationEvents: ['*'] }).kind, 'always');
  assert.deepEqual(
    describeActivation({ main: './x.js', activationEvents: ['onLanguage:python', 'onLanguage:python', 'workspaceContains:**/gradlew'] }),
    { kind: 'triggered', languages: ['python'], files: ['gradlew'], globs: ['**/gradlew'], events: ['onLanguage:python', 'workspaceContains:**/gradlew'] },
  );
  // 1.74 이후 명령·뷰만 기여하는 확장은 이벤트가 비어 있어도 필요할 때만 켜진다.
  assert.equal(describeActivation({ main: './x.js' }).kind, 'triggered');
  assert.equal(describeActivation({ browser: './web.js' }).kind, 'triggered');
  assert.equal(describeActivation({ contributes: { themes: [] } }).kind, 'none');
});

test('activationText is short enough for a tree description', () => {
  const a = (kind: 'always' | 'triggered' | 'none', languages: string[] = [], files: string[] = []) => ({ kind, languages, files, globs: [], events: [] });
  assert.equal(activationText(a('always')), '⚡ always');
  assert.equal(activationText(a('none')), 'no code');
  assert.equal(activationText(a('triggered', ['a', 'b', 'c', 'd'])), 'a, b, c, …');
  assert.equal(activationText(a('triggered', [], ['gradlew'])), 'when gradlew exists');
  assert.equal(activationText(a('triggered')), 'on demand');
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
  assert.equal(one.activation.kind, 'triggered');
  assert.deepEqual(one.activation.languages, ['python']);

  // 매니페스트만 바뀌면 캐시를 그대로 쓴다.
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ ...manifest, displayName: 'Renamed' }));
  assert.equal((await readInstalledExtensions(dir))[0].displayName, 'One');
  // extensions.json이 바뀌면(설치·업데이트·제거) 다시 읽는다.
  fs.writeFileSync(index, JSON.stringify([{ identifier: { id: 'pub.one' }, version: '1.0.1', relativeLocation: 'pub.one-1.0.0' }]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(index, later, later);
  assert.equal((await readInstalledExtensions(dir))[0].displayName, 'Renamed');
});

test('extensionFromManifest separates extensionDependencies from extensionPack', () => {
  const e = extensionFromManifest(
    { name: 'pack', publisher: 'p', extensionDependencies: ['A.Dep'], extensionPack: ['B.Member', 'c.member'] },
    { id: 'p.pack', location: '/x' },
  );
  assert.deepEqual(e.dependencies, ['a.dep']);
  assert.deepEqual(e.packMembers, ['b.member', 'c.member']);
});

test('profileSources: default list, or the profile list plus application-scoped default extensions', () => {
  const ext = path.join('/home/u/.vscode/extensions');
  const user = path.join('/home/u/.config/Code/User');
  assert.deepEqual(profileSources(ext, user), [{ index: path.join(ext, 'extensions.json'), baseDir: ext }]);
  assert.deepEqual(profileSources(ext, user, '-6829'), [
    { index: path.join(user, 'profiles', '-6829', 'extensions.json'), baseDir: ext },
    { index: path.join(ext, 'extensions.json'), baseDir: ext, applicationScopedOnly: true },
  ]);
});

test('pickProfile chooses the list that contains every running extension with the highest share running', () => {
  const candidates = [
    { location: undefined, ids: ['a.a', 'b.b', 'c.c', 'd.d'] },
    { location: 'p1', ids: ['b.b'] },
    { location: 'p2', ids: ['x.x'] },
  ];
  assert.equal(pickProfile(candidates, ['b.b']), 'p1', 'a small profile where all its extensions run');
  assert.equal(pickProfile(candidates, ['a.a', 'b.b', 'c.c']), undefined, 'only the default list contains them all');
  assert.equal(pickProfile([{ location: undefined, ids: ['b.b'] }, { location: 'p1', ids: ['b.b'] }], ['b.b']), undefined, 'a tie keeps the default profile');
  assert.equal(pickProfile(candidates, ['zzz.unknown']), undefined);
});

test('readInstalledExtensions merges a profile list with application-scoped default extensions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-profile-'));
  const ext = path.join(root, 'extensions');
  const mkExt = (folder: string, name: string) => {
    fs.mkdirSync(path.join(ext, folder), { recursive: true });
    fs.writeFileSync(path.join(ext, folder, 'package.json'), JSON.stringify({ name, publisher: 'p', displayName: name }));
  };
  mkExt('p.inprofile-1.0.0', 'inprofile');
  mkExt('p.everywhere-1.0.0', 'everywhere');
  mkExt('p.defaultonly-1.0.0', 'defaultonly');
  fs.writeFileSync(
    path.join(ext, 'extensions.json'),
    JSON.stringify([
      { identifier: { id: 'p.everywhere' }, version: '1.0.0', relativeLocation: 'p.everywhere-1.0.0', metadata: { isApplicationScoped: true } },
      { identifier: { id: 'p.defaultonly' }, version: '1.0.0', relativeLocation: 'p.defaultonly-1.0.0' },
    ]),
  );
  const profile = path.join(root, 'User', 'profiles', 'abc');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'extensions.json'),
    JSON.stringify([{ identifier: { id: 'p.inprofile' }, version: '1.0.0', location: { fsPath: path.join(ext, 'p.inprofile-1.0.0') } }]),
  );
  const list = await readInstalledExtensions(profileSources(ext, path.join(root, 'User'), 'abc'));
  assert.deepEqual(list.map((e) => e.id).sort(), ['p.everywhere', 'p.inprofile']);
});
