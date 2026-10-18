// 현재 워크스페이스의 loadout 상태를 한곳에 모은다: 설치 목록, 전역 설정, 저장소에 적용된 값, loadout 파일, 실행 중인 확장.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { InstalledExtension, readInstalledExtensions } from './catalog';
import {
  DISABLED_KEY,
  ENABLED_KEY,
  Overrides,
  StoredIdentifier,
  isPending,
  normalizeId,
  overridesFromStored,
  parseLoadout,
  parseStoredIdentifiers,
  serializeLoadout,
} from './loadout';
import { readItems } from './stateDb';

export const LOADOUT_FILE = path.join('.vscode', 'extension-loadout.json');

export interface ExtensionRow extends InstalledExtension {
  globallyEnabled: boolean;
  override?: 'on' | 'off';
  desiredOn: boolean;
  /** 이 창의 확장 호스트에 올라와 있음(켜져 있음). */
  running: boolean;
  /** 실제로 활성화되어 코드가 돌고 있음. */
  active: boolean;
  /** 자기 자신은 끌 수 없다. */
  locked: boolean;
}

/** 상태 표시줄과 적용 여부 판단에 필요한 가벼운 상태. loadout 파일과 워크스페이스 저장소만 읽는다. */
export interface LoadoutStatus {
  overrides: Overrides;
  /** loadout 파일이 없으면 워크스페이스 저장소에 기록된 값에서 시작한다. */
  configExists: boolean;
  configErrors: string[];
  /** 파일과 워크스페이스 저장소가 달라 재시작이 필요한 상태. */
  pending: boolean;
}

/** 목록 화면용 전체 상태. 설치된 확장 매니페스트까지 읽는다. */
export interface LoadoutSnapshot extends LoadoutStatus {
  rows: ExtensionRow[];
  /** loadout에는 있지만 설치되지 않은 확장. */
  missing: string[];
}

export class LoadoutModel {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  get configPath(): string | undefined {
    const folder = this.workspaceFolder;
    return folder && folder.uri.scheme === 'file' ? path.join(folder.uri.fsPath, LOADOUT_FILE) : undefined;
  }

  /** 이 창의 워크스페이스 저장소. storageUri의 부모 폴더에 state.vscdb가 있다. */
  get workspaceDbPath(): string | undefined {
    const uri = this.context.storageUri;
    return uri ? path.join(path.dirname(uri.fsPath), 'state.vscdb') : undefined;
  }

  get globalDbPath(): string {
    return path.join(path.dirname(this.context.globalStorageUri.fsPath), 'state.vscdb');
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

  readStored(): { enabled: StoredIdentifier[]; disabled: StoredIdentifier[] } {
    const db = this.workspaceDbPath;
    if (!db || !fs.existsSync(db)) return { enabled: [], disabled: [] };
    const v = readItems(db, [ENABLED_KEY, DISABLED_KEY]);
    return { enabled: parseStoredIdentifiers(v[ENABLED_KEY]), disabled: parseStoredIdentifiers(v[DISABLED_KEY]) };
  }

  readGloballyDisabled(): Set<string> {
    if (!fs.existsSync(this.globalDbPath)) return new Set();
    const v = readItems(this.globalDbPath, [DISABLED_KEY])[DISABLED_KEY];
    return new Set(parseStoredIdentifiers(v).map((e) => normalizeId(e.id)));
  }

  status(): LoadoutStatus {
    const stored = this.readStored();
    let overrides = overridesFromStored(stored.enabled, stored.disabled);
    let configExists = false;
    let configErrors: string[] = [];
    const configPath = this.configPath;
    if (configPath && fs.existsSync(configPath)) {
      configExists = true;
      const parsed = parseLoadout(fs.readFileSync(configPath, 'utf8'));
      configErrors = parsed.errors;
      overrides = parsed.overrides;
    }
    return {
      overrides,
      configExists,
      configErrors,
      pending: configExists && configErrors.length === 0 && isPending(overrides, stored.enabled, stored.disabled),
    };
  }

  async snapshot(status: LoadoutStatus = this.status()): Promise<LoadoutSnapshot> {
    const { overrides } = status;
    const globallyDisabled = this.readGloballyDisabled();
    const loaded = new Map(vscode.extensions.all.map((e) => [normalizeId(e.id), e]));
    const installed = await readInstalledExtensions(this.extensionsDir());
    const rows: ExtensionRow[] = installed.map((ext) => {
      const globallyEnabled = !globallyDisabled.has(ext.id);
      const override = overrides.get(ext.id);
      const live = loaded.get(ext.id);
      return {
        ...ext,
        globallyEnabled,
        override,
        desiredOn: override ? override === 'on' : globallyEnabled,
        running: !!live,
        active: !!live?.isActive,
        locked: ext.id === this.selfId,
      };
    });
    const known = new Set(rows.map((r) => r.id));
    return { ...status, rows, missing: [...overrides.keys()].filter((id) => !known.has(id)) };
  }

  async save(overrides: Overrides): Promise<void> {
    const configPath = this.configPath;
    if (!configPath) throw new Error('Open a local folder first.');
    overrides.delete(this.selfId);
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, serializeLoadout(overrides), 'utf8');
  }
}
