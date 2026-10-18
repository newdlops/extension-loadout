// 설치된 확장 목록을 확장 폴더의 extensions.json에서 읽는다.
// vscode.extensions.all은 꺼진 확장을 보여주지 않으므로 이 목록이 "켤 수 있는 후보"의 출처다.
import * as fs from 'fs';
import * as path from 'path';
import { normalizeId } from './loadout';

export interface InstalledExtension {
  id: string;
  uuid?: string;
  displayName: string;
  description?: string;
  version: string;
  location: string;
}

interface ExtensionsJsonEntry {
  identifier?: { id?: string; uuid?: string };
  version?: string;
  relativeLocation?: string;
  location?: { fsPath?: string; path?: string };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** package.json의 "%key%" 형태 문자열을 package.nls.json으로 풀어준다. */
function localize(value: unknown, nls: Record<string, unknown> | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^%(.+)%$/.exec(value);
  if (!m) return value;
  const entry = nls?.[m[1]];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string') {
    return (entry as { message: string }).message;
  }
  return undefined;
}

export function readInstalledExtensions(extensionsDir: string): InstalledExtension[] {
  const entries = readJson<ExtensionsJsonEntry[]>(path.join(extensionsDir, 'extensions.json')) ?? [];
  // 제거 예정인 확장은 .obsolete에 폴더 이름으로 표시된다.
  const obsolete = readJson<Record<string, boolean>>(path.join(extensionsDir, '.obsolete')) ?? {};
  const byId = new Map<string, InstalledExtension>();
  for (const e of entries) {
    const rawId = e.identifier?.id;
    if (!rawId) continue;
    const folder = e.relativeLocation ?? (e.location?.fsPath || e.location?.path);
    if (!folder) continue;
    const location = path.isAbsolute(folder) ? folder : path.join(extensionsDir, folder);
    if (obsolete[path.basename(location)]) continue;
    const manifest = readJson<Record<string, unknown>>(path.join(location, 'package.json'));
    if (!manifest) continue;
    const nls = readJson<Record<string, unknown>>(path.join(location, 'package.nls.json'));
    const id = normalizeId(rawId);
    const ext: InstalledExtension = {
      id,
      uuid: e.identifier?.uuid,
      displayName: localize(manifest.displayName, nls) || localize(manifest.name, nls) || id,
      description: localize(manifest.description, nls),
      version: e.version ?? String(manifest.version ?? ''),
      location,
    };
    const prev = byId.get(id);
    if (!prev || compareVersions(ext.version, prev.version) > 0) byId.set(id, ext);
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
