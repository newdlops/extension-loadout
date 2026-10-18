import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeActivation, languageDefsOf } from '../../src/catalog';
import { SuggestInput, combineGlobs, evaluateSuggestions, fileListMatcher, globToRegExp, languageGlobs, planSuggestions, reasonFor } from '../../src/recommend';

const langs = languageGlobs([
  ...languageDefsOf({ contributes: { languages: [{ id: 'rust', extensions: ['.rs'] }, { id: 'python', extensions: ['.py', '.pyi'], filenames: ['SConstruct'] }] } }),
  ...languageDefsOf({ contributes: { languages: [{ id: 'json', extensions: ['.json'] }, { id: 'kotlin', extensions: ['.kt', '.kts'] }] } }),
]);

const ext = (id: string, manifest: Record<string, unknown>, extra: Partial<SuggestInput> = {}): SuggestInput => ({
  id,
  displayName: id,
  activation: describeActivation({ main: './x.js', ...manifest }),
  dependencies: [],
  desiredOn: true,
  locked: false,
  ...extra,
});

test('planSuggestions keeps only extensions that start for checkable, specific triggers', () => {
  const rows = [
    ext('rust.ra', { activationEvents: ['onLanguage:rust', 'workspaceContains:Cargo.toml', 'onCommand:ra.x'] }),
    ext('always.on', { activationEvents: ['onStartupFinished', 'onLanguage:rust'] }),
    ext('generic.json', { activationEvents: ['onLanguage:json', 'onLanguage:rust'] }),
    ext('uri.handler', { activationEvents: ['onLanguage:rust', 'onUri'] }),
    ext('unknown.lang', { activationEvents: ['onLanguage:cobol'] }),
    ext('commands.only', { activationEvents: ['onCommand:x'] }),
    ext('theme.only', { main: undefined, contributes: { themes: [] } }),
    ext('already.off', { activationEvents: ['onLanguage:rust'] }, { desiredOn: false }),
    ext('self', { activationEvents: ['onLanguage:rust'] }, { locked: true }),
    ext('lib.kotlin', { activationEvents: ['onLanguage:kotlin'] }),
    ext('needs.lib', { activationEvents: ['onStartupFinished'] }, { dependencies: ['lib.kotlin'] }),
  ];
  assert.deepEqual(
    planSuggestions(rows, langs).map((c) => c.id),
    ['rust.ra'],
  );
  const [ra] = planSuggestions(rows, langs);
  assert.deepEqual(ra.checks, [
    { what: 'rust files (*.rs)', globs: ['**/*.rs'] },
    { what: 'Cargo.toml', globs: ['Cargo.toml'] },
  ]);
});

test('evaluateSuggestions suggests only when every trigger is absent, and checks each glob once', async () => {
  const candidates = [
    { id: 'a', checks: [{ what: 'rust files (*.rs)', globs: ['**/*.rs'] }, { what: 'Cargo.toml', globs: ['Cargo.toml'] }] },
    { id: 'b', checks: [{ what: 'python files (*.py)', globs: ['{**/*.py,**/*.pyi}'] }] },
    { id: 'c', checks: [{ what: 'rust files (*.rs)', globs: ['**/*.rs'] }] },
  ];
  const asked: string[] = [];
  const present = new Set(['{**/*.py,**/*.pyi}']);
  const list = await evaluateSuggestions(candidates, async (g) => (asked.push(g), present.has(g)));
  assert.deepEqual(list, [
    { id: 'a', reason: 'No rust files (*.rs), Cargo.toml in this folder' },
    { id: 'c', reason: 'No rust files (*.rs) in this folder' },
  ]);
  assert.equal(asked.filter((g) => g === '**/*.rs').length, 1);
});

test('reasonFor merges duplicate patterns and caps at three', () => {
  const r = reasonFor(['*/build.gradle', 'build.gradle', '**/pom.xml', 'settings.gradle', 'x.y'].map((w) => ({ what: w, globs: [w] })));
  assert.equal(r, 'No build.gradle, pom.xml, settings.gradle, … in this folder');
});

test('globToRegExp follows VS Code glob rules', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  assert.ok(m('**/*.rs', 'main.rs'));
  assert.ok(m('**/*.rs', 'src/deep/lib.rs'));
  assert.ok(!m('**/*.rs', 'src/lib.rsx'));
  assert.ok(m('Cargo.toml', 'Cargo.toml'));
  assert.ok(!m('Cargo.toml', 'crates/a/Cargo.toml'), 'a bare name only matches at the root');
  assert.ok(m('*/build.gradle', 'app/build.gradle'));
  assert.ok(!m('*/build.gradle', 'a/b/build.gradle'));
  assert.ok(m('.github/workflows/**', '.github/workflows/ci.yml'));
  assert.ok(m('{**/*.py,**/*.pyi}', 'pkg/stub.pyi'));
  assert.ok(m('**/*.{kt,kts}', 'build.gradle.kts'));
  assert.ok(m('**/GRADLEW', 'android/gradlew'), 'case-insensitive: finding too much is the safe side');
  assert.ok(!m('a.b', 'aXb'), 'dots are literal');
});

test('combineGlobs merges simple globs into one search and keeps braced ones separate', () => {
  assert.deepEqual(combineGlobs(['**/*.py', '**/*.pyi', '**/*.{a,b}']), ['{**/*.py,**/*.pyi}', '**/*.{a,b}']);
  assert.deepEqual(combineGlobs(['**/*.rs']), ['**/*.rs']);
});

test('fileListMatcher uses the listing and only falls back when it was truncated', async () => {
  const asked: string[] = [];
  const fallback = async (g: string) => (asked.push(g), true);
  const full = fileListMatcher(['src/main.py', 'README.md'], false, fallback);
  assert.equal(await full('**/*.py'), true);
  assert.equal(await full('**/*.rs'), false);
  const cut = fileListMatcher(['src/main.py'], true, fallback);
  assert.equal(await cut('**/*.py'), true);
  assert.equal(await cut('**/*.rs'), true);
  assert.deepEqual(asked, ['**/*.rs']);
});
