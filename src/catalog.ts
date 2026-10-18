// 설치된 확장 목록을 확장 폴더의 extensions.json(프로필이면 그 프로필의 extensions.json)에서 읽는다.
// vscode.extensions.all은 꺼진 확장을 보여주지 않으므로 이 목록이 "켤 수 있는 후보"의 출처다.
import * as fs from 'fs';
import * as path from 'path';
import { normalizeId } from './loadout';

/** 확장이 언제 켜지는지. 사용자가 "이 확장이 항상 자원을 쓰는지"를 알아보게 돕는다. */
export interface Activation {
  /** always: 시작할 때마다 켜짐, triggered: 특정 언어·파일·명령에서만, none: 실행 코드가 없음(테마·스니펫 등) */
  kind: 'always' | 'triggered' | 'none';
  languages: string[];
  /** 화면용으로 줄인 workspaceContains 패턴(앞의 ** / 제거). */
  files: string[];
  /** workspaceContains 원문 패턴. 파일 존재 확인에 쓴다. */
  globs: string[];
  /** activationEvents 원문. */
  events: string[];
}

/** 확장이 정의한 언어와 그 언어로 취급되는 파일 이름 규칙. */
export interface LanguageDef {
  id: string;
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
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
  /** extensionDependencies: 이 확장이 동작하려면 켜져 있어야 하는 확장(소문자 ID). */
  dependencies: string[];
  /** extensionPack: 확장 팩이 묶어 둔 확장(소문자 ID). */
  packMembers: string[];
  languageDefs: LanguageDef[];
  /** VS Code에 기본으로 들어 있는 확장. */
  builtin?: boolean;
}

/** 확장 목록을 읽어 올 곳. index는 extensions.json, baseDir은 relativeLocation의 기준 폴더. */
export interface CatalogSource {
  index: string;
  baseDir: string;
  /** 기본 프로필 목록에서 "모든 프로필에 적용" 확장만 가져올 때. */
  applicationScopedOnly?: boolean;
}

export function languageDefsOf(manifest: Record<string, unknown>): LanguageDef[] {
  const contributes = manifest.contributes as { languages?: unknown } | undefined;
  const list = Array.isArray(contributes?.languages) ? contributes!.languages : [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return list
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as { id?: unknown }).id === 'string')
    .map((l) => ({
      id: l.id as string,
      extensions: strings(l.extensions),
      filenames: strings(l.filenames),
      filenamePatterns: strings(l.filenamePatterns),
    }));
}

/** 목록에 짧게 보여줄 "언제 켜지는지". */
export function activationText(a: Activation): string {
  if (a.kind === 'none') return 'no code';
  if (a.kind === 'always') return '⚡ always';
  if (a.languages.length) return a.languages.slice(0, 3).join(', ') + (a.languages.length > 3 ? ', …' : '');
  if (a.files.length) return `when ${a.files[0]} exists`;
  return 'on demand';
}

export function describeActivation(manifest: Record<string, unknown>): Activation {
  const events = Array.isArray(manifest.activationEvents) ? (manifest.activationEvents as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  const after = (prefix: string) => [...new Set(events.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)))];
  const languages = after('onLanguage:');
  const globs = after('workspaceContains:');
  const files = globs.map((g) => g.replace(/^\*\*\//, ''));
  const base = { languages, files, globs, events: [...new Set(events)] };
  if (!manifest.main && !manifest.browser) return { kind: 'none', ...base };
  // 1.74부터 기여한 명령·뷰는 암묵적 활성화 이벤트가 되므로, 이벤트가 비어 있으면 필요할 때만 켜진다.
  const always = events.some((e) => e === '*' || e === 'onStartupFinished');
  return { kind: always ? 'always' : 'triggered', ...base };
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(normalizeId) : []);

/** package.json의 "%key%" 형태 문자열을 package.nls.json으로 풀어준다. */
export function localize(value: unknown, nls: Record<string, unknown> | undefined): string | undefined {
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

/** 매니페스트(package.json)를 목록 항목으로. 내장 확장도 같은 형태로 만든다. */
export function extensionFromManifest(
  manifest: Record<string, unknown>,
  info: { id: string; uuid?: string; version?: string; location: string; icon?: string; nls?: Record<string, unknown>; builtin?: boolean },
): InstalledExtension {
  const id = normalizeId(info.id);
  return {
    id,
    uuid: info.uuid,
    displayName: localize(manifest.displayName, info.nls) || localize(manifest.name, info.nls) || id,
    description: localize(manifest.description, info.nls),
    publisher: String(manifest.publisher ?? id.split('.')[0]),
    version: info.version ?? String(manifest.version ?? ''),
    location: info.location,
    icon: info.icon,
    categories: Array.isArray(manifest.categories) ? (manifest.categories as unknown[]).map(String) : [],
    activation: describeActivation(manifest),
    dependencies: ids(manifest.extensionDependencies),
    packMembers: ids(manifest.extensionPack),
    languageDefs: languageDefsOf(manifest),
    builtin: info.builtin,
  };
}

interface ExtensionsJsonEntry {
  identifier?: { id?: string; uuid?: string };
  version?: string;
  relativeLocation?: string;
  location?: { fsPath?: string; path?: string } | string;
  metadata?: { isApplicationScoped?: boolean };
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

async function readExtension(baseDir: string, e: ExtensionsJsonEntry, obsolete: Record<string, boolean>): Promise<InstalledExtension | undefined> {
  const rawId = e.identifier?.id;
  const loc = typeof e.location === 'string' ? e.location : e.location?.fsPath || e.location?.path;
  const folder = e.relativeLocation ?? loc;
  if (!rawId || !folder) return undefined;
  const location = path.isAbsolute(folder) ? folder : path.join(baseDir, folder);
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
  return extensionFromManifest(manifest, {
    id: rawId,
    uuid: e.identifier?.uuid,
    version: e.version,
    location,
    icon: iconExists ? iconPath : undefined,
    nls,
  });
}

async function scanInstalledExtensions(sources: CatalogSource[]): Promise<InstalledExtension[]> {
  const read: (InstalledExtension | undefined)[] = [];
  for (const src of sources) {
    const [entries, obsolete] = await Promise.all([
      readJson<ExtensionsJsonEntry[]>(src.index),
      readJson<Record<string, boolean>>(path.join(src.baseDir, '.obsolete')),
    ]);
    const picked = (entries ?? []).filter((e) => !src.applicationScopedOnly || e.metadata?.isApplicationScoped);
    read.push(...(await Promise.all(picked.map((e) => readExtension(src.baseDir, e, obsolete ?? {})))));
  }
  const byId = new Map<string, InstalledExtension>();
  for (const ext of read) {
    if (!ext) continue;
    const prev = byId.get(ext.id);
    if (!prev || compareVersions(ext.version, prev.version) > 0) byId.set(ext.id, ext);
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// extensions.json이 바뀌지 않았으면 매니페스트 수십 개를 다시 읽지 않는다. 읽는 중인 요청은 함께 기다린다.
let cache: { key: string; stamp: string; list: Promise<InstalledExtension[]> } | undefined;

/** 확장 폴더 하나(기본 프로필) 또는 여러 출처(다른 프로필)에서 설치 목록을 읽는다. */
export async function readInstalledExtensions(from: string | CatalogSource[]): Promise<InstalledExtension[]> {
  const sources: CatalogSource[] = typeof from === 'string' ? [{ index: path.join(from, 'extensions.json'), baseDir: from }] : from;
  const key = sources.map((s) => `${s.index}|${s.applicationScopedOnly ? 1 : 0}`).join(';');
  let stamp = '';
  try {
    for (const s of sources) {
      const st = await fs.promises.stat(s.index);
      const obsolete = await fs.promises.stat(path.join(s.baseDir, '.obsolete')).catch(() => undefined);
      stamp += `${st.mtimeMs}:${st.size}:${obsolete?.mtimeMs ?? 0};`;
    }
  } catch {
    return [];
  }
  if (!cache || cache.key !== key || cache.stamp !== stamp) {
    const list = scanInstalledExtensions(sources);
    cache = { key, stamp, list };
    list.catch(() => {
      if (cache?.list === list) cache = undefined;
    });
  }
  return cache.list;
}

/**
 * 이 창이 쓰는 프로필의 확장 목록 출처. globalStorage 경로가 .../User/profiles/<id>/globalStorage/...이면 그 프로필이다.
 * 다른 프로필은 자기 extensions.json에 더해 기본 목록의 "모든 프로필에 적용" 확장도 쓴다.
 */
export function catalogSourcesFor(extensionsDir: string, globalStoragePath: string): CatalogSource[] {
  const defaultSource: CatalogSource = { index: path.join(extensionsDir, 'extensions.json'), baseDir: extensionsDir };
  const m = /^(.*[\\/]User)[\\/]profiles[\\/]([^\\/]+)[\\/]globalStorage(?:[\\/]|$)/.exec(globalStoragePath);
  if (!m) return [defaultSource];
  return [
    { index: path.join(m[1], 'profiles', m[2], 'extensions.json'), baseDir: extensionsDir },
    { ...defaultSource, applicationScopedOnly: true },
  ];
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
