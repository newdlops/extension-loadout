// "적용하고 재시작": 도우미를 분리 실행한 뒤 VS Code를 종료한다.
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RestartPlan } from './restartHelper';

/** 테스트에서 격리된 VS Code를 같은 인자로 다시 띄우기 위한 덮어쓰기. {"command": "...", "args": [...]} */
const RELAUNCH_ENV = 'EXTENSION_LOADOUT_RELAUNCH';

export function relaunchCommand(): RestartPlan['relaunch'] {
  const override = process.env[RELAUNCH_ENV];
  if (override) return JSON.parse(override);
  if (process.platform === 'darwin') {
    // appRoot = <번들>.app/Contents/Resources/app. open -a로 열면 VS Code가 이전 창들을 복원한다.
    const bundle = path.resolve(vscode.env.appRoot, '..', '..', '..');
    return bundle.endsWith('.app') ? { command: 'open', args: ['-a', bundle] } : undefined;
  }
  // Windows와 Linux에서는 확장 호스트가 VS Code 실행 파일 자체로 돌아간다.
  return { command: process.execPath, args: [] };
}

export function logPath(): string {
  return path.join(os.tmpdir(), 'extension-loadout-restart.log');
}

export async function restartWith(
  context: vscode.ExtensionContext,
  dbPath: string,
  items: Record<string, string | null>,
): Promise<void> {
  // 확장 호스트의 부모가 VS Code 메인 프로세스다.
  const mainPid = process.ppid;
  if (!mainPid || mainPid <= 1) throw new Error('Could not find the VS Code main process.');
  const plan: RestartPlan = { mainPid, dbPath, items, relaunch: relaunchCommand(), logPath: logPath() };
  const helper = context.asAbsolutePath(path.join('dist', 'restartHelper.js'));
  spawn(process.execPath, [helper, JSON.stringify(plan)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
  await vscode.commands.executeCommand('workbench.action.quit');
}
