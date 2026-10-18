// 현재 워크스페이스의 loadout 상태를 한곳에 모은다: 설치 목록, 전역 설정, 저장소에 적용된 값, loadout 파일, 실행 중인 확장.
//
// loadout 파일 위치
//  - 폴더 하나를 연 창: <폴더>/.vscode/extension-loadout.json
//  - 저장된 멀티 루트 작업 영역(.code-workspace): 그 옆의 <이름>.loadout.json을 고치고, 각 폴더의
//    .vscode/extension-loadout.json은 읽기만 해서 합친다(폴더끼리 다르면 켜는 쪽).
//  - 저장하지 않은 멀티 루트: 첫 폴더의 파일을 고치고 나머지 폴더 파일을 합친다.
// VS Code의 작업 영역별 확장 활성 상태는 창(작업 영역) 하나에 하나뿐이라, 폴더별로 다르게 적용할 수는 없다.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CatalogSource, InstalledExtension, extensionFromManifest, pickProfile, profileSources, readInstalledExtensions } from './catalog';
import {
  DISABLED_KEY,
  ENABLED_KEY,
  LayerValue,
  LoadoutChange,
  LoadoutRules,
  Override,
  Overrides,
  StoredIdentifier,
  editLoadoutText,
  emptyRules,
  hasPatterns,
  isPending,
  mergeLayers,
  noteFor,
  normalizeId,
  overridesFromStored,
  parseLoadoutRules,
  parseStoredIdentifiers,
  resolveRules,
} from './loadout';
import { readItems } from './stateDb';

export const LOADOUT_FILE = path.join('.vscode', 'extension-loadout.json');

export interface ExtensionRow extends InstalledExtension {
  globallyEnabled: boolean;
  override?: Override;
  desiredOn: boolean;
  /** 이 창의 확장 호스트에 올라와 있음(켜져 있음). */
  running: boolean;
  /** 실제로 활성화되어 코드가 돌고 있음. */
  active: boolean;
  /** 자기 자신은 끌 수 없다. */
  locked: boolean;
  /** loadout 파일의 메모. */
  note?: string;
  /** 패턴으로 정해졌으면 그 패턴. */
  via?: string;
  /** 멀티 루트에서 다른 폴더 파일로부터 물려받았으면 그 폴더 이름. */
  inheritedFrom?: string[];
}

/** 상태 표시줄과 적용 여부 판단에 필요한 가벼운 상태. loadout 파일과 워크스페이스 저장소만 읽는다. */
export interface LoadoutStatus {
  overrides: Overrides;
  /** loadout 파일이 하나라도 있는지. 없으면 워크스페이스 저장소에 기록된 값에서 시작한다. */
  configExists: boolean;
  configErrors: string[];
  /** 멀티 루트에서 폴더 파일끼리 부딪힌 설정. */
  conflicts: string[];
  /** 파일과 워크스페이스 저장소가 달라 재시작이 필요한 상태. */
  pending: boolean;
  /** 편집 대상 파일의 규칙(메모 포함). */
  rules: LoadoutRules;
  /** 확장별로 어느 패턴이 정했는지. */
  via: Map<string, string>;
  inherited: Map<string, { value: Override; from: string[] }>;
  notes: Record<string, string>;
}

/** 목록 화면용 전체 상태. 설치된 확장 매니페스트까지 읽는다. */
export interface LoadoutSnapshot extends LoadoutStatus {
  rows: ExtensionRow[];
  /** loadout에는 있지만 설치되지 않은 확장. */
  missing: string[];
}

export interface LoadoutLocation {
  /** 이 창에서 고치는 파일. */
  editable?: string;
  /** 읽기만 해서 합치는 파일(멀티 루트의 각 폴더). */
  inputs: { name: string; file: string }[];
}

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const readJsonFile = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

export class LoadoutModel {
  private profile?: Promise<string | undefined>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** .../User. 확장의 globalStorage는 프로필과 관계없이 User/globalStorage 아래에 있다. */
  get userDir(): string {
    return path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
  }

  /** 이 창의 VS Code 프로필 폴더 이름(기본 프로필이면 undefined). 창마다 한 번만 판별한다. */
  profileLocation(): Promise<string | undefined> {
    this.profile ??= this.detectProfile().catch(() => undefined);
    return this.profile;
  }

  private async detectProfile(): Promise<string | undefined> {
    const storage = readJsonFile<{
      userDataProfiles?: { location: string; name?: string }[];
      profileAssociations?: { workspaces?: Record<string, string> };
    }>(path.join(this.userDir, 'globalStorage', 'storage.json'));
    const profiles = storage?.userDataProfiles ?? [];
    if (!profiles.length) return undefined;
    // 1) 이 작업 영역에 프로필을 지정해 두었으면 그 기록을 쓴다.
    const key = (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString();
    const assoc = Object.entries(storage?.profileAssociations?.workspaces ?? {}).find(([k]) => key && vscode.Uri.parse(k).toString() === key)?.[1];
    if (assoc) return profiles.find((p) => p.location === assoc || path.basename(p.location) === assoc)?.location;
    // 2) 기록이 없으면(명령줄 --profile 등) 켜져 있는 확장으로 추론한다.
    const extDir = this.extensionsDir();
    const inDir = (p: string) => path.relative(extDir, p).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(extDir, p));
    const running = vscode.extensions.all.filter((e) => !e.packageJSON?.isBuiltin && inDir(e.extensionPath)).map((e) => normalizeId(e.id));
    const idsOf = (sources: CatalogSource[]) =>
      sources.flatMap((src) =>
        (readJsonFile<{ identifier?: { id?: string }; metadata?: { isApplicationScoped?: boolean } }[]>(src.index) ?? [])
          .filter((e) => !src.applicationScopedOnly || e.metadata?.isApplicationScoped)
          .map((e) => normalizeId(e.identifier?.id ?? ''))
          .filter(Boolean),
      );
    const candidates = [undefined, ...profiles.map((p) => p.location)].map((location) => ({ location, ids: idsOf(profileSources(extDir, this.userDir, location)) }));
    return pickProfile(candidates, running);
  }

  get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  location(): LoadoutLocation {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const fileOf = (f: vscode.WorkspaceFolder) => path.join(f.uri.fsPath, LOADOUT_FILE);
    const wf = vscode.workspace.workspaceFile;
    if (wf && wf.scheme === 'file') {
      const editable = path.join(path.dirname(wf.fsPath), `${path.basename(wf.fsPath).replace(/\.code-workspace$/i, '')}.loadout.json`);
      return { editable, inputs: folders.map((f) => ({ name: f.name, file: fileOf(f) })) };
    }
    if (!folders.length) return { inputs: [] };
    return { editable: fileOf(folders[0]), inputs: folders.slice(1).map((f) => ({ name: f.name, file: fileOf(f) })) };
  }

  get configPath(): string | undefined {
    return this.location().editable;
  }

  /** 이 창의 워크스페이스 저장소. storageUri의 부모 폴더에 state.vscdb가 있다. */
  get workspaceDbPath(): string | undefined {
    const uri = this.context.storageUri;
    return uri ? path.join(path.dirname(uri.fsPath), 'state.vscdb') : undefined;
  }

  /** 모든 작업 영역 저장소가 모인 폴더(.../User/workspaceStorage). */
  get workspaceStorageRoot(): string | undefined {
    const uri = this.context.storageUri;
    return uri ? path.dirname(path.dirname(uri.fsPath)) : undefined;
  }

  /** 전역 확장 활성 상태가 든 저장소. 다른 프로필은 그 프로필의 globalStorage에 있다. */
  async globalDbPath(): Promise<string> {
    const profile = await this.profileLocation();
    return profile ? path.join(this.userDir, 'profiles', profile, 'globalStorage', 'state.vscdb') : path.join(this.userDir, 'globalStorage', 'state.vscdb');
  }

  get selfId(): string {
    return normalizeId(this.context.extension.id);
  }

  /** 사용자 확장 폴더. 실행 중인 확장의 위치에서 찾고, 없으면 기본 위치를 쓴다. */
  extensionsDir(): string {
    for (const ext of vscode.extensions.all) {
      if (ext.packageJSON?.isBuiltin) continue;
      const dir = path.dirname(ext.extensionPath);
      if (fs.existsSync(path.join(dir, 'extensions.json'))) return dir;
    }
    const dataFolder = vscode.env.appName.includes('Insiders') ? '.vscode-insiders' : '.vscode';
    return path.join(os.homedir(), dataFolder, 'extensions');
  }

  async installed(): Promise<InstalledExtension[]> {
    return readInstalledExtensions(profileSources(this.extensionsDir(), this.userDir, await this.profileLocation()));
  }

  /** VS Code에 들어 있는 기본 확장(메모리 표시용). */
  builtins(): InstalledExtension[] {
    return vscode.extensions.all
      .filter((e) => e.packageJSON?.isBuiltin)
      .map((e) => extensionFromManifest(e.packageJSON, { id: e.id, location: e.extensionPath, builtin: true }));
  }

  readStored(dbPath = this.workspaceDbPath): { enabled: StoredIdentifier[]; disabled: StoredIdentifier[] } {
    if (!dbPath || !fs.existsSync(dbPath)) return { enabled: [], disabled: [] };
    const v = readItems(dbPath, [ENABLED_KEY, DISABLED_KEY]);
    return { enabled: parseStoredIdentifiers(v[ENABLED_KEY]), disabled: parseStoredIdentifiers(v[DISABLED_KEY]) };
  }

  async readGloballyDisabled(): Promise<Set<string>> {
    const db = await this.globalDbPath();
    if (!fs.existsSync(db)) return new Set();
    const v = readItems(db, [DISABLED_KEY])[DISABLED_KEY];
    return new Set(parseStoredIdentifiers(v).map((e) => normalizeId(e.id)));
  }

  async status(): Promise<LoadoutStatus> {
    const stored = this.readStored();
    const loc = this.location();
    const editableText = loc.editable ? readText(loc.editable) : undefined;
    const inputs = loc.inputs.map((i) => ({ ...i, text: readText(i.file) })).filter((i) => i.text !== undefined);
    const configErrors: string[] = [];
    const parsedEditable = editableText !== undefined ? parseLoadoutRules(editableText) : undefined;
    if (parsedEditable) configErrors.push(...parsedEditable.errors);
    const parsedInputs = inputs.map((i) => {
      const p = parseLoadoutRules(i.text!);
      configErrors.push(...p.errors.map((e) => `${i.name}: ${e}`));
      return { name: i.name, rules: p.rules };
    });
    const configExists = !!parsedEditable || parsedInputs.length > 0;
    const rules = parsedEditable?.rules ?? emptyRules();
    if (!configExists) {
      const overrides = overridesFromStored(stored.enabled, stored.disabled);
      return { overrides, configExists, configErrors, conflicts: [], pending: false, rules, via: new Map(), inherited: new Map(), notes: {} };
    }
    // 패턴이 있을 때만 설치 목록을 읽는다(없으면 가벼운 경로).
    const needIds = [rules, ...parsedInputs.map((p) => p.rules)].some(hasPatterns);
    const known = needIds ? (await this.installed()).map((e) => e.id) : [];
    const via = new Map<string, string>();
    const layer = (r: LoadoutRules) => {
      const res = resolveRules(r, known);
      configErrors.push(...res.errors);
      for (const [id, p] of res.via) if (p !== id) via.set(id, p);
      return res.values;
    };
    const merged = mergeLayers(
      parsedInputs.map((p) => ({ name: p.name, values: layer(p.rules) })),
      parsedEditable ? layer(rules) : undefined,
    );
    const notes = Object.assign({}, ...parsedInputs.map((p) => p.rules.notes), rules.notes) as Record<string, string>;
    const overrides = merged.overrides;
    overrides.delete(this.selfId);
    const blocking = configErrors.some((e) => /Not valid JSON|must be/.test(e));
    return {
      overrides,
      configExists,
      configErrors,
      conflicts: merged.conflicts,
      pending: !blocking && isPending(overrides, stored.enabled, stored.disabled),
      rules,
      via,
      inherited: merged.inherited,
      notes,
    };
  }

  async snapshot(status?: LoadoutStatus): Promise<LoadoutSnapshot> {
    const st = status ?? (await this.status());
    const { overrides } = st;
    const globallyDisabled = await this.readGloballyDisabled();
    const loaded = new Map(vscode.extensions.all.map((e) => [normalizeId(e.id), e]));
    const installed = await this.installed();
    const rows: ExtensionRow[] = installed.map((ext) => {
      const globallyEnabled = !globallyDisabled.has(ext.id);
      const override = overrides.get(ext.id);
      const live = loaded.get(ext.id);
      const inherited = st.inherited.get(ext.id);
      return {
        ...ext,
        globallyEnabled,
        override,
        desiredOn: override ? override === 'on' : globallyEnabled,
        running: !!live,
        active: !!live?.isActive,
        locked: ext.id === this.selfId,
        note: noteFor(st.notes, ext.id),
        via: st.via.get(ext.id),
        inheritedFrom: inherited && override === inherited.value ? inherited.from : undefined,
      };
    });
    const known = new Set(rows.map((r) => r.id));
    return { ...st, rows, missing: [...overrides.keys()].filter((id) => !known.has(id)) };
  }

  /** 변경을 편집 대상 파일에 반영한다. 패턴·메모·다른 내용은 보존한다. */
  async save(changes: LoadoutChange[], status?: LoadoutStatus): Promise<void> {
    const file = this.configPath;
    if (!file) throw new Error('Open a local folder first.');
    const st = status ?? (await this.status());
    // 파일이 아직 없으면 지금 적용된 상태(저장소)에서 시작한다.
    let base = readText(file);
    if (base === undefined && !st.configExists && st.overrides.size) {
      base = editLoadoutText(undefined, [...st.overrides].map(([id, value]) => ({ id, value })));
    }
    const inherited = new Map([...st.inherited].map(([id, x]) => [id, x.value]));
    const text = editLoadoutText(
      base,
      changes.filter((c) => normalizeId(c.id) !== this.selfId),
      inherited,
    );
    await this.writeConfigText(text);
  }

  async writeConfigText(text: string | undefined): Promise<void> {
    const file = this.configPath;
    if (!file) throw new Error('Open a local folder first.');
    if (text === undefined) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, 'utf8');
  }

  readConfigText(): string | undefined {
    return this.configPath ? readText(this.configPath) : undefined;
  }
}

export type { LayerValue };
