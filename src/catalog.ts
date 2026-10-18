// 설치된 확장 목록을 확장 폴더의 extensions.json에서 읽는다.
// vscode.extensions.all은 꺼진 확장을 보여주지 않으므로 이 목록이 "켤 수 있는 후보"의 출처다.
import * as fs from 'fs';
import * as path from 'path';
import { normalizeId } from './loadout';

/** 확장이 언제 켜지는지. 사용자가 "이 확장이 항상 자원을 쓰는지"를 알아보게 돕는다. */
export interface Activation {
  /** always: 시작할 때마다 켜짐, triggered: 특정 언어·파일·명령에서만, none: 실행 코드가 없음(테마·스니펫 등) */
  kind: 'always' | 'triggered' | 'none';
  languages: string[];
  files: string[];
}

/** 목록에 짧게 보여줄 "언제 켜지는지". */
export function activationText(a: Activation): string {
  if (a.kind === 'none') return 'no code';
  if (a.kind === 'always') return 'starts always';
  if (a.languages.length) return a.languages.slice(0, 3).join(', ') + (a.languages.length > 3 ? ', …' : '');
  if (a.files.length) return `when ${a.files[0]} exists`;
  return 'on demand';
}

export interface InstalledExtension {
  id: string;
  uuid?: string;
  displayName: string;
  description?: string;
  publisher: string;
  version: string;
  location: string;
  /** 확장 아이콘 파일의 절대 경로. */
  icon?: string;
  categories: string[];
  activation: Activation;
}

export function describeActivation(manifest: Record<string, unknown>): Activation {
  const events = Array.isArray(manifest.activationEvents) ? (manifest.activationEvents as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  const after = (prefix: string) => [...new Set(events.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)))];
  const languages = after('onLanguage:');
  const files = after('workspaceContains:').map((g) => g.replace(/^\*\*\//, ''));
  if (!manifest.main && !manifest.browser) return { kind: 'none', languages, files };
  // 1.74부터 기여한 명령·뷰는 암묵적 활성화 이벤트가 되므로, 이벤트가 비어 있으면 필요할 때만 켜진다.
  const always = events.some((e) => e === '*' || e === 'onStartupFinished');
  return { kind: always ? 'always' : 'triggered', languages, files };
}

interface ExtensionsJsonEntry {
  identifier?: { id?: string; uuid?: string };
  version?: string;
  relativeLocation?: string;
  location?: { fsPath?: string; path?: string };
}

// 목록은 사이드바가 그려질 때 읽는다. 확장 호스트를 막지 않도록 모두 비동기로, 확장별로 병렬로 읽는다.
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const exists = (file: string) => fs.promises.access(file).then(() => true, () => false);

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

// extensions.json이 바뀌지 않았으면 매니페스트 수십 개를 다시 읽지 않는다. 읽는 중인 요청은 함께 기다린다.
let cache: { dir: string; stamp: string; list: Promise<InstalledExtension[]> } | undefined;

export async function readInstalledExtensions(extensionsDir: string): Promise<InstalledExtension[]> {
  let stamp: string;
  try {
    const st = await fs.promises.stat(path.join(extensionsDir, 'extensions.json'));
    const obsolete = await fs.promises.stat(path.join(extensionsDir, '.obsolete')).catch(() => undefined);
    stamp = `${st.mtimeMs}:${st.size}:${obsolete?.mtimeMs ?? 0}`;
  } catch {
    return [];
  }
  if (!cache || cache.dir !== extensionsDir || cache.stamp !== stamp) {
    const list = scanInstalledExtensions(extensionsDir);
    cache = { dir: extensionsDir, stamp, list };
    list.catch(() => {
      if (cache?.list === list) cache = undefined;
    });
  }
  return cache.list;
}

async function readExtension(extensionsDir: string, e: ExtensionsJsonEntry, obsolete: Record<string, boolean>): Promise<InstalledExtension | undefined> {
  const rawId = e.identifier?.id;
  const folder = e.relativeLocation ?? (e.location?.fsPath || e.location?.path);
  if (!rawId || !folder) return undefined;
  const location = path.isAbsolute(folder) ? folder : path.join(extensionsDir, folder);
  // 제거 예정인 확장은 .obsolete에 폴더 이름으로 표시된다.
  if (obsolete[path.basename(location)]) return undefined;
  const manifest = await readJson<Record<string, unknown>>(path.join(location, 'package.json'));
  if (!manifest) return undefined;
  const needsNls = [manifest.displayName, manifest.name, manifest.description].some((v) => typeof v === 'string' && v.startsWith('%'));
  const iconPath = typeof manifest.icon === 'string' ? path.join(location, manifest.icon) : undefined;
  const [nls, iconExists] = await Promise.all([
    needsNls ? readJson<Record<string, unknown>>(path.join(location, 'package.nls.json')) : undefined,
    iconPath ? exists(iconPath) : false,
  ]);
  const id = normalizeId(rawId);
  return {
    id,
    uuid: e.identifier?.uuid,
    displayName: localize(manifest.displayName, nls) || localize(manifest.name, nls) || id,
    description: localize(manifest.description, nls),
    publisher: String(manifest.publisher ?? id.split('.')[0]),
    version: e.version ?? String(manifest.version ?? ''),
    location,
    icon: iconExists ? iconPath : undefined,
    categories: Array.isArray(manifest.categories) ? (manifest.categories as unknown[]).map(String) : [],
    activation: describeActivation(manifest),
  };
}

async function scanInstalledExtensions(extensionsDir: string): Promise<InstalledExtension[]> {
  const [entries, obsolete] = await Promise.all([
    readJson<ExtensionsJsonEntry[]>(path.join(extensionsDir, 'extensions.json')),
    readJson<Record<string, boolean>>(path.join(extensionsDir, '.obsolete')),
  ]);
  const read = await Promise.all((entries ?? []).map((e) => readExtension(extensionsDir, e, obsolete ?? {})));
  const byId = new Map<string, InstalledExtension>();
  for (const ext of read) {
    if (!ext) continue;
    const prev = byId.get(ext.id);
    if (!prev || compareVersions(ext.version, prev.version) > 0) byId.set(ext.id, ext);
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
