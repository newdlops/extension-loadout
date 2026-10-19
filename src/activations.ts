// 이 창에서 각 확장이 왜 켜졌는지. VS Code가 확장 호스트 로그(exthost.log)에 남기는 활성화 기록을 읽는다.
//   ExtensionService#_doActivateExtension ms-python.python, startup: false, activationEvent: 'api', root cause: ms-python.vscode-python-envs
// "root cause"는 바로 앞의 원인이므로(Pylance ← Python ← Python Environments ← Ruff) 끝까지 따라가야 처음 원인이 나온다.
// VS Code 내부 로그 형식이라 바뀔 수 있고, 로그 수준을 Info보다 높이면 기록이 없다. 읽지 못하면 이 정보 없이 동작한다.
import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

export interface Activated {
  id: string;
  /** 'api', 'onLanguage:python', 'workspaceContains:…', '*' 같은 활성화 이벤트. */
  event: string;
  startup: boolean;
  /** 이 확장을 켠 확장(바로 앞 원인). */
  cause?: string;
}

const HOST_START = /Extension host with pid (\d+) started/;
const ACTIVATE = /_doActivateExtension ([^\s,]+), startup: (true|false), activationEvent: '([^']*)'(?:, root cause: ([^\s,]+))?/;

/**
 * 로그를 줄 단위로 받아 이 확장 호스트(pid)가 켠 확장을 모은다.
 * 확장 호스트를 다시 시작하면 같은 파일에 새 구간("Extension host with pid N started")이 붙으므로 그 pid의 구간만 본다.
 */
export class ActivationParser {
  readonly activated = new Map<string, Activated>();
  private inBlock = false;

  constructor(private readonly hostPid: number) {}

  line(text: string): void {
    const host = HOST_START.exec(text);
    if (host) {
      this.inBlock = Number(host[1]) === this.hostPid;
      if (this.inBlock) this.activated.clear();
      return;
    }
    if (!this.inBlock) return;
    const m = ACTIVATE.exec(text);
    if (!m) return;
    const id = m[1].toLowerCase();
    // 처음 켜진 이유만 남긴다.
    if (!this.activated.has(id)) this.activated.set(id, { id, startup: m[2] === 'true', event: m[3], cause: m[4]?.toLowerCase() });
  }
}

export function parseActivations(log: string, hostPid: number): Map<string, Activated> {
  const p = new ActivationParser(hostPid);
  for (const l of log.split('\n')) p.line(l);
  return p.activated;
}

/** 이 확장을 켠 확장들. 가까운 원인부터 처음 원인까지. */
export function causesOf(acts: Map<string, Activated>, id: string): string[] {
  const out: string[] = [];
  let cur = acts.get(id)?.cause;
  while (cur && cur !== id && !out.includes(cur)) {
    out.push(cur);
    cur = acts.get(cur)?.cause;
  }
  return out;
}

/** 연쇄가 바뀌었는지 비교할 때 쓰는 문자열. */
export const chainKeyOf = (chains: Map<string, string[]>): string =>
  [...chains].map(([k, v]) => `${k}>${v.join(',')}`).sort().join('|');

/** 확장 ID → 그 확장 때문에 켜진 확장들(직접·간접, 켜진 순서). */
export function startedBy(acts: Map<string, Activated>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of acts.keys()) {
    for (const c of causesOf(acts, id)) out.set(c, [...(out.get(c) ?? []), id]);
  }
  return out;
}

/**
 * exthost.log를 이어서 읽는다. 로그는 뒤에만 붙으므로 지난번에 읽은 곳부터 새로 붙은 만큼만 읽는다.
 * 파일이 없거나(원격 창 등) 읽지 못하면 빈 기록을 돌려준다.
 */
export class ActivationLog {
  private parser: ActivationParser;
  private offset = 0;
  private rest = '';
  private decoder = new StringDecoder('utf8');

  constructor(
    private readonly file: string | undefined,
    private readonly hostPid: number,
  ) {
    this.parser = new ActivationParser(hostPid);
  }

  private reading?: Promise<Map<string, Activated>>;

  /** 동시에 여러 번 불러도 한 번씩 차례로 읽는다(읽은 위치를 겹쳐 세지 않도록). */
  read(): Promise<Map<string, Activated>> {
    this.reading ??= this.readNew().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async readNew(): Promise<Map<string, Activated>> {
    if (!this.file) return this.parser.activated;
    try {
      const { size } = await fs.promises.stat(this.file);
      if (size < this.offset) this.reset();
      if (size > this.offset) {
        const fh = await fs.promises.open(this.file, 'r');
        try {
          const buf = Buffer.alloc(size - this.offset);
          const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
          this.offset += bytesRead;
          const lines = (this.rest + this.decoder.write(buf.subarray(0, bytesRead))).split('\n');
          this.rest = lines.pop() ?? '';
          for (const l of lines) this.parser.line(l);
        } finally {
          await fh.close();
        }
      }
    } catch {
      // 기록 없이 동작한다.
    }
    return this.parser.activated;
  }

  private reset(): void {
    this.parser = new ActivationParser(this.hostPid);
    this.offset = 0;
    this.rest = '';
    this.decoder = new StringDecoder('utf8');
  }
}
