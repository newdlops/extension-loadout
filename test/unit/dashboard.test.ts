import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeActivation } from '../../src/catalog';
import { buildDashRows } from '../../src/dashboardModel';

const row = (id: string, extra: object = {}) => ({
  id,
  displayName: id.toUpperCase(),
  publisher: 'p',
  version: '1.0.0',
  location: `/x/${id}`,
  categories: [],
  activation: describeActivation({ main: './a.js', activationEvents: ['onStartupFinished'] }),
  dependencies: [],
  packMembers: [],
  languageDefs: [],
  globallyEnabled: true,
  desiredOn: true,
  running: true,
  active: true,
  locked: false,
  ...extra,
});

test('buildDashRows merges memory, suggestions, learned and repo flags per extension', () => {
  const rows = buildDashRows({
    rows: [row('a.a', { icon: '/x/a.a/icon.png' }), row('b.b', { override: 'off', desiredOn: false }), row('c.c'), row('d.d', { override: 'on' })],
    pending: false,
    memory: [{ id: 'a.a', bytes: 5, pids: [1, 2], commands: [], allWindowsBytes: 9, allWindowsPids: 3 }],
    suggestions: [{ id: 'c.c', reason: 'No rust files' }, { id: 'd.d', reason: 'x' }],
    learned: [{ id: 'c.c', reason: 'similar', folders: ['w'] }, { id: 'a.a', reason: 'similar', folders: ['w'] }],
    recommended: new Set(['b.b']),
    iconUri: (f) => `webview:${f}`,
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['a.a'].icon, 'webview:/x/a.a/icon.png');
  assert.equal(by['a.a'].memory, 5);
  assert.equal(by['a.a'].processes, 2);
  assert.equal(by['a.a'].learned, 'similar');
  assert.equal(by['a.a'].startsAlways, true);
  assert.equal(by['b.b'].here, 'off');
  assert.equal(by['b.b'].recommendedByRepo, true);
  assert.equal(by['b.b'].mismatch, true, 'wanted off but still running');
  assert.equal(by['c.c'].suggestion, 'No rust files');
  assert.equal(by['c.c'].learned, undefined, 'a certain suggestion wins over a learned one');
  assert.equal(by['d.d'].suggestion, undefined, 'turned on here on purpose: no suggestion');
});
