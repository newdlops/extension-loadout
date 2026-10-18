// 멀티 루트 작업 영역과 VS Code 프로필 시험. macOS·Linux·Windows 공통.
//  - 멀티 루트: 두 폴더의 loadout이 합쳐지고(켜는 쪽 우선, 충돌 보고), 고친 값은 .code-workspace 옆 <이름>.loadout.json에 저장된다.
//  - 프로필: 기본이 아닌 프로필로 띄우면 그 프로필에 설치된 확장만 목록에 나온다.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const DIR = process.env.E2E_DIR ?? (isMac || isWin ? path.join(ROOT, '.vscode-test', 'e2x') : path.join(os.tmpdir(), 'el-e2x'));

let CODE = process.env.VSCODE_EXECUTABLE;
if (!CODE && isMac && fs.existsSync('/Applications/Visual Studio Code.app')) CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
if (!CODE) {
  const cachePath = path.join(ROOT, '.vscode-test', 'vscode');
  fs.mkdirSync(cachePath, { recursive: true });
  CODE = await downloadAndUnzipVSCode({ version: 'stable', cachePath });
}
if (isMac && !fs.existsSync(CODE) && fs.existsSync(path.join(path.dirname(CODE), 'Code'))) CODE = path.join(path.dirname(CODE), 'Code');
const CLI = resolveCliPathFromVSCodeExecutablePath(CODE);
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');
const ON = 'loadouttest.dummy-on';
const RUST = 'loadouttest.dummy-rust';

const ud = path.join(DIR, 'ud');
const exts = path.join(DIR, 'exts');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(exts, { recursive: true });
const cli = (args) => execFileSync(CLI, args, { stdio: 'ignore', shell: isWin });
for (const name of ['dummy-on', 'dummy-rust']) {
  const vsix = path.join(DIR, `${name}.vsix`);
  execFileSync(process.execPath, [VSCE, 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', vsix], { cwd: path.join(ROOT, 'test', 'fixtures', name), stdio: 'ignore' });
}
// 기본 프로필에는 dummy-on만. dummy-rust는 아래에서 프로필에만 설치한다(실제 프로필 전용 확장처럼).
cli(['--user-data-dir', ud, '--extensions-dir', exts, '--install-extension', path.join(DIR, 'dummy-on.vsix')]);

// 멀티 루트: api는 dummy-on을 끄고, web은 켠다(충돌 → 켬). 작업 영역 파일은 mr.code-workspace.
for (const [name, rules] of [['api', { disable: [ON] }], ['web', { enable: [ON] }]]) {
  fs.mkdirSync(path.join(DIR, name, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(DIR, name, '.vscode', 'extension-loadout.json'), JSON.stringify(rules));
}
const wsFile = path.join(DIR, 'mr.code-workspace');
fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: 'api' }, { path: 'web' }] }));

const base = ['--user-data-dir', ud, '--extensions-dir', exts, `--extensionDevelopmentPath=${ROOT}`, `--extensionDevelopmentPath=${path.join(ROOT, 'test', 'e2e-driver')}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', ...(process.platform === 'linux' ? ['--disable-gpu', '--no-sandbox'] : [])];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runMode(mode, extra) {
  const child = spawn(CODE, [...base, ...extra], { env: { ...process.env, EXTENSION_LOADOUT_E2E_DIR: DIR, EXTENSION_LOADOUT_E2E_MODE: mode }, stdio: 'ignore' });
  const until = Date.now() + 120_000;
  while (!fs.existsSync(path.join(DIR, `${mode}-done`)) && Date.now() < until) await sleep(500);
  await Promise.race([new Promise((r) => child.on('exit', r)), sleep(20_000)]);
  if (child.exitCode === null) child.kill();
}
await runMode('multiroot', [wsFile]);
// 프로필: 한 번 띄워 e2e-profile을 만들고, 그 프로필에는 dummy-rust만 설치한 뒤 다시 띄운다.
fs.mkdirSync(path.join(DIR, 'plain'), { recursive: true });
await runMode('noop', ['--profile', 'e2e-profile', path.join(DIR, 'plain')]);
cli(['--user-data-dir', ud, '--extensions-dir', exts, '--profile', 'e2e-profile', '--install-extension', path.join(DIR, 'dummy-rust.vsix')]);
await runMode('profile', ['--profile', 'e2e-profile', path.join(DIR, 'plain')]);

const lines = fs.existsSync(path.join(DIR, 'driver.jsonl')) ? fs.readFileSync(path.join(DIR, 'driver.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const get = (mode, key) => lines.find((l) => l.mode === mode && key in l)?.[key];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const editable = path.join(DIR, 'mr.loadout.json');
const checks = [
  ['멀티 루트: 폴더 loadout을 합치고 부딪히면 켜는 쪽', same(get('multiroot', 'overrides'), { [ON]: 'on' })],
  ['멀티 루트: 충돌을 알림', (get('multiroot', 'conflicts') ?? []).some((c) => c.includes(ON) && c.includes('web') && c.includes('api'))],
  ['멀티 루트: 고치는 파일은 .code-workspace 옆 mr.loadout.json', get('multiroot', 'location')?.editable?.toLowerCase() === editable.toLowerCase()],
  ['멀티 루트: 패널에서 끈 값이 mr.loadout.json에 저장됨', same(get('multiroot', 'afterEdit')?.disable, [RUST])],
  ['멀티 루트: 합친 결과에 반영', same(get('multiroot', 'stateAfterEdit'), { [ON]: 'on', [RUST]: 'off' })],
  ['프로필: 기본 프로필 창은 기본 프로필의 확장만', same(get('multiroot', 'installed'), [ON])],
  ['프로필: 그 프로필에 설치된 확장만 목록에', same(get('profile', 'installed'), [RUST])],
  ['오류 없음', !lines.some((l) => l.error)],
];
// 시험이 남긴 프로세스(VS Code가 끝난 뒤에도 남는 크래시 보고 도우미 등)를 정리한다. 시험용 user-data-dir를 쥔 것만 대상이다.
try {
  if (isWin) execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${ud.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  else execFileSync('pkill', ['-f', ud]);
} catch {
  // 남은 것이 없다.
}

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  failed ||= !ok;
}
if (failed) {
  for (const l of lines) console.log(JSON.stringify(l));
  process.exit(1);
}
