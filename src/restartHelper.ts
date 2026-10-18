// VS Code와 분리되어 실행되는 도우미.
// 1) VS Code 메인 프로세스가 끝나기를 기다린다.
// 2) 아무도 열고 있지 않은 작업 영역 저장소(state.vscdb)들에 확장 활성 상태를 쓴다.
//    - 직접 받은 계획(targets)과, 계획 폴더(planDir)에 남아 있는 "종료할 때 적용" 계획을 모두 처리한다.
// 3) relaunch가 있으면 VS Code를 다시 실행한다.
// 실행 중인 VS Code는 저장소를 메모리에 캐시하므로, 이 순서가 아니면 바뀐 값이 반영되지 않는다.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { PlanTarget, readPlanFiles } from './plan';
import { writeItems } from './stateDb';

export interface RestartPlan {
  mainPid: number;
  targets?: PlanTarget[];
  /** 메인 프로세스가 끝난 뒤 읽을 계획 폴더. 남아 있는 계획을 적용하고 지운다. */
  planDir?: string;
  relaunch?: { command: string; args: string[] };
  logPath?: string;
  /** 메인 프로세스가 이 시간 안에 끝나지 않으면(종료 취소 등) 아무것도 쓰지 않고 그만둔다. */
  timeoutMs?: number;
  pollMs?: number;
  /** 0.4 이전 형식(대상 하나). */
  dbPath?: string;
  items?: Record<string, string | null>;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM이면 프로세스는 살아 있다(권한만 없음).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function runRestartPlan(plan: RestartPlan): Promise<'applied' | 'timeout'> {
  const log = (msg: string) => {
    if (plan.logPath) fs.appendFileSync(plan.logPath, `${new Date().toISOString()} ${msg}\n`);
  };
  const deadline = Date.now() + (plan.timeoutMs ?? 10 * 60_000);
  while (isAlive(plan.mainPid)) {
    if (Date.now() > deadline) {
      log(`VS Code (pid ${plan.mainPid}) did not exit in time; nothing written.`);
      return 'timeout';
    }
    await new Promise((r) => setTimeout(r, plan.pollMs ?? 200));
  }
  const targets: { target: PlanTarget; file?: string }[] = [
    ...(plan.targets ?? []).map((target) => ({ target })),
    ...(plan.dbPath && plan.items ? [{ target: { dbPath: plan.dbPath, items: plan.items } }] : []),
    ...(plan.planDir ? readPlanFiles(plan.planDir) : []),
  ];
  for (const { target, file } of targets) {
    if (!fs.existsSync(target.dbPath)) {
      log(`skipped ${target.dbPath}: storage not found`);
      continue;
    }
    try {
      writeItems(target.dbPath, target.items);
      log(`wrote ${Object.keys(target.items).join(', ')} to ${target.dbPath}`);
      if (file) {
        fs.rmSync(file, { force: true });
        fs.rmSync(file.replace(/\.json$/, '.sql'), { force: true });
      }
    } catch (e) {
      log(`failed to write ${target.dbPath}: ${(e as Error).message}`);
    }
  }
  if (plan.relaunch) {
    const env = { ...process.env };
    // 도우미를 Node로 돌리려고 켠 플래그가 새 VS Code로 넘어가면 VS Code가 Node로 실행되고 바로 끝난다.
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(plan.relaunch.command, plan.relaunch.args, { detached: true, stdio: 'ignore', env }).unref();
    log(`relaunched: ${plan.relaunch.command} ${plan.relaunch.args.join(' ')}`);
  }
  return 'applied';
}

if (require.main === module) {
  const arg = process.argv[2] ?? '{}';
  // 계획이 길면 파일로 넘긴다(@경로).
  const plan = JSON.parse(arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg) as RestartPlan;
  runRestartPlan(plan).catch((e) => {
    if (plan.logPath) fs.appendFileSync(plan.logPath, `${new Date().toISOString()} failed: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 1;
  });
}
