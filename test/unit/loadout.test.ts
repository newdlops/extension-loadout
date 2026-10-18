import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISABLED_KEY,
  ENABLED_KEY,
  desiredOn,
  isPending,
  overridesFromSelection,
  overridesFromStored,
  parseLoadout,
  parseStoredIdentifiers,
  serializeLoadout,
  storedValuesFor,
} from '../../src/loadout';

test('parseLoadout reads enable/disable lists case-insensitively', () => {
  const { overrides, errors } = parseLoadout('{"enable":["VSCJava.vscode-gradle"],"disable":["ms-python.python"]}');
  assert.deepEqual(errors, []);
  assert.deepEqual([...overrides], [['vscjava.vscode-gradle', 'on'], ['ms-python.python', 'off']]);
});

test('parseLoadout reports broken input without throwing', () => {
  assert.match(parseLoadout('{').errors[0], /Not valid JSON/);
  assert.match(parseLoadout('[]').errors[0], /JSON object/);
  assert.match(parseLoadout('{"enable":"a.b"}').errors[0], /must be a list/);
  assert.match(parseLoadout('{"disable":["nodot"]}').errors[0], /not an extension ID/);
  assert.match(parseLoadout('{"enable":["a.b"],"disable":["A.b"]}').errors[0], /both "enable" and "disable"/);
});

test('serializeLoadout sorts and round-trips', () => {
  const text = serializeLoadout(new Map([['z.z', 'off'], ['b.b', 'on'], ['a.a', 'on']]));
  assert.equal(text, '{\n  "enable": [\n    "a.a",\n    "b.b"\n  ],\n  "disable": [\n    "z.z"\n  ]\n}\n');
  assert.deepEqual(parseLoadout(text).overrides, new Map([['a.a', 'on'], ['b.b', 'on'], ['z.z', 'off']]));
});

test('storedValuesFor writes VS Code identifiers with uuids and deletes empty keys', () => {
  const values = storedValuesFor(new Map([['vscjava.vscode-gradle', 'on']]), (id) =>
    id === 'vscjava.vscode-gradle' ? 'a226f06e-9b5e-493b-b92a-553d3572f969' : undefined,
  );
  assert.equal(values[ENABLED_KEY], '[{"id":"vscjava.vscode-gradle","uuid":"a226f06e-9b5e-493b-b92a-553d3572f969"}]');
  assert.equal(values[DISABLED_KEY], null);
});

test('isPending ignores order, case and uuid but sees any state change', () => {
  const overrides = new Map([['a.a', 'on'], ['b.b', 'off']] as const);
  const enabled = parseStoredIdentifiers('[{"id":"A.a","uuid":"x"}]');
  const disabled = parseStoredIdentifiers('[{"id":"b.b"}]');
  assert.equal(isPending(new Map(overrides), enabled, disabled), false);
  assert.equal(isPending(new Map([['a.a', 'on']]), enabled, disabled), true);
  assert.equal(isPending(new Map([['a.a', 'off'], ['b.b', 'off']]), enabled, disabled), true);
});

test('parseStoredIdentifiers tolerates garbage', () => {
  assert.deepEqual(parseStoredIdentifiers(undefined), []);
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

test('overridesFromSelection only records choices that differ from global', () => {
  const candidates = [
    { id: 'on.global', globallyEnabled: true },
    { id: 'off.global', globallyEnabled: false },
    { id: 'kept.on', globallyEnabled: true },
  ];
  // 이전에 "끔"이었던 kept.on을 다시 체크하면 전역 따름으로 돌아가고, 후보에 없는 gone.ext는 그대로 남는다.
  const previous = new Map([['kept.on', 'off'], ['gone.ext', 'on']] as const);
  const next = overridesFromSelection(candidates, new Set(['off.global', 'kept.on']), new Map(previous));
  assert.deepEqual(next, new Map([['gone.ext', 'on'], ['on.global', 'off'], ['off.global', 'on']]));
});
