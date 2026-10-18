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
if (!CODE) {
  // test-electron은 캐시 폴더의 상위 폴더가 없으면 만들지 못한다.
  const cachePath = path.join(ROOT, '.vscode-test', 'vscode');
  fs.mkdirSync(cachePath, { recursive: true });
  CODE = await downloadAndUnzipVSCode({ version: 'stable', cachePath });
}
// 최신 macOS VS Code는 실행 파일 이름이 Electron이 아니라 Code다(test-electron은 아직 Electron을 돌려준다).
if (isMac && !fs.existsSync(CODE) && fs.existsSync(path.join(path.dirname(CODE), 'Code'))) CODE = path.join(path.dirname(CODE), 'Code');
const CLI = resolveCliPathFromVSCodeExecutablePath(CODE);
const APP = isMac ? path.resolve(CODE, '..', '..', '..') : undefined;
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

const ON = 'loadouttest.dummy-on';
const OFF = 'loadouttest.dummy-off';
const RUST = 'loadouttest.dummy-rust';
const HEAVY = 'loadouttest.dummy-heavy';
const UNWANTED = 'loadouttest.dummy-unwanted';
const BASE = 'loadouttest.dummy-base';
const DEP = 'loadouttest.dummy-dep';

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
// dummy-dep은 dummy-base가 필요하므로 base를 먼저 설치한다.
for (const name of ['dummy-on', 'dummy-off', 'dummy-rust', 'dummy-heavy', 'dummy-unwanted', 'dummy-base', 'dummy-dep']) {
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
// "비슷한 다른 폴더에서 heavy를 껐다"는 학습 기록을 미리 넣어 둔다(확장의 globalState는 확장 ID 키에 JSON으로 저장된다).
const learned = [{ folder: path.join(DIR, 'elsewhere'), name: 'elsewhere', signature: ['package.json'], off: [HEAVY], on: [], time: Date.now() }];
globalDb.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('newdlops.extension-loadout', JSON.stringify({ 'extensionLoadout.learned': learned }));
globalDb.close();

fs.writeFileSync(path.join(ws, '.vscode', 'extension-loadout.json'), JSON.stringify({ enable: [OFF], disable: [ON] }, null, 2));
// 저장소 권장: 설치되지 않은 확장 하나를 권장하고, UNWANTED는 원치 않는다고 적는다. package.json은 스택 표식이다.
fs.writeFileSync(path.join(ws, '.vscode', 'extensions.json'), '{\n  // repo recommendations\n  "recommendations": ["loadouttest.not-installed"],\n  "unwantedRecommendations": ["' + UNWANTED + '"]\n}\n');
fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"ws","private":true}');

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
  ['1단계: "필요 없음" 추천 = Rust 전용 확장 + 저장소가 원치 않는 확장', same(at('1', 'suggestions'), [RUST, UNWANTED])],
  ['1단계: 스택 표식(package.json) 감지', same(at('1', 'recs')?.signature, ['package.json'])],
  ['1단계: 비슷한 폴더에서 끈 확장 제안(내 결정 학습)', same(at('1', 'recs')?.learned, [HEAVY])],
  ['1단계: 목록에 메모리·추천·학습·저장소 권장 묶음', ['memory', 'suggest', 'learned', 'repo'].every((g) => (at('1', 'tree') ?? []).some((x) => x.group === g))],
  ['1단계: 설치되지 않은 권장 확장 표시', (at('1', 'tree') ?? []).find((x) => x.group === 'repo')?.items.includes('missing:loadouttest.not-installed')],
  ['1단계: 필터(⚡ always)는 항상 켜지는 확장만', (() => { const g = (at('1', 'treeAlways') ?? []).find((x) => x.group === 'global'); return !!g && g.items.includes(HEAVY) && !g.items.includes(RUST); })()],
  ['1단계: 확장이 띄운 프로세스 메모리 측정(80MB 자식 프로세스)', (at('1', 'heavy')?.bytes ?? 0) >= 60 * 1024 ** 2 && at('1', 'heavy')?.pids >= 1],
  ['1단계: 메모리 압박 수준 읽기', ['normal', 'warn', 'critical'].includes(at('1', 'pressure'))],
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
  ['7단계: 라이브러리를 끄면 그것이 필요한 확장도 함께 꺼짐', same(at('7', 'afterBaseOff')?.disable, [BASE, DEP])],
  ['7단계: 필요한 확장을 켜면 라이브러리도 함께 켜짐', same(at('7', 'afterDepOn'), { enable: [], disable: [] })],
  ['7단계: 프리셋 저장 후 다른 상태에서 적용하면 그대로 돌아옴', same(at('7', 'afterPreset'), { enable: [OFF], disable: [ON] })],
  ['7단계: 대시보드가 열리고 모든 확장을 보여줌(CSP 포함)', at('7', 'dashboard')?.html === true && at('7', 'dashboard')?.ids.includes(HEAVY) && at('7', 'dashboard')?.rows === (OPEN_MODE ? 9 : 7)],
  ['7단계: 대시보드에서 끈 확장이 loadout 파일에 반영됨', same(at('7', 'afterDashboard'), { enable: [OFF], disable: [ON, RUST] })],
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
