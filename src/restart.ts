// 적용 경로 두 가지.
//  - 지금 재시작: 도우미를 분리 실행한 뒤 VS Code를 종료한다. 도우미가 저장소를 고치고 VS Code를 다시 띄운다.
//  - 종료할 때 적용: 계획 파일만 남기고 기다리는 도우미를 하나 띄운다. 사용자가 평소처럼 VS Code를 끌 때 적용된다.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PlanTarget, WAIT_AND_APPLY_SH, readPlanFiles, removePlanFiles, writePlanFiles } from './plan';
import type { RestartPlan } from './restartHelper';

/**
 * 테스트에서 격리된 VS Code를 같은 인자로 다시 띄우기 위한 덮어쓰기.
 * {"command": "...", "args": [...]} JSON, 또는 그 JSON이 든 파일을 "@경로"로 준다.
 */
const RELAUNCH_ENV = 'EXTENSION_LOADOUT_RELAUNCH';

export function relaunchCommand(): RestartPlan['relaunch'] {
  const override = process.env[RELAUNCH_ENV];
  if (override) return JSON.parse(override.startsWith('@') ? fs.readFileSync(override.slice(1), 'utf8') : override);
  if (process.platform === 'darwin') {
    // appRoot = <번들>.app/Contents/Resources/app. 폴더 인자 없이 열면 VS Code가 이전 창들을 복원한다.
    // -n: 방금 끝난 인스턴스를 LaunchServices가 아직 실행 중으로 보면 open -a가 새로 띄우지 않고 끝날 수 있다.
    const bundle = path.resolve(vscode.env.appRoot, '..', '..', '..');
    return bundle.endsWith('.app') ? { command: 'open', args: ['-n', '-a', bundle] } : undefined;
  }
  // Windows와 Linux에서는 확장 호스트가 VS Code 실행 파일 자체로 돌아간다.
  return { command: process.execPath, args: [] };
}

export function logPath(): string {
  return path.join(os.tmpdir(), 'extension-loadout-restart.log');
}

export const planDirOf = (context: vscode.ExtensionContext): string => path.join(context.globalStorageUri.fsPath, 'pending-apply');

function mainPid(): number {
  // 확장 호스트의 부모가 VS Code 메인 프로세스다.
  const pid = process.ppid;
  if (!pid || pid <= 1) throw new Error('Could not find the VS Code main process.');
  return pid;
}

function spawnNodeHelper(context: vscode.ExtensionContext, plan: RestartPlan): number | undefined {
  const helper = context.asAbsolutePath(path.join('dist', 'restartHelper.js'));
  // 명령줄 길이 제한을 피하려고 계획은 파일로 넘긴다.
  const planFile = path.join(os.tmpdir(), `extension-loadout-plan-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const child = spawn(process.execPath, [helper, `@${planFile}`], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return child.pid;
}

/** 지금 적용: 도우미를 띄우고 VS Code를 종료한다. 같은 저장소에 걸린 "종료할 때 적용" 계획은 이번 계획으로 대체한다. */
export async function restartNow(context: vscode.ExtensionContext, targets: PlanTarget[]): Promise<void> {
  const planDir = planDirOf(context);
  removePlanFiles(planDir, targets.map((t) => t.dbPath));
  spawnNodeHelper(context, { mainPid: mainPid(), targets, planDir, relaunch: relaunchCommand(), logPath: logPath() });
  await vscode.commands.executeCommand('workbench.action.quit');
}

function sqliteCli(): string | undefined {
  if (process.platform === 'win32') return undefined;
  return ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/bin/sqlite3'].find((p) => fs.existsSync(p));
}

function helperAlive(planDir: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(planDir, 'helper.pid'), 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 계획 파일이 남아 있는데 기다리는 도우미가 없으면 하나 띄운다. 확장이 켜질 때마다 불러도 된다. */
export function ensureQuitHelper(context: vscode.ExtensionContext): void {
  const planDir = planDirOf(context);
  if (!readPlanFiles(planDir).length || helperAlive(planDir)) return;
  const cli = sqliteCli();
  if (cli) {
    // sh + sqlite3: 기다리는 동안 거의 자원을 쓰지 않는다.
    spawn('/bin/sh', ['-c', WAIT_AND_APPLY_SH, 'extension-loadout-helper', String(mainPid()), planDir, logPath(), cli], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  const pid = spawnNodeHelper(context, { mainPid: mainPid(), planDir, logPath: logPath(), timeoutMs: 30 * 24 * 3600_000, pollMs: 500 });
  if (pid) fs.writeFileSync(path.join(planDir, 'helper.pid'), String(pid));
}

/** 종료할 때 적용: 계획을 남기고 기다리는 도우미를 확인한다. */
export function scheduleOnQuit(context: vscode.ExtensionContext, targets: PlanTarget[]): void {
  writePlanFiles(planDirOf(context), targets);
  ensureQuitHelper(context);
}

export function cancelOnQuit(context: vscode.ExtensionContext, dbPaths?: string[]): void {
  removePlanFiles(planDirOf(context), dbPaths);
}

export function pendingOnQuit(context: vscode.ExtensionContext): PlanTarget[] {
  return readPlanFiles(planDirOf(context)).map((x) => x.target);
}
