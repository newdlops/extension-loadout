// 시스템 메모리 압박 수준.
// macOS의 "여유 메모리 %"(memory_pressure)는 스왑이 가득 찬 상태에서도 45%처럼 넉넉하게 나와 쓸 수 없다.
// 대신 커널이 직접 판정하는 압박 수준을 쓴다: macOS kern.memorystatus_vm_pressure_level(1 정상, 2 경고, 4 위험),
// Linux PSI(/proc/pressure/memory), 그 밖에는 남은 메모리 비율.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export type PressureLevel = 'normal' | 'warn' | 'critical';

export interface Pressure {
  level: PressureLevel;
  /** 어디서 판단했는지. */
  source: 'kernel' | 'psi' | 'free';
  /** 영어 근거(로그용). 화면은 아래 수치로 번역한 문장을 만든다. */
  detail: string;
  swapUsed?: number;
  swapTotal?: number;
  free?: number;
  total?: number;
}

export const rank = (l: PressureLevel): number => ({ normal: 0, warn: 1, critical: 2 })[l];

export function levelFromDarwin(value: number): PressureLevel {
  if (value >= 4) return 'critical';
  if (value >= 2) return 'warn';
  return 'normal';
}

/** /proc/pressure/memory: "some avg10=12.34 ..." / "full avg10=..." */
export function levelFromPsi(text: string): PressureLevel | undefined {
  const avg = (kind: string) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm').exec(text)?.[1] ?? NaN);
  const some = avg('some');
  const full = avg('full');
  if (Number.isNaN(some)) return undefined;
  if (full >= 10 || some >= 40) return 'critical';
  if (some >= 10) return 'warn';
  return 'normal';
}

export function levelFromFree(free: number, total: number): PressureLevel {
  const ratio = total ? free / total : 1;
  if (ratio < 0.05) return 'critical';
  if (ratio < 0.1) return 'warn';
  return 'normal';
}

/** "total = 9216.00M  used = 8191.94M  free = 1024.06M" */
export function parseSwapUsage(text: string): { used: number; total: number } | undefined {
  const mb = (key: string) => Number(new RegExp(`${key} = ([\\d.]+)M`).exec(text)?.[1] ?? NaN);
  const total = mb('total');
  const used = mb('used');
  return Number.isNaN(total) || Number.isNaN(used) ? undefined : { used: used * 1024 ** 2, total: total * 1024 ** 2 };
}

const sysctl = (name: string) =>
  new Promise<string>((resolve, reject) => execFile('sysctl', ['-n', name], { timeout: 5000 }, (e, out) => (e ? reject(e) : resolve(out.trim()))));

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

export async function readPressure(platform: NodeJS.Platform = process.platform): Promise<Pressure> {
  if (platform === 'darwin') {
    const level = levelFromDarwin(Number(await sysctl('kern.memorystatus_vm_pressure_level')));
    const swap = parseSwapUsage(await sysctl('vm.swapusage').catch(() => ''));
    return {
      level,
      source: 'kernel',
      detail: `kernel memory pressure: ${level}${swap ? ` · swap ${gb(swap.used)} / ${gb(swap.total)}` : ''}`,
      swapUsed: swap?.used,
      swapTotal: swap?.total,
    };
  }
  if (platform === 'linux') {
    try {
      const level = levelFromPsi(await fs.promises.readFile('/proc/pressure/memory', 'utf8'));
      if (level) return { level, source: 'psi', detail: `memory pressure (PSI): ${level}` };
    } catch {
      // PSI가 없는 커널
    }
  }
  const level = levelFromFree(os.freemem(), os.totalmem());
  return { level, source: 'free', detail: `${gb(os.freemem())} of ${gb(os.totalmem())} free`, free: os.freemem(), total: os.totalmem() };
}
