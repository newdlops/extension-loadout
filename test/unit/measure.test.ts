import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levelFromDarwin, levelFromFree, levelFromPsi, parseSwapUsage, rank } from '../../src/pressure';
import {
  attribute,
  descendantsOf,
  formatBytes,
  parseProcStatus,
  parsePs,
  parseSize,
  parseTopMem,
  parseWindowsProcs,
  summarize,
} from '../../src/processes';

const EXT = '/Users/u/.vscode/extensions';
const procs = parsePs(
  [
    '  100     1   9000 /Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '  200   100  50000 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility',
    '  300   100  50000 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility',
    `  210   200  70000 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) ${EXT}/ms-python.vscode-pylance-2026.1.1/dist/server.bundle.js --node-ipc`,
    `  211   210  20000 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) ${EXT}/ms-python.vscode-pylance-2026.1.1/dist/worker.js`,
    '  212   210  10000 /usr/bin/java -jar server.jar',
    '  220   200  30000 /Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/tsserver.js --serverMode semantic',
    '  230   200   5000 /bin/zsh -l',
    `  310   300  60000 /Applications/Code Helper (Plugin) ${EXT}/MS-PYTHON.VSCODE-PYLANCE-2026.1.1/dist/server.bundle.js`,
    '  999     1   1000 /usr/sbin/unrelated',
  ].join('\n'),
);
const exts = [
  { id: 'ms-python.vscode-pylance', location: `${EXT}/ms-python.vscode-pylance-2026.1.1` },
  { id: 'ms-python.python', location: `${EXT}/ms-python.python-2026.1.0` },
  { id: 'vscode.typescript-language-features', location: '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-language-features' },
];

test('parsePs reads pid, ppid, rss (KB → bytes) and full command lines', () => {
  assert.deepEqual(procs[3], { pid: 210, ppid: 200, bytes: 70000 * 1024, command: procs[3].command });
  assert.match(procs[3].command, /server\.bundle\.js --node-ipc$/);
});

test('descendantsOf stays inside the given roots', () => {
  assert.deepEqual([...descendantsOf(procs, [200]).keys()].sort(), [210, 211, 212, 220, 230]);
  assert.equal(descendantsOf(procs, [100]).has(999), false);
});

test('attribute: by extension path, nearest attributed ancestor, tsserver special case, case-insensitive on macOS', () => {
  const win = attribute(procs, [200], exts, 'darwin');
  assert.deepEqual(win.get('ms-python.vscode-pylance')?.sort(), [210, 211, 212], 'the JVM started by the server counts for Pylance');
  assert.deepEqual(win.get('vscode.typescript-language-features'), [220]);
  assert.equal([...win.values()].flat().includes(230), false, 'a terminal shell belongs to no extension');
  const all = attribute(procs, [100], exts, 'darwin');
  assert.deepEqual(all.get('ms-python.vscode-pylance')?.sort(), [210, 211, 212, 310]);
  assert.equal(attribute(procs, [100], exts, 'linux').get('ms-python.vscode-pylance')?.includes(310), false, 'Linux paths are case-sensitive');
});

test('summarize sums this window and all windows, biggest first', () => {
  const sizes = new Map([
    [210, 500 * 1024 ** 2],
    [211, 100 * 1024 ** 2],
    [212, 300 * 1024 ** 2],
    [220, 200 * 1024 ** 2],
    [310, 700 * 1024 ** 2],
  ]);
  const list = summarize(attribute(procs, [200], exts, 'darwin'), attribute(procs, [100], exts, 'darwin'), sizes, new Map(procs.map((p) => [p.pid, p])));
  assert.deepEqual(
    list.map((m) => [m.id, m.bytes / 1024 ** 2, m.allWindowsBytes / 1024 ** 2, m.allWindowsPids]),
    [
      ['ms-python.vscode-pylance', 900, 1600, 4],
      ['vscode.typescript-language-features', 200, 200, 1],
    ],
  );
});

test('parseTopMem and parseSize understand top MEM values', () => {
  const text = 'Processes: 3 total\nPID    MEM\n58703  502M+\n58693  478M-\n58503  1.5G\n11     900K\n12     0B\n';
  const m = parseTopMem(text);
  assert.equal(m.get(58703), 502 * 1024 ** 2);
  assert.equal(m.get(58503), Math.round(1.5 * 1024 ** 3));
  assert.equal(m.get(11), 900 * 1024);
  assert.equal(m.get(12), 0);
  assert.equal(parseSize('n/a'), undefined);
});

test('parseProcStatus adds swap to RSS on Linux', () => {
  assert.equal(parseProcStatus('Name:\tnode\nVmRSS:\t  1000 kB\nVmSwap:\t   500 kB\n'), 1500 * 1024);
  assert.equal(parseProcStatus('Name:\tnode\n'), undefined);
});

test('parseWindowsProcs reads PowerShell JSON, single object or array', () => {
  assert.deepEqual(parseWindowsProcs('{"ProcessId":5,"ParentProcessId":1,"PrivatePageCount":4096,"CommandLine":null}'), [{ pid: 5, ppid: 1, bytes: 4096, command: '' }]);
  assert.equal(parseWindowsProcs('[{"ProcessId":5,"ParentProcessId":1,"PrivatePageCount":1,"CommandLine":"a"},{"ProcessId":6}]').length, 2);
});

test('formatBytes', () => {
  assert.equal(formatBytes(1.94 * 1024 ** 3), '1.9 GB');
  assert.equal(formatBytes(495 * 1024 ** 2), '495 MB');
  assert.equal(formatBytes(10), '1 KB');
});

test('pressure levels: macOS kernel level, Linux PSI, free-memory fallback', () => {
  assert.equal(levelFromDarwin(1), 'normal');
  assert.equal(levelFromDarwin(2), 'warn');
  assert.equal(levelFromDarwin(4), 'critical');
  assert.equal(levelFromPsi('some avg10=2.00 avg60=1 avg300=1 total=1\nfull avg10=0.00 avg60=0 avg300=0 total=0\n'), 'normal');
  assert.equal(levelFromPsi('some avg10=15.00 avg60=1 avg300=1 total=1\nfull avg10=1.00 avg60=0 avg300=0 total=0\n'), 'warn');
  assert.equal(levelFromPsi('some avg10=15.00 avg60=1 avg300=1 total=1\nfull avg10=12.00 avg60=0 avg300=0 total=0\n'), 'critical');
  assert.equal(levelFromPsi('nonsense'), undefined);
  assert.equal(levelFromFree(9, 100), 'warn');
  assert.equal(levelFromFree(4, 100), 'critical');
  assert.equal(levelFromFree(50, 100), 'normal');
  assert.ok(rank('critical') > rank('warn') && rank('warn') > rank('normal'));
});

test('parseSwapUsage reads sysctl vm.swapusage', () => {
  assert.deepEqual(parseSwapUsage('total = 9216.00M  used = 8191.94M  free = 1024.06M  (encrypted)'), {
    total: 9216 * 1024 ** 2,
    used: 8191.94 * 1024 ** 2,
  });
  assert.equal(parseSwapUsage(''), undefined);
});
