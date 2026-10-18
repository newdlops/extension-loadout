import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISABLED_KEY,
  ENABLED_KEY,
  changesBetween,
  changesFromSelection,
  desiredOn,
  editLoadoutText,
  isPending,
  matchesEntry,
  mergeLayers,
  noteFor,
  overridesFromStored,
  parseLoadoutRules,
  parseStoredIdentifiers,
  resolveRules,
  serializeRules,
  storedValuesFor,
} from '../../src/loadout';

const INSTALLED = ['ms-toolsai.jupyter', 'ms-toolsai.jupyter-renderers', 'ms-toolsai.vscode-jupyter-slideshow', 'ms-python.python', 'rust-lang.rust-analyzer'];

test('parseLoadoutRules reads JSONC with comments, trailing commas, patterns, negations and notes', () => {
  const { rules, errors } = parseLoadoutRules(`{
    // folder loadout
    "enable": ["VSCJava.vscode-gradle",],
    "disable": ["ms-toolsai.*", "!ms-toolsai.jupyter"],
    "notes": { "ms-toolsai.*": "no notebooks here" },
  }`);
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.enable, ['vscjava.vscode-gradle']);
  assert.deepEqual(rules.disable, ['ms-toolsai.*', '!ms-toolsai.jupyter']);
  assert.deepEqual(rules.notes, { 'ms-toolsai.*': 'no notebooks here' });
});

test('parseLoadoutRules reports broken input without throwing', () => {
  assert.match(parseLoadoutRules('{').errors[0], /Not valid JSON/);
  assert.match(parseLoadoutRules('[]').errors[0], /JSON object/);
  assert.match(parseLoadoutRules('{"enable":"a.b"}').errors[0], /must be a list/);
  assert.match(parseLoadoutRules('{"disable":["nodot"]}').errors[0], /not an extension ID/);
  assert.match(parseLoadoutRules('{"enable":["a.b"],"disable":["A.b"]}').errors[0], /both "enable" and "disable"/);
  assert.match(parseLoadoutRules('{"notes":[]}').errors[0], /"notes" must be an object/);
});

test('resolveRules: patterns apply to installed ids, negation carves out, exact beats pattern', () => {
  const { rules } = parseLoadoutRules('{"enable":["ms-toolsai.jupyter-renderers"],"disable":["ms-toolsai.*","!ms-toolsai.jupyter"]}');
  const { values, errors, via } = resolveRules(rules, INSTALLED);
  assert.deepEqual(errors, []);
  assert.equal(values.get('ms-toolsai.vscode-jupyter-slideshow'), 'off');
  assert.equal(via.get('ms-toolsai.vscode-jupyter-slideshow'), 'ms-toolsai.*');
  assert.equal(values.get('ms-toolsai.jupyter'), 'clear', 'negated: no folder setting');
  assert.equal(values.get('ms-toolsai.jupyter-renderers'), 'on', 'exact enable beats disable pattern');
  assert.equal(values.has('ms-python.python'), false);
});

test('resolveRules reports two patterns fighting over one extension and skips it', () => {
  const { rules } = parseLoadoutRules('{"enable":["ms-*"],"disable":["*.python"]}');
  const { values, errors } = resolveRules(rules, INSTALLED);
  assert.equal(values.has('ms-python.python'), false);
  assert.match(errors.join('\n'), /ms-python\.python matches both "ms-\*" \(enable\) and "\*\.python" \(disable\)/);
});

test('resolveRules keeps exact ids that are not installed (shown as missing)', () => {
  const { rules } = parseLoadoutRules('{"disable":["gone.ext"]}');
  assert.equal(resolveRules(rules, INSTALLED).values.get('gone.ext'), 'off');
});

test('matchesEntry handles * and ? case-insensitively and nothing else as a wildcard', () => {
  assert.ok(matchesEntry('ms-toolsai.*', 'ms-toolsai.jupyter'));
  assert.ok(matchesEntry('*.python', 'MS-PYTHON.python'));
  assert.ok(matchesEntry('a.b?', 'a.bc'));
  assert.ok(!matchesEntry('a.b', 'aXb'));
  assert.ok(!matchesEntry('ms-toolsai.*', 'ms-python.python'));
});

test('editLoadoutText keeps comments, notes and other keys, and only rewrites the changed list', () => {
  const before = `{
  // keep me
  "enable": ["vscjava.vscode-gradle"],
  "disable": ["ms-toolsai.*"],
  "notes": { "ms-toolsai.*": "no notebooks" },
  "custom": 1
}
`;
  const after = editLoadoutText(before, [{ id: 'rust-lang.rust-analyzer', value: 'off' }]);
  assert.match(after, /\/\/ keep me/);
  assert.match(after, /"notes": \{ "ms-toolsai\.\*": "no notebooks" \}/);
  assert.match(after, /"custom": 1/);
  assert.deepEqual(parseLoadoutRules(after).rules.disable, ['ms-toolsai.*', 'rust-lang.rust-analyzer']);
  assert.deepEqual(parseLoadoutRules(after).rules.enable, ['vscjava.vscode-gradle']);
});

test('editLoadoutText uses patterns: no duplicate when a pattern already covers it, negation to follow global', () => {
  const base = '{"enable":[],"disable":["ms-toolsai.*"]}';
  // 패턴이 이미 끄고 있으면 따로 적지 않는다.
  assert.deepEqual(parseLoadoutRules(editLoadoutText(base, [{ id: 'ms-toolsai.jupyter', value: 'off' }])).rules.disable, ['ms-toolsai.*']);
  // 전역 따름: 패턴에서 뺀다.
  const follow = editLoadoutText(base, [{ id: 'ms-toolsai.jupyter', value: undefined }]);
  assert.deepEqual(parseLoadoutRules(follow).rules.disable, ['ms-toolsai.*', '!ms-toolsai.jupyter']);
  assert.equal(resolveRules(parseLoadoutRules(follow).rules, INSTALLED).values.get('ms-toolsai.jupyter'), 'clear');
  // 다시 끄면 ! 항목이 사라지고 패턴이 다시 덮는다.
  assert.deepEqual(parseLoadoutRules(editLoadoutText(follow, [{ id: 'ms-toolsai.jupyter', value: 'off' }])).rules.disable, ['ms-toolsai.*']);
  // 켜면 정확한 ID로 패턴을 이긴다.
  const on = editLoadoutText(base, [{ id: 'ms-toolsai.jupyter', value: 'on' }]);
  assert.equal(resolveRules(parseLoadoutRules(on).rules, INSTALLED).values.get('ms-toolsai.jupyter'), 'on');
});

test('editLoadoutText starts from an empty file and refuses to edit broken JSON', () => {
  assert.deepEqual(parseLoadoutRules(editLoadoutText(undefined, [{ id: 'A.B', value: 'on' }])).rules, { enable: ['a.b'], disable: [], notes: {} });
  assert.throws(() => editLoadoutText('{ nope', [{ id: 'a.b', value: 'on' }]), /Fix the loadout file first/);
});

test('editLoadoutText clears an inherited multi-root setting with a negation', () => {
  const text = editLoadoutText(undefined, [{ id: 'x.y', value: undefined }], new Map([['x.y', 'off']]));
  assert.deepEqual(parseLoadoutRules(text).rules.disable, ['!x.y']);
});

test('mergeLayers: folder files merge with "on wins", the editable file overrides them', () => {
  const a = new Map([['x.y', 'off' as const], ['p.q', 'off' as const]]);
  const b = new Map([['x.y', 'on' as const]]);
  const editable = new Map([['p.q', 'clear' as const], ['r.s', 'on' as const]]);
  const { overrides, conflicts, inherited } = mergeLayers(
    [
      { name: 'api', values: a },
      { name: 'web', values: b },
    ],
    editable,
  );
  assert.deepEqual(Object.fromEntries(overrides), { 'x.y': 'on', 'r.s': 'on' });
  assert.match(conflicts[0], /x\.y is turned on in web but off in api/);
  assert.deepEqual(inherited.get('p.q'), { value: 'off', from: ['api'] });
});

test('serializeRules writes notes only when present', () => {
  assert.equal(serializeRules({ enable: ['a.b'], disable: [], notes: {} }), '{\n  "enable": [\n    "a.b"\n  ],\n  "disable": []\n}\n');
  assert.match(serializeRules({ enable: [], disable: ['a.*'], notes: { 'a.*': 'why' } }), /"notes"/);
});

test('noteFor prefers the exact id, then a matching pattern', () => {
  const notes = { 'ms-toolsai.*': 'pattern note', 'ms-toolsai.jupyter': 'exact note' };
  assert.equal(noteFor(notes, 'ms-toolsai.jupyter'), 'exact note');
  assert.equal(noteFor(notes, 'ms-toolsai.jupyter-renderers'), 'pattern note');
  assert.equal(noteFor(notes, 'other.ext'), undefined);
});

test('storedValuesFor writes VS Code identifiers with uuids and deletes empty keys', () => {
  const values = storedValuesFor(new Map([['vscjava.vscode-gradle', 'on']]), (id) =>
    id === 'vscjava.vscode-gradle' ? 'a226f06e-9b5e-493b-b92a-553d3572f969' : undefined,
  );
  assert.equal(values[ENABLED_KEY], '[{"id":"vscjava.vscode-gradle","uuid":"a226f06e-9b5e-493b-b92a-553d3572f969"}]');
  assert.equal(values[DISABLED_KEY], null);
});

test('isPending ignores order, case and uuid but sees any state change', () => {
  const enabled = parseStoredIdentifiers('[{"id":"A.a","uuid":"x"}]');
  const disabled = parseStoredIdentifiers('[{"id":"b.b"}]');
  assert.equal(isPending(new Map([['a.a', 'on'], ['b.b', 'off']]), enabled, disabled), false);
  assert.equal(isPending(new Map([['a.a', 'on']]), enabled, disabled), true);
  assert.equal(isPending(new Map([['a.a', 'off'], ['b.b', 'off']]), enabled, disabled), true);
});

test('parseStoredIdentifiers tolerates garbage', () => {
  assert.deepEqual(parseStoredIdentifiers(undefined), []);
  assert.deepEqual(parseStoredIdentifiers(null), []);
  assert.deepEqual(parseStoredIdentifiers('not json'), []);
  assert.deepEqual(parseStoredIdentifiers('[{"id":"a.a"},3,{"x":1}]'), [{ id: 'a.a' }]);
});

test('overridesFromStored lets disabled win over enabled', () => {
  assert.deepEqual(overridesFromStored([{ id: 'a.a' }], [{ id: 'a.a' }]), new Map([['a.a', 'off']]));
});

test('desiredOn falls back to the global setting', () => {
  const o = new Map([['a.a', 'off']] as const);
  assert.equal(desiredOn('A.a', new Map(o), true), false);
  assert.equal(desiredOn('b.b', new Map(o), true), true);
  assert.equal(desiredOn('b.b', new Map(o), false), false);
});

test('changesFromSelection records only choices that differ from global, and only real changes', () => {
  const candidates = [
    { id: 'on.global', globallyEnabled: true },
    { id: 'off.global', globallyEnabled: false },
    { id: 'kept.on', globallyEnabled: true },
    { id: 'same.off', globallyEnabled: true },
  ];
  const current = new Map([['kept.on', 'off'], ['same.off', 'off']] as const);
  const changes = changesFromSelection(candidates, new Set(['off.global', 'kept.on']), new Map(current));
  assert.deepEqual(changes, [
    { id: 'on.global', value: 'off' },
    { id: 'off.global', value: 'on' },
    { id: 'kept.on', value: undefined },
  ]);
});

test('changesBetween turns one override map into another', () => {
  const changes = changesBetween(new Map([['a.a', 'on'], ['b.b', 'off']] as const), new Map([['b.b', 'on'], ['c.c', 'off']] as const));
  assert.deepEqual(changes, [
    { id: 'a.a', value: undefined },
    { id: 'b.b', value: 'on' },
    { id: 'c.c', value: 'off' },
  ]);
});
