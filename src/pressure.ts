// 시스템 메모리 압박 수준.
// macOS의 "여유 메모리 %"(memory_pressure)는 스왑이 가득 찬 상태에서도 45%처럼 넉넉하게 나와 쓸 수 없다.
// 대신 커널이 직접 판정하는 압박 수준을 쓴다: macOS kern.memorystatus_vm_pressure_level(1 정상, 2 경고, 4 위험),
// Linux PSI(/proc/pressure/memory), 그 밖에는 남은 메모리 비율.
// 여기에 스왑과 압축 메모리가 차오르는 것도 경고로 본다(위험 판정은 위의 시스템 지표에만 맡긴다).
//  - 스왑: macOS는 스왑 파일을 필요할 때 늘리므로 "전체 대비 사용률"은 늘 높다. 대신 분당 늘어난 양을 본다.
//  - 압축 메모리(macOS): 압축된 페이지가 차지한 실제 메모리가 RAM의 40% 이상이면 경고.
//    압박이 없을 때도 20~30%까지 차는 경우가 있어, 상태 표시줄이 늘 경고로 남지 않도록 높게 잡는다.
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
  /** 직전 측정 이후 분당 스왑 증가량(바이트). 처음 잴 때는 없다. */
  swapRate?: number;
  /** macOS 압축 메모리(바이트)와 실제 메모리 크기. */
  compressed?: number;
  physical?: number;
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

export const SWAP_RATE_WARN = 256 * 1024 ** 2;
export const COMPRESSED_WARN = 0.4;

/** 직전 측정에서 지금까지 분당 스왑 증가량. 간격이 20초~10분일 때만 계산한다. */
export function swapRate(prev: { at: number; used: number } | undefined, used: number, at: number): number | undefined {
  if (!prev) return undefined;
  const elapsed = at - prev.at;
  if (elapsed < 20_000 || elapsed > 10 * 60_000) return undefined;
  return ((used - prev.used) / elapsed) * 60_000;
}

/** 스왑이 분당 256MB 이상 늘고 있으면 경고. */
export const levelFromSwapRate = (rate: number | undefined): PressureLevel => (rate !== undefined && rate >= SWAP_RATE_WARN ? 'warn' : 'normal');

/** 압축 메모리가 실제 메모리의 40% 이상을 차지하면 경고. */
export const levelFromCompressed = (compressed: number, physical: number): PressureLevel =>
  physical > 0 && compressed / physical >= COMPRESSED_WARN ? 'warn' : 'normal';

/** vm_stat의 "Pages occupied by compressor"를 바이트로. */
export function parseCompressed(vmStat: string, pageSize: number): number | undefined {
  const m = /Pages occupied by compressor:\s+(\d+)/.exec(vmStat);
  return m ? Number(m[1]) * pageSize : undefined;
}

export const maxLevel = (...levels: PressureLevel[]): PressureLevel => levels.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'normal');

export const NOTIFY_COOLDOWN_MS = 60 * 60_000;

/**
 * 메모리 압박 알림을 띄울지. 이 창에서 이미 알린 수준보다 높아졌고, 최근 1시간 안에(어느 창에서든, 재시작 전이라도)
 * 같은 수준 이상을 알린 적이 없을 때만. 재시작이나 창 여러 개 때문에 같은 알림이 되풀이되지 않게 한다.
 */
export function shouldNotify(level: PressureLevel, notifiedHere: PressureLevel, last: { level: PressureLevel; at: number } | undefined, now: number): boolean {
  if (rank(level) <= rank(notifiedHere)) return false;
  return !last || now - last.at >= NOTIFY_COOLDOWN_MS || rank(level) > rank(last.level);
}

export function levelFromFree(free: number, total: number): PressureLevel {
  const ratio = total ? free / total : 1;
  if (ratio < 0.05) return 'critical';
  if (ratio < 0.1) return 'warn';
  return 'normal';
}

/** /proc/meminfo의 SwapTotal·SwapFree(kB) → 바이트. 스왑이 없으면 undefined. */
export function parseMeminfoSwap(text: string): { used: number; total: number } | undefined {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN);
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  return Number.isNaN(total) || Number.isNaN(free) || total === 0 ? undefined : { used: (total - free) * 1024, total: total * 1024 };
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

// 분당 스왑 증가량을 내려고 직전 측정을 기억한다. 20초 안에 다시 재면 직전 값을 그대로 쓴다.
let swapSample: { at: number; used: number; rate?: number } | undefined;
function trackSwap(used: number | undefined, at: number): number | undefined {
  if (used === undefined) return undefined;
  const prev = swapSample;
  if (prev && at - prev.at < 20_000) return prev.rate;
  const rate = swapRate(prev, used, at);
  swapSample = { at, used, rate };
  return rate;
}

const swapDetail = (swap: { used: number; total: number } | undefined, rate: number | undefined) =>
  swap ? ` · swap ${gb(swap.used)} / ${gb(swap.total)}${rate !== undefined ? ` (${rate >= 0 ? '+' : ''}${Math.round(rate / 1024 ** 2)} MB/min)` : ''}` : '';

export async function readPressure(platform: NodeJS.Platform = process.platform, now = Date.now()): Promise<Pressure> {
  if (platform === 'darwin') {
    const kernel = levelFromDarwin(Number(await sysctl('kern.memorystatus_vm_pressure_level')));
    const swap = parseSwapUsage(await sysctl('vm.swapusage').catch(() => ''));
    const rate = trackSwap(swap?.used, now);
    const physical = Number(await sysctl('hw.memsize').catch(() => '0'));
    const pageSize = Number(await sysctl('hw.pagesize').catch(() => '16384'));
    const vmStat = await new Promise<string>((resolve) => execFile('vm_stat', { timeout: 5000 }, (e, out) => resolve(e ? '' : out)));
    const compressed = parseCompressed(vmStat, pageSize);
    const level = maxLevel(kernel, levelFromSwapRate(rate), compressed !== undefined ? levelFromCompressed(compressed, physical) : 'normal');
    return {
      level,
      source: 'kernel',
      detail: `memory pressure: ${level} (kernel ${kernel})${swapDetail(swap, rate)}${compressed !== undefined ? ` · compressed ${gb(compressed)} of ${gb(physical)}` : ''}`,
      swapUsed: swap?.used,
      swapTotal: swap?.total,
      swapRate: rate,
      compressed,
      physical,
    };
  }
  let swap: { used: number; total: number } | undefined;
  let rate: number | undefined;
  if (platform === 'linux') {
    swap = parseMeminfoSwap(await fs.promises.readFile('/proc/meminfo', 'utf8').catch(() => ''));
    rate = trackSwap(swap?.used, now);
    try {
      const psi = levelFromPsi(await fs.promises.readFile('/proc/pressure/memory', 'utf8'));
      if (psi) {
        const level = maxLevel(psi, levelFromSwapRate(rate));
        return { level, source: 'psi', detail: `memory pressure (PSI): ${level}${swapDetail(swap, rate)}`, swapUsed: swap?.used, swapTotal: swap?.total, swapRate: rate };
      }
    } catch {
      // PSI가 없는 커널
    }
  }
  const level = maxLevel(levelFromFree(os.freemem(), os.totalmem()), levelFromSwapRate(rate));
  return {
    level,
    source: 'free',
    detail: `${gb(os.freemem())} of ${gb(os.totalmem())} free${swapDetail(swap, rate)}`,
    free: os.freemem(),
    total: os.totalmem(),
    swapUsed: swap?.used,
    swapTotal: swap?.total,
    swapRate: rate,
  };
}
