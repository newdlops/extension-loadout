// 다른 폴더에 한꺼번에 적용하기 위한 탐색: 같은 저장소의 git worktree와, VS Code가 이미 저장소(workspaceStorage)를 만든 폴더.
// VS Code는 한 번이라도 연 폴더에만 작업 영역 저장소를 만든다. 열어 본 적 없는 폴더는 적용할 수 없다.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface StorageEntry {
  /** workspaceStorage/<id> 폴더. */
  dir: string;
  dbPath: string;
  /** 이 저장소가 가리키는 폴더(파일 시스템 경로). */
  folder: string;
  /** state.vscdb를 마지막으로 고친 시각(최근에 쓴 폴더를 위로). */
  mtimeMs: number;
}

/** `git worktree list --porcelain` 출력에서 경로만. */
export function parseWorktreeList(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
}

export function gitWorktrees(folder: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['-C', folder, 'worktree', 'list', '--porcelain'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? [] : parseWorktreeList(stdout).map((p) => path.normalize(p)));
    });
  });
}

/** 같은 경로인지. macOS·Windows는 대소문자를 구분하지 않는 파일 시스템이 기본이다. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}

/**
 * workspace.json 내용에서 폴더 경로. 멀티 루트(.code-workspace)나 원격 폴더는 건너뛴다.
 * uriToPath: "file:///..." URI를 파일 경로로(테스트에서 바꿔 끼울 수 있게 밖에서 받는다).
 */
export function folderOfWorkspaceJson(text: string, uriToPath: (uri: string) => string | undefined): string | undefined {
  try {
    const j = JSON.parse(text) as { folder?: unknown };
    return typeof j.folder === 'string' && j.folder.startsWith('file:') ? uriToPath(j.folder) : undefined;
  } catch {
    return undefined;
  }
}

export async function listWorkspaceStorages(root: string, uriToPath: (uri: string) => string | undefined): Promise<StorageEntry[]> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  const out = await Promise.all(
    dirs.map(async (d): Promise<StorageEntry | undefined> => {
      const dir = path.join(root, d);
      try {
        const folder = folderOfWorkspaceJson(await fs.promises.readFile(path.join(dir, 'workspace.json'), 'utf8'), uriToPath);
        if (!folder) return undefined;
        const dbPath = path.join(dir, 'state.vscdb');
        const st = await fs.promises.stat(dbPath);
        return { dir, dbPath, folder, mtimeMs: st.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return out.filter((x): x is StorageEntry => !!x).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 폴더마다 가장 최근 저장소 하나(같은 폴더를 여러 번 지웠다 만들면 저장소가 여러 개일 수 있다). */
export function latestStoragePerFolder(entries: StorageEntry[], platform: NodeJS.Platform = process.platform): StorageEntry[] {
  const out: StorageEntry[] = [];
  for (const e of entries) if (!out.some((o) => samePath(o.folder, e.folder, platform))) out.push(e);
  return out;
}
