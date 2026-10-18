import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levelFromCompressed, levelFromDarwin, levelFromFree, levelFromPsi, levelFromSwapRate, maxLevel, NOTIFY_COOLDOWN_MS, parseCompressed, parseMeminfoSwap, parseSwapUsage, rank, readPressure, shouldNotify, swapRate } from '../../src/pressure';
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

test('swap filling up: per-minute growth, not the share of a swap file that macOS grows on demand', () => {
  const MB = 1024 ** 2;
  // 1분 사이 300MB 늘면 경고, 100MB면 정상, 줄어들면 정상.
  assert.equal(swapRate({ at: 0, used: 1000 * MB }, 1300 * MB, 60_000), 300 * MB);
  assert.equal(levelFromSwapRate(swapRate({ at: 0, used: 1000 * MB }, 1300 * MB, 60_000)), 'warn');
  assert.equal(levelFromSwapRate(swapRate({ at: 0, used: 1000 * MB }, 1100 * MB, 60_000)), 'normal');
  assert.equal(levelFromSwapRate(swapRate({ at: 0, used: 2000 * MB }, 1000 * MB, 60_000)), 'normal');
  // 30초에 150MB = 분당 300MB.
  assert.equal(levelFromSwapRate(swapRate({ at: 0, used: 0 }, 150 * MB, 30_000)), 'warn');
  // 처음 잴 때, 너무 짧거나(20초 미만) 너무 긴(10분 초과) 간격은 판단하지 않는다.
  assert.equal(swapRate(undefined, 5000 * MB, 60_000), undefined);
  assert.equal(swapRate({ at: 0, used: 0 }, 5000 * MB, 5_000), undefined);
  assert.equal(swapRate({ at: 0, used: 0 }, 5000 * MB, 11 * 60_000), undefined);
  assert.equal(levelFromSwapRate(undefined), 'normal');
  // 스왑 "사용률"이 높아도 늘지 않으면 경고가 아니다(macOS 스왑 파일은 필요한 만큼만 커진다).
  assert.equal(levelFromSwapRate(swapRate({ at: 0, used: 8900 * MB }, 8910 * MB, 60_000)), 'normal');
});

test('compressed memory: a warning once it holds 40% of physical memory', () => {
  const GB = 1024 ** 3;
  // 이 Mac에서 잰 값: 48GB 중 압축 메모리가 19.5GB(40%).
  const vmStat = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages stored in compressor:             3105454.\nPages occupied by compressor:           1278006.\n';
  assert.equal(parseCompressed(vmStat, 16384), 1278006 * 16384);
  assert.equal(levelFromCompressed(1278006 * 16384, 48 * GB), 'warn');
  assert.equal(levelFromCompressed(4 * GB, 48 * GB), 'normal');
  // 16GB Mac에서 흔한 20~30%는 경고가 아니다.
  assert.equal(levelFromCompressed(5 * GB, 16 * GB), 'normal');
  assert.equal(levelFromCompressed(6.5 * GB, 16 * GB), 'warn');
  assert.equal(levelFromCompressed(5 * GB, 0), 'normal');
  assert.equal(parseCompressed('nothing here', 16384), undefined);
  // 경고까지만 보탠다. 위험(critical)은 커널·PSI 판정만.
  assert.equal(maxLevel('normal', 'warn', 'normal'), 'warn');
  assert.equal(maxLevel('critical', 'warn'), 'critical');
  assert.equal(maxLevel(), 'normal');
});

test('parseMeminfoSwap reads Linux swap, none when there is no swap', () => {
  const text = 'MemTotal:       16303428 kB\nSwapCached:            0 kB\nSwapTotal:       2097148 kB\nSwapFree:         1048574 kB\n';
  assert.deepEqual(parseMeminfoSwap(text), { used: (2097148 - 1048574) * 1024, total: 2097148 * 1024 });
  assert.equal(parseMeminfoSwap('SwapTotal:             0 kB\nSwapFree:              0 kB\n'), undefined);
  assert.equal(parseMeminfoSwap(''), undefined);
});

test('readPressure on this machine: a level, and a swap rate on the second reading', async () => {
  const first = await readPressure(process.platform, 1_000_000);
  assert.ok(['normal', 'warn', 'critical'].includes(first.level));
  const second = await readPressure(process.platform, 1_000_000 + 60_000);
  if (second.swapUsed !== undefined) assert.equal(typeof second.swapRate, 'number');
  if (process.platform === 'darwin') assert.ok((second.compressed ?? -1) >= 0 && (second.physical ?? 0) > 0);
});

test('pressure notification: once per level per window, and not again within an hour across windows and restarts', () => {
  const now = 10 * NOTIFY_COOLDOWN_MS;
  // 처음: 알린다.
  assert.equal(shouldNotify('warn', 'normal', undefined, now), true);
  // 이 창에서 이미 알린 수준이면 다시 알리지 않는다.
  assert.equal(shouldNotify('warn', 'warn', undefined, now), false);
  assert.equal(shouldNotify('normal', 'normal', undefined, now), false);
  // 재시작한 새 창: 30분 전에 다른 창에서 같은 수준을 알렸으면 건너뛴다. 1시간이 지나면 다시 알린다.
  assert.equal(shouldNotify('warn', 'normal', { level: 'warn', at: now - NOTIFY_COOLDOWN_MS / 2 }, now), false);
  assert.equal(shouldNotify('warn', 'normal', { level: 'warn', at: now - NOTIFY_COOLDOWN_MS }, now), true);
  // 더 높은 수준(위험)은 최근에 경고를 알렸어도 바로 알린다.
  assert.equal(shouldNotify('critical', 'warn', { level: 'warn', at: now - 1000 }, now), true);
  assert.equal(shouldNotify('warn', 'normal', { level: 'critical', at: now - 1000 }, now), false);
});
