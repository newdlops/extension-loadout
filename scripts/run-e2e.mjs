// 격리된 VS Code(별도 user-data-dir, extensions-dir)에서 Extension Loadout을 처음부터 끝까지 시험한다. macOS·Linux·Windows 공통.
//  0단계: 두 번째 폴더(ws2)를 한 번 열어 VS Code 저장소를 만든다(다른 폴더에 적용하기 시험용).
//  1단계: loadout이 전역 ON 확장을 끄고 전역 OFF 확장을 켠다 → 지금 재시작
//  2단계: 반영 확인, 체크박스로 고른 것 한꺼번에 끄기, 여러 개를 전역 따름으로 → 지금 재시작
//  3단계: 원래대로 돌아왔는지 확인, 하나 끄고 "종료할 때 적용" 예약 → 그냥 종료(하네스가 다시 띄움)
//  4단계: 종료할 때 적용됐는지 확인 → ws2에도 적용하며 재시작
//  5단계: ws2 저장소에 적용됐는지 확인 → 되돌리기
//  6단계: ws2가 원래대로인지 확인 → 한 번 더 되돌리기
//  7단계: 이 폴더 상태와 loadout 파일이 3단계 이전으로 돌아왔는지 확인
// 환경 변수: VSCODE_EXECUTABLE(없으면 macOS는 설치된 앱, 그 밖에는 stable을 내려받음).
// --open(또는 E2E_RELAUNCH=open, macOS 전용): vsix로 설치하고 open -n -a로 폴더 인자 없이 다시 띄워 창 복원까지 확인한다.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
// macOS·Linux는 소켓 경로가 103~107자를 넘으면 VS Code가 뜨지 않으므로 짧은 경로를 쓴다.
const DIR = process.env.E2E_DIR ?? (isMac || isWin ? path.join(ROOT, '.vscode-test', 'e2e') : path.join(os.tmpdir(), 'el-e2e'));
const OPEN_MODE = process.env.E2E_RELAUNCH === 'open' || process.argv.includes('--open');
if (OPEN_MODE && !isMac) throw new Error('E2E_RELAUNCH=open is macOS only');

let CODE = process.env.VSCODE_EXECUTABLE;
if (!CODE && isMac && fs.existsSync('/Applications/Visual Studio Code.app')) CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
if (!CODE) CODE = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(ROOT, '.vscode-test', 'vscode') });
const CLI = resolveCliPathFromVSCodeExecutablePath(CODE);
const APP = isMac ? path.resolve(CODE, '..', '..', '..') : undefined;
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

const ON = 'loadouttest.dummy-on';
const OFF = 'loadouttest.dummy-off';
const RUST = 'loadouttest.dummy-rust';

const ud = path.join(DIR, 'ud');
const exts = path.join(DIR, 'exts');
const ws = path.join(DIR, 'ws');
const ws2 = path.join(DIR, 'ws2');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'User', 'globalStorage'), { recursive: true });
fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
fs.mkdirSync(ws2, { recursive: true });
fs.mkdirSync(exts, { recursive: true });

const cli = (args) => execFileSync(CLI, args, { stdio: 'ignore', shell: isWin });
const pack = (cwd, out, extra = []) => {
  execFileSync(process.execPath, [VSCE, 'package', '--no-dependencies', ...extra, '-o', out], { cwd, stdio: 'ignore' });
  cli(['--user-data-dir', ud, '--extensions-dir', exts, '--install-extension', out]);
};
for (const name of ['dummy-on', 'dummy-off', 'dummy-rust']) {
  pack(path.join(ROOT, 'test', 'fixtures', name), path.join(DIR, `${name}.vsix`), ['--allow-missing-repository', '--skip-license']);
}
if (OPEN_MODE) {
  // 실제 macOS 경로와 같게 확장을 vsix로 설치한다. 개발 모드(--extensionDevelopmentPath) 창은 복원되지 않기 때문이다.
  pack(ROOT, path.join(DIR, 'extension-loadout.vsix'));
  pack(path.join(ROOT, 'test', 'e2e-driver'), path.join(DIR, 'e2e-driver.vsix'), ['--allow-missing-repository', '--skip-license']);
}

// dummy-off는 전역에서 꺼 둔다.
const globalDb = new DatabaseSync(path.join(ud, 'User', 'globalStorage', 'state.vscdb'));
globalDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
globalDb.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('extensionsIdentifiers/disabled', JSON.stringify([{ id: OFF }]));
globalDb.close();

fs.writeFileSync(path.join(ws, '.vscode', 'extension-loadout.json'), JSON.stringify({ enable: [OFF], disable: [ON] }, null, 2));

const base = [
  '--user-data-dir', ud,
  '--extensions-dir', exts,
  ...(OPEN_MODE ? [] : [`--extensionDevelopmentPath=${ROOT}`, `--extensionDevelopmentPath=${path.join(ROOT, 'test', 'e2e-driver')}`]),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  // Linux CI(Ubuntu 24)는 사용자 네임스페이스 제한 때문에 샌드박스 없이 띄워야 한다.
  ...(process.platform === 'linux' ? ['--disable-gpu', '--no-sandbox'] : []),
];
// open으로 띄운 앱은 호출한 쪽의 환경 변수를 물려받지 않으므로 --env로 넘긴다.
const relaunchFile = path.join(DIR, 'relaunch.json');
const relaunch = OPEN_MODE
  ? {
      command: 'open',
      args: ['-n', '-a', APP, '--env', `EXTENSION_LOADOUT_E2E_DIR=${DIR}`, '--env', `EXTENSION_LOADOUT_E2E_WS2=${ws2}`, '--env', `EXTENSION_LOADOUT_RELAUNCH=@${relaunchFile}`, '--args', ...base],
    }
  : { command: CODE, args: [...base, ws] };
fs.writeFileSync(relaunchFile, JSON.stringify(relaunch));
const env = { ...process.env, EXTENSION_LOADOUT_E2E_DIR: DIR, EXTENSION_LOADOUT_E2E_WS2: ws2, EXTENSION_LOADOUT_RELAUNCH: `@${relaunchFile}` };
delete env.ELECTRON_RUN_AS_NODE;
const launch = (folder) => spawn(CODE, [...base, folder], { env, detached: !isWin, stdio: 'ignore' }).unref();

function alive() {
  try {
    if (isWin) {
      const ps = `(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${ud.replace(/'/g, "''")}*' } | Measure-Object).Count`;
      return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]).toString().trim()) > 0;
    }
    return execFileSync('pgrep', ['-f', ud]).toString().trim().length > 0;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitExit(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive()) return true;
    await sleep(1000);
  }
  return false;
}

// 0단계
launch(ws2);
await sleep(3000);
await waitExit(90_000);

launch(ws);
const phaseFile = path.join(DIR, 'phase');
const relaunchFlag = path.join(DIR, 'relaunch-needed');
const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline) {
  await sleep(1000);
  const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : '';
  if (phase === 'done' && !alive()) break;
  if (fs.existsSync(relaunchFlag) && !alive()) {
    fs.rmSync(relaunchFlag, { force: true });
    await sleep(1500); // 종료할 때 적용하는 도우미가 끝나도록
    launch(ws);
  }
}

const lines = fs.existsSync(path.join(DIR, 'driver.jsonl'))
  ? fs.readFileSync(path.join(DIR, 'driver.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : [];
const at = (phase, key) => lines.find((l) => l.phase === phase && key in l)?.[key];
const state = (phase) => lines.find((l) => l.phase === phase && 'on' in l);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const checks = [
  ['0단계: ws2 준비', lines.some((l) => l.ws2 === 'prepared')],
  ['1단계: 시작 상태(전역 ON 실행, 전역 OFF 미실행)', state('1')?.on === true && state('1')?.off === false],
  ['1단계: Rust 전용 확장만 "필요 없음"으로 추천', same(at('1', 'suggestions'), [RUST])],
  ['2단계: loadout 적용 후 ON 확장 꺼짐', state('2')?.on === false],
  ['2단계: loadout 적용 후 전역 OFF 확장 켜짐', state('2')?.off === true],
  ['2단계: 선택한 확장 한꺼번에 끄기', same(at('2', 'configAfterSelectedOff'), { enable: [OFF], disable: [ON, RUST] })],
  ['2단계: 전역 따름으로 되돌린 loadout 파일', same(at('2', 'configAfterFollowGlobal'), { enable: [], disable: [] })],
  ['3단계: 원래 상태로 복귀', state('3')?.on === true && state('3')?.off === false],
  ['3단계: "종료할 때 적용" 예약됨', at('3', 'scheduled') === true],
  ['4단계: VS Code를 끌 때 적용됨', state('4')?.on === false],
  ['5단계: 다른 폴더(ws2)에도 적용됨', same(at('5', 'ws2'), { enabled: null, disabled: [ON] })],
  ['6단계: 되돌리기로 ws2 원상 복구', same(at('6', 'ws2'), { enabled: null, disabled: null }) && state('6')?.on === false],
  ['7단계: 한 번 더 되돌리기로 이 폴더 원상 복구', state('7')?.on === true && same(state('7')?.config, { enable: [], disable: [] })],
  ['오류 없음', !lines.some((l) => l.error)],
  ['격리 VS Code 종료됨', !alive()],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${OPEN_MODE ? '[open] ' : ''}${name}`);
  failed ||= !ok;
}
if (failed) {
  console.log('\n--- driver log');
  for (const l of lines) console.log(JSON.stringify(l));
  const restartLog = path.join(os.tmpdir(), 'extension-loadout-restart.log');
  if (fs.existsSync(restartLog)) console.log('--- restart log\n' + fs.readFileSync(restartLog, 'utf8').split('\n').slice(-12).join('\n'));
  if (alive()) {
    if (isWin) execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${ud}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
    else execFileSync('pkill', ['-f', ud]);
  }
  process.exit(1);
}
