// 확장이 띄운 프로세스(언어 서버·데몬 등)의 메모리.
// - 이 창: 이 확장 호스트(process.pid)의 자손. 모든 창: VS Code 메인 프로세스(process.ppid)의 자손.
// - 어느 확장의 프로세스인지는 명령줄에 그 확장 폴더 경로가 들어 있는지로 정하고, 없으면 가장 가까운 상위 프로세스를 따른다.
// - 메모리는 "실제 점유량"을 쓴다. macOS는 압축된 메모리까지 포함한 footprint(top의 MEM),
//   Linux는 RSS + 스왑, Windows는 private bytes. RSS만 보면 압축이 많을 때 몇 배 적게 나온다.
// 확장 호스트 안에서 돌아가는 메모리는 확장별로 나눌 수 없다(VS Code가 그런 정보를 주지 않는다).
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Proc {
  pid: number;
  ppid: number;
  /** 바이트. macOS·Linux는 RSS, Windows는 private bytes. */
  bytes: number;
  command: string;
}

export interface ExtPath {
  id: string;
  location: string;
}

export interface ExtMemory {
  id: string;
  /** 이 창에서 쓰는 메모리(바이트). */
  bytes: number;
  pids: number[];
  commands: string[];
  /** 모든 창을 합친 메모리(바이트). */
  allWindowsBytes: number;
  allWindowsPids: number;
}

export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], bytes: +m[3] * 1024, command: m[4] });
  }
  return out;
}

/** PowerShell `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,PrivatePageCount,CommandLine | ConvertTo-Json`. */
export function parseWindowsProcs(json: string): Proc[] {
  const data = JSON.parse(json || '[]') as unknown;
  const list = (Array.isArray(data) ? data : [data]) as { ProcessId?: number; ParentProcessId?: number; PrivatePageCount?: number; CommandLine?: string | null }[];
  return list
    .filter((p) => typeof p.ProcessId === 'number')
    .map((p) => ({ pid: p.ProcessId!, ppid: p.ParentProcessId ?? 0, bytes: p.PrivatePageCount ?? 0, command: p.CommandLine ?? '' }));
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<Proc[]> {
  if (platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,CommandLine | ConvertTo-Json -Compress';
    return parseWindowsProcs(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]));
  }
  // -ww: 긴 명령줄이 잘리면 확장 폴더 경로로 판별할 수 없다.
  return parsePs(await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,rss=,command=']));
}

/** roots의 자손(roots 자신은 빼고). */
export function descendantsOf(procs: Proc[], roots: number[]): Map<number, Proc> {
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out = new Map<number, Proc>();
  const stack = [...roots];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (out.has(c.pid) || roots.includes(c.pid)) continue;
      out.set(c.pid, c);
      stack.push(c.pid);
    }
  }
  return out;
}

const norm = (s: string, platform: NodeJS.Platform) => {
  const x = s.replace(/\\/g, '/');
  return platform === 'linux' ? x : x.toLowerCase();
};

/** 확장 ID → 그 확장에 속한 프로세스 pid 목록. */
export function attribute(procs: Proc[], roots: number[], exts: ExtPath[], platform: NodeJS.Platform = process.platform): Map<string, number[]> {
  const scope = descendantsOf(procs, roots);
  const locations = exts
    .map((e) => ({ id: e.id, loc: norm(e.location, platform).replace(/\/+$/, '') + '/' }))
    .sort((a, b) => b.loc.length - a.loc.length);
  const tsserver = exts.find((e) => e.id === 'vscode.typescript-language-features');
  const owner = new Map<number, string>();
  for (const p of scope.values()) {
    const cmd = norm(p.command, platform);
    let hit = locations.find((l) => cmd.includes(l.loc))?.id;
    // tsserver는 내장 typescript 확장 폴더가 아니라 extensions/node_modules/typescript에서 돈다.
    if (!hit && tsserver && /\/extensions\/node_modules\/typescript\/lib\/(tsserver|typingsinstaller)/.test(cmd)) hit = tsserver.id;
    if (hit) owner.set(p.pid, hit);
  }
  // 경로로 못 정한 프로세스는 가장 가까운 상위 프로세스의 확장을 따른다(예: 언어 서버가 띄운 JVM).
  const ownerOf = (pid: number): string | undefined => {
    let cur = scope.get(pid);
    for (let guard = 0; cur && guard < 50; guard++) {
      const o = owner.get(cur.pid);
      if (o) return o;
      cur = scope.get(cur.ppid);
    }
    return undefined;
  };
  const out = new Map<string, number[]>();
  for (const p of scope.values()) {
    const o = ownerOf(p.pid);
    if (o) out.set(o, [...(out.get(o) ?? []), p.pid]);
  }
  return out;
}

/** top의 MEM 값(예: 502M+, 1024K, 1.2G, 0B)을 바이트로. */
export function parseSize(text: string): number | undefined {
  const m = /^([\d.]+)([BKMGT])?[+-]?$/.exec(text.trim());
  if (!m) return undefined;
  const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] ?? 'B') as 'B'];
  return Math.round(parseFloat(m[1]) * unit);
}

export function parseTopMem(text: string): Map<number, number> {
  const out = new Map<number, number>();
  let started = false;
  for (const line of text.split('\n')) {
    if (/^\s*PID\s+MEM/.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const size = parseSize(m[2]);
    if (size !== undefined) out.set(+m[1], size);
  }
  return out;
}

export function parseProcStatus(text: string): number | undefined {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN);
  const rss = kb('VmRSS');
  if (Number.isNaN(rss)) return undefined;
  return (rss + (Number.isNaN(kb('VmSwap')) ? 0 : kb('VmSwap'))) * 1024;
}

/** 실제 점유량. 알 수 없으면 목록의 값(RSS 등)을 쓴다. */
export async function footprints(pids: number[], procs: Map<number, Proc>, platform: NodeJS.Platform = process.platform): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const pid of pids) out.set(pid, procs.get(pid)?.bytes ?? 0);
  if (!pids.length) return out;
  if (platform === 'darwin') {
    try {
      // 한 번의 top 호출로 여러 pid를 잰다. 2초 남짓 걸리므로 화면을 열었을 때나 새로고침할 때만 부른다.
      const args = ['-l', '1', '-stats', 'pid,mem', ...pids.slice(0, 200).flatMap((p) => ['-pid', String(p)])];
      for (const [pid, bytes] of parseTopMem(await run('top', args))) out.set(pid, bytes);
    } catch {
      // RSS로 대신한다.
    }
  } else if (platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const b = parseProcStatus(await fs.promises.readFile(path.join('/proc', String(pid), 'status'), 'utf8'));
          if (b !== undefined) out.set(pid, b);
        } catch {
          // 이미 끝난 프로세스
        }
      }),
    );
  }
  return out;
}

/** 확장별 메모리(이 창 기준, 큰 순). */
export function summarize(
  thisWindow: Map<string, number[]>,
  allWindows: Map<string, number[]>,
  sizes: Map<number, number>,
  procs: Map<number, Proc>,
): ExtMemory[] {
  const sum = (pids: number[]) => pids.reduce((a, p) => a + (sizes.get(p) ?? 0), 0);
  const ids = new Set([...thisWindow.keys(), ...allWindows.keys()]);
  return [...ids]
    .map((id) => {
      const pids = thisWindow.get(id) ?? [];
      const all = allWindows.get(id) ?? pids;
      return {
        id,
        bytes: sum(pids),
        pids,
        commands: pids.map((p) => procs.get(p)?.command ?? '').filter(Boolean),
        allWindowsBytes: sum(all),
        allWindowsPids: all.length,
      };
    })
    .filter((m) => m.bytes > 0 || m.allWindowsBytes > 0)
    .sort((a, b) => b.bytes - a.bytes || b.allWindowsBytes - a.allWindowsBytes);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 한 번에 이 창과 모든 창의 확장별 메모리를 잰다. */
export async function measureExtensions(exts: ExtPath[], windowRoot: number, appRoot: number, platform: NodeJS.Platform = process.platform): Promise<ExtMemory[]> {
  const procs = await listProcesses(platform);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const thisWindow = attribute(procs, [windowRoot], exts, platform);
  const allWindows = attribute(procs, [appRoot], exts, platform);
  const pids = [...new Set([...thisWindow.values(), ...allWindows.values()].flat())];
  const sizes = await footprints(pids, byPid, platform);
  return summarize(thisWindow, allWindows, sizes, byPid);
}
