import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dependentsOf, missingDependencies, packMembers, packsContaining } from '../../src/deps';
import { MARKER_GLOB, learnedSuggestions, recordDecision, signatureOf, similarity } from '../../src/learning';
import { mergeRecommendations, parseRecommendations } from '../../src/repoRecs';

test('parseRecommendations reads JSONC extensions.json and the "extensions" key of a .code-workspace', () => {
  const a = parseRecommendations('{ // repo\n "recommendations": ["MS-Python.python", "a.b",], "unwantedRecommendations": ["x.y"] }');
  assert.deepEqual([...a.recommended], ['ms-python.python', 'a.b']);
  assert.deepEqual([...a.unwanted], ['x.y']);
  const w = parseRecommendations('{"folders":[],"extensions":{"recommendations":["c.d"],"unwantedRecommendations":["a.b"]}}', true);
  assert.deepEqual([...w.recommended], ['c.d']);
  const merged = mergeRecommendations([a, w]);
  assert.deepEqual([...merged.unwanted], ['x.y'], 'recommended somewhere beats unwanted elsewhere');
  assert.deepEqual(parseRecommendations('garbage').recommended.size, 0);
});

const rows = [
  { id: 'base.lib', desiredOn: true, dependencies: [], packMembers: [] },
  { id: 'mid.tool', desiredOn: true, dependencies: ['base.lib'], packMembers: [] },
  { id: 'top.app', desiredOn: true, dependencies: ['mid.tool'], packMembers: [] },
  { id: 'off.user', desiredOn: false, dependencies: ['base.lib'], packMembers: [] },
  { id: 'the.pack', desiredOn: true, dependencies: [], packMembers: ['mid.tool', 'p.one', 'not.installed'] },
  { id: 'p.one', desiredOn: false, dependencies: ['dep.off'], packMembers: [] },
  { id: 'dep.off', desiredOn: false, dependencies: [], packMembers: [] },
];

test('dependentsOf finds extensions that would break, transitively, skipping ones already off', () => {
  assert.deepEqual(dependentsOf(rows, ['base.lib']), ['mid.tool', 'top.app']);
  assert.deepEqual(dependentsOf(rows, ['top.app']), []);
});

test('missingDependencies finds what must be turned on too, transitively, installed only', () => {
  assert.deepEqual(missingDependencies(rows, ['p.one']), ['dep.off']);
  assert.deepEqual(missingDependencies(rows, ['top.app']), []);
});

test('packMembers lists pack members in the wrong state; packsContaining finds packs of an extension', () => {
  assert.deepEqual(packMembers(rows, ['the.pack'], false), ['mid.tool']);
  assert.deepEqual(packMembers(rows, ['the.pack'], true), ['p.one']);
  assert.deepEqual(packsContaining(rows, 'p.one'), ['the.pack']);
});

test('signatureOf maps marker files at the top two levels, with wildcards', () => {
  assert.deepEqual(signatureOf(['package.json', 'web/vite.config.ts', 'api/manage.py', 'src/App.csproj', 'README.md']), ['*.csproj', 'manage.py', 'package.json', 'vite.config.*']);
  assert.match(MARKER_GLOB, /^\{package\.json,\*\/package\.json,/);
});

test('similarity is Jaccard and 0 for empty stacks', () => {
  assert.equal(similarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(similarity(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(similarity([], ['a']), 0);
});

test('learned suggestions come from similar other folders and skip what I turned on here', () => {
  const same = (a: string, b: string) => a === b;
  let list = recordDecision([], { folder: '/w/api', name: 'api', signature: ['manage.py', 'package.json'], off: ['rust.ra', 'java.ext'], on: [], time: 1 }, same);
  list = recordDecision(list, { folder: '/w/web', name: 'web', signature: ['manage.py', 'package.json'], off: ['rust.ra'], on: [], time: 2 }, same);
  list = recordDecision(list, { folder: '/w/game', name: 'game', signature: ['Cargo.toml'], off: ['python.ext'], on: [], time: 3 }, same);
  list = recordDecision(list, { folder: '/w/api', name: 'api', signature: ['manage.py', 'package.json'], off: ['rust.ra', 'java.ext'], on: [], time: 4 }, same);
  assert.equal(list.length, 3, 'one entry per folder');
  const here = [
    { id: 'rust.ra', desiredOn: true, locked: false },
    { id: 'java.ext', desiredOn: true, override: 'on' as const, locked: false },
    { id: 'python.ext', desiredOn: true, locked: false },
  ];
  const out = learnedSuggestions(list, ['manage.py', 'package.json'], '/w/new', here, same);
  assert.deepEqual(out.map((x) => [x.id, x.folders]), [['rust.ra', ['api', 'web']]]);
  assert.match(out[0].reason, /2 similar folders: api, web/);
  assert.deepEqual(learnedSuggestions(list, ['manage.py', 'package.json'], '/w/api', here, same).map((x) => x.id), ['rust.ra'], 'the folder itself is not evidence');
});
