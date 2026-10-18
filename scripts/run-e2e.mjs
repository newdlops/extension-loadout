// 격리된 VS Code(별도 user-data-dir, extensions-dir)에서 Extension Loadout을 처음부터 끝까지 시험한다.
//  1단계: loadout이 전역 ON 확장을 끄고, 전역 OFF 확장을 켠다 → 적용하고 재시작
//  2단계: 반영됐는지 확인한 뒤 둘 다 "전역 설정 따름"으로 되돌린다 → 적용하고 재시작
//  3단계: 원래 상태로 돌아왔는지 확인한다
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// macOS는 소켓 경로가 103자를 넘으면 VS Code가 뜨지 않으므로 짧은 경로를 쓴다.
const DIR = path.join(ROOT, '.vscode-test', 'e2e');
const APP = process.env.VSCODE_APP ?? '/Applications/Visual Studio Code.app';
const CODE = path.join(APP, 'Contents', 'MacOS', 'Code');
const CLI = path.join(APP, 'Contents', 'Resources', 'app', 'bin', 'code');
const ON = 'loadouttest.dummy-on';
const OFF = 'loadouttest.dummy-off';

const ud = path.join(DIR, 'ud');
const exts = path.join(DIR, 'exts');
const ws = path.join(DIR, 'ws');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'User', 'globalStorage'), { recursive: true });
fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
fs.mkdirSync(exts, { recursive: true });

for (const name of ['dummy-on', 'dummy-off']) {
  const vsix = path.join(DIR, `${name}.vsix`);
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'vsce'), ['package', '--allow-missing-repository', '--skip-license', '-o', vsix], {
    cwd: path.join(ROOT, 'test', 'fixtures', name),
    stdio: 'ignore',
  });
  execFileSync(CLI, ['--user-data-dir', ud, '--extensions-dir', exts, '--install-extension', vsix], { stdio: 'ignore' });
}

// dummy-off는 전역에서 꺼 둔다.
const globalDb = new DatabaseSync(path.join(ud, 'User', 'globalStorage', 'state.vscdb'));
globalDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
globalDb.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('extensionsIdentifiers/disabled', JSON.stringify([{ id: OFF }]));
globalDb.close();

fs.writeFileSync(path.join(ws, '.vscode', 'extension-loadout.json'), JSON.stringify({ enable: [OFF], disable: [ON] }, null, 2));

const args = [
  '--user-data-dir', ud,
  '--extensions-dir', exts,
  `--extensionDevelopmentPath=${ROOT}`,
  `--extensionDevelopmentPath=${path.join(ROOT, 'test', 'e2e-driver')}`,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  ws,
];
const env = {
  ...process.env,
  EXTENSION_LOADOUT_E2E_DIR: DIR,
  EXTENSION_LOADOUT_RELAUNCH: JSON.stringify({ command: CODE, args }),
};
delete env.ELECTRON_RUN_AS_NODE;
spawn(CODE, args, { env, detached: true, stdio: 'ignore' }).unref();

const phaseFile = path.join(DIR, 'phase');
const alive = () => {
  try {
    return execFileSync('pgrep', ['-f', ud]).toString().trim().length > 0;
  } catch {
    return false;
  }
};
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : '';
  if (phase === 'done' && !alive()) break;
}

const lines = fs.existsSync(path.join(DIR, 'driver.jsonl'))
  ? fs.readFileSync(path.join(DIR, 'driver.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : [];
const state = (phase) => lines.find((l) => l.phase === phase && 'on' in l);
const followGlobal = lines.find((l) => l.configAfterFollowGlobal)?.configAfterFollowGlobal;

const checks = [
  ['1단계: 시작 상태(전역 ON 실행, 전역 OFF 미실행)', state('1')?.on === true && state('1')?.off === false],
  ['2단계: loadout 적용 후 ON 확장 꺼짐', state('2')?.on === false],
  ['2단계: loadout 적용 후 전역 OFF 확장 켜짐', state('2')?.off === true],
  ['2단계: 전역 따름으로 되돌린 loadout 파일', JSON.stringify(followGlobal) === JSON.stringify({ enable: [], disable: [] })],
  ['3단계: 원래 상태로 복귀', state('3')?.on === true && state('3')?.off === false],
  ['오류 없음', !lines.some((l) => l.error)],
  ['격리 VS Code 종료됨', !alive()],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  failed ||= !ok;
}
if (failed) {
  console.log('\n--- driver log');
  for (const l of lines) console.log(JSON.stringify(l));
  const restartLog = path.join(os.tmpdir(), 'extension-loadout-restart.log');
  if (fs.existsSync(restartLog)) console.log('--- restart log\n' + fs.readFileSync(restartLog, 'utf8').split('\n').slice(-10).join('\n'));
  if (alive()) execFileSync('pkill', ['-f', ud]);
  process.exit(1);
}
