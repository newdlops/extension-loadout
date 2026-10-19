// Extension Loadout의 중심: 상태 읽기, 변경 저장, 적용(지금 재시작 / 종료할 때), 되돌리기, 다른 폴더에 적용.
// 화면(트리·상태 표시줄·대시보드)과 명령은 모두 이 클래스를 거친다.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActivationLog, Activated, causesOf, chainKeyOf, startedBy } from './activations';
import { InstalledExtension, restartCommandFor } from './catalog';
import { dependentsOf, missingDependencies, packMembers } from './deps';
import { LearnedEntry, LearnedSuggestion, MARKER_GLOB, learnedSuggestions, recordDecision, signatureOf } from './learning';
import { RepoRecommendations, mergeRecommendations, parseRecommendations } from './repoRecs';
import { VENDORED_DIRS } from './recommend';
import { StorageEntry, gitWorktrees, latestStoragePerFolder, listWorkspaceStorages, samePath } from './folders';
import { HistoryEntry, KEYS, pushHistory, undoTargets } from './history';
import {
  LoadoutChange,
  LoadoutRules,
  Override,
  Overrides,
  changesFromSelection,
  editLoadoutText,
  serializeRules,
  normalizeId,
  overridesFromStored,
  parseStoredIdentifiers,
  storedValuesFor,
} from './loadout';
import { ExtensionRow, LoadoutModel, LoadoutSnapshot, LoadoutStatus } from './model';
import type { PlanTarget } from './plan';
import type { Suggestion } from './recommend';
import { Pressure, PressureLevel, rank, readPressure, shouldNotify } from './pressure';
import { ExtMemory, formatBytes, measureExtensions } from './processes';
import { cancelOnQuit, ensureQuitHelper, logPath, pendingOnQuit, restartNow, scheduleOnQuit } from './restart';
import { readItems } from './stateDb';
import { computeSuggestions } from './suggestions';
import { pressureText, startsText } from './text';
import { LoadoutTree, Node, summaryOf } from './tree';

const t = vscode.l10n.t;
const HISTORY_KEY = 'extensionLoadout.history';
const PRESETS_KEY = 'extensionLoadout.presets';
const LEARNED_KEY = 'extensionLoadout.learned';
const VIEW_KEY = 'extensionLoadout.viewOptions';
const NOTIFIED_KEY = 'extensionLoadout.pressureNotified';

export interface Preset {
  name: string;
  rules: LoadoutRules;
  savedAt: number;
}

export interface ViewOptions {
  show: 'all' | 'running' | 'always' | 'memory';
  sort: 'name' | 'memory';
}

/** 의존 관계 확인을 어떻게 할지. ask: 물어본다, all: 묻지 않고 함께, only: 묻지 않고 요청한 것만. */
export type CascadeMode = 'ask' | 'all' | 'only';
const plural = (n: number) => (n === 1 ? t('1 extension') : t('{0} extensions', n));

export class LoadoutController implements vscode.Disposable {
  readonly model: LoadoutModel;
  readonly output: vscode.LogOutputChannel;
  readonly tree: LoadoutTree;
  private readonly status: vscode.StatusBarItem;
  private readonly views: vscode.TreeView<Node>[];
  private readonly disposables: vscode.Disposable[] = [];
  private suggestions?: Promise<Suggestion[]>;
  private lastStatus?: LoadoutStatus;
  private readonly changed = new vscode.EventEmitter<void>();
  /** 상태가 바뀔 때(대시보드 갱신용). */
  readonly onDidChange = this.changed.event;
  private memory?: { list: ExtMemory[]; at: number };
  private measuring?: Promise<ExtMemory[]>;
  private pressure: Pressure = { level: 'normal', source: 'kernel', detail: '' };
  /** 이번 세션에서 알림을 띄운 가장 높은 압박 수준. */
  private notifiedLevel: PressureLevel = 'normal';
  private pressureTimer?: NodeJS.Timeout;
  private repo: RepoRecommendations = { recommended: new Set(), unwanted: new Set() };
  private learned: LearnedSuggestion[] = [];
  private signature?: Promise<string[]>;
  /** 이 창에서 확장이 켜진 이유(VS Code 확장 호스트 로그). */
  private readonly activationLog: ActivationLog;
  private activations = new Map<string, Activated>();
  /** 추천을 계산할 때 쓴 연쇄. 새 연쇄가 생기면 추천을 다시 계산한다. */
  private chainKey = '';
  /** 설치된 확장과 내장 확장(언어 서버 재시작 명령 찾기용). 메모리를 잴 때 채운다. */
  private catalog: InstalledExtension[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.model = new LoadoutModel(context);
    // 확장 호스트 로그는 이 확장의 로그 폴더 바로 위에 있다(…/window1/exthost/exthost.log).
    const hostLog = context.logUri.scheme === 'file' ? path.join(path.dirname(context.logUri.fsPath), 'exthost.log') : undefined;
    this.activationLog = new ActivationLog(hostLog, process.pid);
    this.output = vscode.window.createOutputChannel('Extension Loadout', { log: true });
    // 설치 목록 전체는 목록 화면이 그려질 때만 읽는다.
    this.tree = new LoadoutTree(async () => {
      if (!this.model.workspaceDbPath) return undefined;
      try {
        return await this.model.snapshot(this.lastStatus);
      } catch (e) {
        this.report(t('could not read the extension state'), e);
        return undefined;
      }
    });
    this.tree.setRestartLookup((id) => restartCommandFor(id, this.catalog));
    this.status = vscode.window.createStatusBarItem('extensionLoadout.status', vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Extension Loadout';
    const viewOptions = { treeDataProvider: this.tree, showCollapseAll: true, canSelectMany: true, manageCheckboxStateManually: true };
    // 전용 액티비티 바 패널과 탐색기 사이드바 양쪽에 같은 목록을 띄운다.
    this.views = [vscode.window.createTreeView('extensionLoadout.extensions', viewOptions), vscode.window.createTreeView('extensionLoadout.explorer', viewOptions)];
    for (const v of this.views) this.disposables.push(v, v.onDidChangeCheckboxState((e) => this.tree.toggle(e.items)));
    this.disposables.push(
      this.output,
      this.status,
      this.changed,
      vscode.window.registerFileDecorationProvider(this.tree),
      vscode.extensions.onDidChange(() => {
        this.suggestions = undefined;
        this.tree.invalidate();
      }),
      this.tree.onDidLoad((snap) => {
        for (const v of this.views) v.description = snap ? this.viewDescription(snap) : undefined;
        // 저장소 권장(원치 않음)을 읽은 뒤에 추천을 계산한다.
        if (snap)
          void this.loadRepoAndLearned(snap).then(() => {
            if (!this.suggestions) void this.findSuggestions(snap);
          });
        // 메모리는 화면이 그려질 때, 마지막으로 잰 지 1분이 지났을 때만 다시 잰다.
        if (snap && (!this.memory || Date.now() - this.memory.at > 60_000)) void this.measureMemory();
        if (snap) void this.refreshActivations();
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('extensionLoadout.memoryWatch')) this.startPressureWatch();
        if (e.affectsConfiguration('extensionLoadout.heavyThresholdMB')) this.tree.invalidate();
      }),
      { dispose: () => this.pressureTimer && clearInterval(this.pressureTimer) },
      this.tree.onDidChangeSelection((count) => {
        void vscode.commands.executeCommand('setContext', 'extensionLoadout.hasSelection', count > 0);
        for (const v of this.views) v.message = count ? t('{0} selected. Click "Turn Off Selected" (⊘) at the top to turn them off in this folder.', count) : undefined;
      }),
    );
    this.watchConfigFiles();
    this.startPressureWatch();
    // 프리셋은 Settings Sync로 다른 컴퓨터에도 가져간다.
    context.globalState.setKeysForSync([PRESETS_KEY, VIEW_KEY]);
    this.tree.setViewOptions(this.viewOptions());
    try {
      ensureQuitHelper(context);
    } catch (e) {
      this.output.warn(`Could not resume the apply-on-quit helper: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  report(what: string, e: unknown): void {
    this.output.error(what, e as Error);
    void vscode.window.showErrorMessage(t('Extension Loadout: {0}: {1}', what, (e as Error).message));
  }

  private watchConfigFiles(): void {
    const loc = this.model.location();
    for (const file of [loc.editable, ...loc.inputs.map((i) => i.file)].filter((f): f is string => !!f)) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
      w.onDidChange(() => void this.refresh());
      w.onDidCreate(() => void this.refresh());
      w.onDidDelete(() => void this.refresh());
      this.disposables.push(w);
    }
  }

  // -----------------------------------------------------------------------------------------
  // 상태

  /** loadout 파일과 작업 영역 저장소만 읽어 상태 표시줄을 갱신하고, 목록은 다음에 그릴 때 다시 읽게 한다. */
  async refresh(): Promise<LoadoutStatus | undefined> {
    let st: LoadoutStatus | undefined;
    try {
      st = this.model.workspaceDbPath ? await this.model.status() : undefined;
    } catch (e) {
      this.report(t('could not read the loadout'), e);
    }
    this.lastStatus = st;
    this.tree.invalidate();
    void vscode.commands.executeCommand('setContext', 'extensionLoadout.pending', !!st?.pending);
    void vscode.commands.executeCommand('setContext', 'extensionLoadout.applyOnQuit', this.scheduledHere());
    void vscode.commands.executeCommand('setContext', 'extensionLoadout.canUndo', this.history().length > 0);
    this.updateStatusBar(st);
    this.changed.fire();
    return st;
  }

  get current(): LoadoutStatus | undefined {
    return this.lastStatus;
  }

  /** 지금 화면에 쓸 전체 상태. */
  async snapshot(): Promise<LoadoutSnapshot | undefined> {
    const st = this.lastStatus ?? (await this.refresh());
    return st && this.model.workspaceDbPath ? this.model.snapshot(st) : undefined;
  }

  scheduledHere(): boolean {
    const db = this.model.workspaceDbPath;
    return !!db && pendingOnQuit(this.context).some((p) => samePath(p.dbPath, db));
  }

  private statusBarExtra(): { text: string; tooltip: string; command: string; warning: boolean } | undefined {
    if (this.pressure.level === 'normal') return undefined;
    const top = this.memory?.list.find((m) => m.bytes > 0);
    const name = top ? this.displayName(top.id) : undefined;
    return {
      text: `$(pulse) ${this.pressure.level === 'critical' ? t('Memory critical') : t('Memory tight')}${top ? ` · ${name} ${formatBytes(top.bytes)}` : ''}`,
      tooltip: `${pressureText(this.pressure)}\n${t('Click to see which extensions use memory in this window.')}`,
      command: 'extensionLoadout.showMemory',
      warning: true,
    };
  }

  private names = new Map<string, string>();
  displayName(id: string): string {
    return this.names.get(id) ?? id;
  }

  // -----------------------------------------------------------------------------------------
  // 메모리

  /** 이 창과 모든 창에서 확장이 띄운 프로세스의 메모리를 잰다(동시에 여러 번 부르면 한 번만 잰다). */
  measureMemory(): Promise<ExtMemory[]> {
    if (this.measuring) return this.measuring;
    this.measuring = (async () => {
      const started = Date.now();
      try {
        const exts = [...(await this.model.installed()), ...this.model.builtins()];
        this.catalog = exts;
        for (const e of exts) this.names.set(e.id, e.displayName);
        const list = await measureExtensions(
          exts.map((e) => ({ id: e.id, location: e.location })),
          process.pid,
          process.ppid,
        );
        this.memory = { list, at: Date.now() };
        this.tree.setMemory(list, exts.filter((e) => e.builtin));
        this.updateStatusBar();
        this.changed.fire();
        this.output.info(`Measured extension memory in ${Date.now() - started} ms: ${list.slice(0, 5).map((m) => `${m.id} ${formatBytes(m.bytes)}`).join(', ')}`);
        return list;
      } catch (e) {
        this.output.warn(`Could not measure extension memory: ${(e as Error).message}`);
        return [];
      } finally {
        this.measuring = undefined;
      }
    })();
    return this.measuring;
  }

  /** 메모리를 가장 많이 쓰는 것 가운데 이 폴더에서 끌 수 있는 확장. */
  async heaviestSwitchable(): Promise<string | undefined> {
    const snap = await this.snapshot();
    if (!snap) return undefined;
    const rows = new Map(snap.rows.map((r) => [r.id, r]));
    return this.memory?.list.find((m) => {
      const r = rows.get(m.id);
      return m.bytes > 0 && r && !r.locked && r.desiredOn && r.override !== 'on';
    })?.id;
  }

  memoryList(): ExtMemory[] {
    return this.memory?.list ?? [];
  }

  private startPressureWatch(): void {
    if (this.pressureTimer) clearInterval(this.pressureTimer);
    this.pressureTimer = undefined;
    const cfg = vscode.workspace.getConfiguration('extensionLoadout.memoryWatch');
    if (!cfg.get<boolean>('enabled', true)) {
      this.pressure = { level: 'normal', source: 'kernel', detail: '' };
      this.updateStatusBar();
      return;
    }
    const check = () => void this.checkPressure();
    this.pressureTimer = setInterval(check, 60_000);
    setTimeout(check, 5_000);
  }

  async checkPressure(): Promise<Pressure> {
    try {
      const p = await readPressure();
      const rose = rank(p.level) > rank(this.pressure.level);
      this.pressure = p;
      if (rose) await this.measureMemory();
      this.updateStatusBar();
      const notify = vscode.workspace.getConfiguration('extensionLoadout.memoryWatch').get<boolean>('notify', true);
      const last = this.context.globalState.get<{ level: PressureLevel; at: number }>(NOTIFIED_KEY);
      if (notify && shouldNotify(p.level, this.notifiedLevel, last, Date.now())) {
        this.notifiedLevel = p.level;
        void this.context.globalState.update(NOTIFIED_KEY, { level: p.level, at: Date.now() });
        const top = this.memory?.list.find((m) => m.bytes > 0);
        const msg = top
          ? t('Memory is tight. In this window, {0} uses {1}.', this.displayName(top.id), formatBytes(top.bytes))
          : t('Memory is tight.');
        // 끌 수 있는 가장 무거운 확장(설치된 확장, 이 폴더에서 일부러 켠 것이 아닌 것)은 바로 끄자고 제안한다.
        const offer = await this.heaviestSwitchable();
        const turnOff = offer ? t('Turn Off {0} Here', this.displayName(offer)) : undefined;
        const buttons = [...(turnOff ? [turnOff] : []), t('Show Memory'), t('Restart Extension Host'), t("Don't Show Again")];
        void vscode.window.showWarningMessage(msg, ...buttons).then(async (go) => {
          if (go && go === turnOff && offer) {
            const n = await this.set([offer], 'off');
            if (n) this.offerApply(t('Turned off {0} for this folder.', this.displayName(offer)));
          }
          if (go === t('Show Memory')) void this.showMemory();
          if (go === t('Restart Extension Host')) void this.restartExtensionHost();
          if (go === t("Don't Show Again")) void vscode.workspace.getConfiguration('extensionLoadout.memoryWatch').update('notify', false, vscode.ConfigurationTarget.Global);
        });
      }
    } catch (e) {
      this.output.warn(`Could not read memory pressure: ${(e as Error).message}`);
    }
    return this.pressure;
  }

  currentPressure(): Pressure {
    return this.pressure;
  }

  async showMemory(): Promise<void> {
    await vscode.commands.executeCommand('extensionLoadout.extensions.focus');
    await this.measureMemory();
  }

  /**
   * 확장의 언어 서버를 다시 시작한다(Pylance면 Python 확장의 python.analysis.restartLanguageServer).
   * 확장 호스트 전체를 다시 시작하지 않고 그 서버가 쌓은 메모리만 돌려받는다. 전후 메모리를 그대로 알려준다.
   */
  async restartServer(arg?: string | Node): Promise<{ command: string; before: number; after: number; beforePids: number[]; afterPids: number[] } | undefined> {
    let id = typeof arg === 'string' ? arg : arg?.kind === 'ext' ? arg.row.id : undefined;
    if (!id) {
      const list = (await this.measureMemory()).filter((m) => this.tree.restartCommand(m.id));
      if (!list.length) {
        void vscode.window.showInformationMessage(t('No language server in this window can be restarted.'));
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((m) => ({ label: this.displayName(m.id), description: formatBytes(m.bytes), id: m.id })),
        { title: t('Restart Language Server') },
      );
      if (!pick) return undefined;
      id = pick.id;
    }
    if (!this.catalog.length) await this.measureMemory();
    const command = restartCommandFor(id, this.catalog);
    if (!command) return undefined;
    const before = (await this.measureMemory()).find((m) => m.id === id);
    await vscode.commands.executeCommand(command);
    // 새 서버 프로세스가 보일 때까지(최대 20초) 기다렸다가 잰다.
    let after: ExtMemory | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      after = (await this.measureMemory()).find((m) => m.id === id);
      if (after?.pids.some((p) => !before?.pids.includes(p))) break;
    }
    const name = this.displayName(id);
    this.output.info(`Restarted ${id} with ${command}: ${formatBytes(before?.bytes ?? 0)} → ${formatBytes(after?.bytes ?? 0)}`);
    void vscode.window.showInformationMessage(
      t('Restarted the language server of {0}: {1} before, {2} now. It grows again while it reads the folder.', name, formatBytes(before?.bytes ?? 0), formatBytes(after?.bytes ?? 0)),
    );
    return { command, before: before?.bytes ?? 0, after: after?.bytes ?? 0, beforePids: before?.pids ?? [], afterPids: after?.pids ?? [] };
  }

  async restartExtensionHost(confirm = true): Promise<void> {
    if (confirm) {
      const go = await vscode.window.showWarningMessage(
        t('Restart the extension host of this window?'),
        {
          modal: true,
          detail: t('All extensions and language servers in this window restart and give their memory back. Open editors and unsaved changes stay. Running debug sessions and extension state such as a REPL are lost.'),
        },
        t('Restart Extension Host'),
      );
      if (go !== t('Restart Extension Host')) return;
    }
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  }

  updateStatusBar(st = this.lastStatus): void {
    const s = this.status;
    s.backgroundColor = undefined;
    if (st?.pending && !this.scheduledHere()) {
      s.text = `$(debug-restart) ${t('Loadout: restart to apply')}`;
      s.tooltip = t("This folder's extension loadout changed. Click to apply it.");
      s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      s.command = 'extensionLoadout.applyMenu';
      s.show();
      return;
    }
    if (this.scheduledHere()) {
      s.text = `$(clock) ${t('Loadout: applies when VS Code quits')}`;
      s.tooltip = t('The loadout is applied the next time you quit VS Code. Click to apply now or cancel.');
      s.command = 'extensionLoadout.applyMenu';
      s.show();
      return;
    }
    const extra = this.statusBarExtra();
    if (extra) {
      s.text = extra.text;
      s.tooltip = extra.tooltip;
      s.command = extra.command;
      if (extra.warning) s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      s.show();
      return;
    }
    if (st?.configExists && st.overrides.size) {
      // 이 폴더에 전용 설정이 있으면 몇 개를 켜고 껐는지 늘 보이게 한다. 누르면 목록을 연다.
      const on = [...st.overrides.values()].filter((v) => v === 'on').length;
      s.text = `$(checklist) ${t('{0} on · {1} off', on, st.overrides.size - on)}`;
      s.tooltip = t('Extension Loadout: extensions turned on / off only in this folder. Click to show them.');
      s.command = 'extensionLoadout.extensions.focus';
      s.show();
      return;
    }
    s.hide();
  }

  async requireWorkspace(): Promise<LoadoutStatus | undefined> {
    const st = await this.refresh();
    if (!st || !this.model.configPath) {
      void vscode.window.showWarningMessage(t('Open a local folder to set up its extension loadout.'));
      return undefined;
    }
    return st;
  }

  // -----------------------------------------------------------------------------------------
  // 변경

  /** 확장별 변경을 저장한다. 바뀐 개수를 돌려준다. 이후 기능(의존 관계 등)이 changesFor를 덮어써 넓힌다. */
  async applyChanges(changes: LoadoutChange[]): Promise<number> {
    const st = await this.requireWorkspace();
    if (!st) return 0;
    const real = changes
      .map((c) => ({ id: normalizeId(c.id), value: c.value }))
      .filter((c) => c.id !== this.model.selfId && st.overrides.get(c.id) !== c.value);
    if (!real.length) return 0;
    await this.model.save(real, st);
    await this.refresh();
    return real.length;
  }

  /** "켬/끔/전역 따름" 요청을 저장할 변경으로. 전역 설정과 같은 상태로 강제하는 것은 전역 따름으로 정리한다. */
  async set(ids: string[], value: Override | undefined, mode: CascadeMode = 'ask'): Promise<number> {
    const globallyDisabled = await this.model.readGloballyDisabled();
    const changes = [...new Set(ids.map(normalizeId))].map((id) => ({
      id,
      value: value === undefined || (value === 'on') === !globallyDisabled.has(id) ? undefined : value,
    }));
    return this.applyChanges(await this.expandChanges(changes, mode));
  }

  /**
   * 의존 관계로 변경을 넓힌다.
   * - 끄는 확장을 필요로 하는 켜진 확장이 있으면 함께 끌지 묻는다(그대로 두면 VS Code에서 동작하지 못한다).
   * - 확장 팩을 끄면 팩에 든 확장도 끌지 묻는다.
   * - 켜는 확장이 필요로 하는 확장과, 켜는 팩의 확장은 함께 켠다.
   */
  async expandChanges(changes: LoadoutChange[], mode: CascadeMode = 'ask'): Promise<LoadoutChange[]> {
    const snap = await this.snapshot();
    if (!snap) return changes;
    const out = new Map(changes.map((c) => [c.id, c]));
    // 바뀐 뒤의 상태로 판단한다.
    const after = snap.rows.map((r) => {
      const c = out.get(r.id);
      const override = c ? c.value : r.override;
      return { ...r, desiredOn: override ? override === 'on' : r.globallyEnabled };
    });
    const byId = new Map(after.map((r) => [r.id, r]));
    const offFor = (id: string): LoadoutChange => ({ id, value: byId.get(id)?.globallyEnabled ? 'off' : undefined });
    const onFor = (id: string): LoadoutChange => ({ id, value: byId.get(id)?.globallyEnabled ? undefined : 'on' });
    const name = (id: string) => byId.get(id)?.displayName ?? id;
    const turningOff = [...out.values()].filter((c) => !(byId.get(c.id)?.desiredOn ?? true)).map((c) => c.id);
    const turningOn = [...out.values()].filter((c) => byId.get(c.id)?.desiredOn).map((c) => c.id);

    const dependents = dependentsOf(after, turningOff);
    if (dependents.length) {
      let choice: 'all' | 'only' | undefined = mode === 'ask' ? undefined : mode;
      if (mode === 'ask') {
        const all = t('Turn Them Off Too');
        const only = t('Only the Ones I Chose');
        const go = await vscode.window.showWarningMessage(
          t('{0} is needed by other extensions that are on here.', turningOff.map(name).join(', ')),
          { modal: true, detail: t('{0} cannot work without it. Turn them off too?', dependents.map(name).join(', ')) },
          all,
          only,
        );
        if (!go) return [];
        choice = go === all ? 'all' : 'only';
      }
      if (choice === 'all') for (const id of dependents) out.set(id, offFor(id));
    }

    const members = packMembers(after, turningOff, false).filter((m) => !out.has(m));
    if (members.length) {
      let withMembers = mode === 'all';
      if (mode === 'ask') {
        const yes = t('Pack and Its Extensions');
        const go = await vscode.window.showInformationMessage(
          t('Also turn off the {0} extensions in this pack?', members.length),
          { modal: true, detail: members.map(name).join(', ') },
          yes,
          t('Only the Pack'),
        );
        if (!go) return [];
        withMembers = go === yes;
      }
      if (withMembers) for (const id of members) out.set(id, offFor(id));
    }

    const needed = [...missingDependencies(after, turningOn), ...packMembers(after, turningOn, true)].filter((id) => !out.has(id));
    if (needed.length) {
      for (const id of needed) out.set(id, onFor(id));
      if (mode === 'ask') void vscode.window.showInformationMessage(t('Also turned on {0}, which {1} need.', needed.map(name).join(', '), turningOn.map(name).join(', ')));
    }
    return [...out.values()];
  }

  /** 여러 개를 바꾼 뒤에는 적용 안내를 한 번 띄운다(기다리지 않는다). */
  offerApply(message: string): void {
    if (!this.lastStatus?.pending) return;
    void vscode.window.showInformationMessage(`${message} ${t('Apply it now?')}`, t('Apply and Restart'), t('Apply When VS Code Quits'), t('Later')).then((go) => {
      if (go === t('Apply and Restart')) void this.applyNow();
      if (go === t('Apply When VS Code Quits')) void this.applyOnQuit();
    });
  }

  async pick(): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st) return;
    const s = await this.model.snapshot(st);
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = s.rows
      .filter((r) => !r.locked)
      .map((r) => ({
        id: r.id,
        label: r.displayName,
        description: r.id,
        detail:
          (r.override === 'on' ? t('ON in this folder') : r.override === 'off' ? t('OFF in this folder') : t('Same as global')) +
          ` · ${r.globallyEnabled ? t('on globally') : t('off globally')} · ${startsText(r.activation, r.packMembers.length)}`,
        picked: r.desiredOn,
      }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      title: t('Extensions to run in this folder'),
      placeHolder: t('Checked extensions run here. Unchecked ones are turned off here.'),
    });
    if (!chosen) return;
    const changes = changesFromSelection(
      s.rows.filter((r) => !r.locked),
      new Set(chosen.map((c) => c.id)),
      st.overrides,
    );
    const n = await this.applyChanges(await this.expandChanges(changes));
    if (n) this.offerApply(t('Loadout saved.'));
  }

  // -----------------------------------------------------------------------------------------
  // 적용

  private async uuidOf(): Promise<(id: string) => string | undefined> {
    const installed = await this.model.installed();
    const map = new Map(installed.map((e) => [e.id, e.uuid]));
    return (id) => map.get(id);
  }

  /** 이 창(과 고른 다른 폴더들)에 쓸 계획. 모두 이 창의 loadout을 그대로 쓴다. */
  async targetsFor(others: StorageEntry[] = []): Promise<PlanTarget[] | undefined> {
    const st = await this.requireWorkspace();
    if (!st) return undefined;
    if (st.configErrors.some((e) => /Not valid JSON|must be/.test(e))) {
      void vscode.window.showErrorMessage(t('Fix the loadout file first: {0}', st.configErrors[0]));
      return undefined;
    }
    // 파일이 없던 폴더는 지금 상태로 파일을 만든다(이후 변경의 기준이 되도록).
    if (!st.configExists) await this.model.save([], st);
    const items = storedValuesFor(st.overrides, await this.uuidOf());
    const here: PlanTarget = { dbPath: this.model.workspaceDbPath!, items, label: vscode.workspace.name ?? 'this folder' };
    return [here, ...others.filter((o) => !samePath(o.dbPath, here.dbPath)).map((o) => ({ dbPath: o.dbPath, items, label: path.basename(o.folder) }))];
  }

  private recordHistory(label: string, targets: PlanTarget[]): void {
    const entry: HistoryEntry = {
      time: Date.now(),
      label,
      targets: targets.map((tg) => ({ dbPath: tg.dbPath, label: tg.label, before: this.readBefore(tg.dbPath) })),
    };
    const configPath = this.model.configPath;
    if (configPath) entry.config = { path: configPath, before: this.context.workspaceState.get<string | null>('extensionLoadout.appliedText', null) };
    void this.context.globalState.update(HISTORY_KEY, pushHistory(this.history(), entry));
    void this.context.workspaceState.update('extensionLoadout.appliedText', this.model.readConfigText() ?? null);
    this.afterApply(targets);
  }

  /** 적용할 때마다 이 폴더의 스택과 결정을 기록해 비슷한 폴더에서 제안한다. */
  private afterApply(_targets: PlanTarget[]): void {
    const folder = this.model.workspaceFolder;
    const st = this.lastStatus;
    if (!folder || !st) return;
    void this.folderSignature().then((signature) => {
      if (!signature.length) return;
      const entry: LearnedEntry = {
        folder: folder.uri.fsPath,
        name: folder.name,
        signature,
        off: [...st.overrides].filter(([, v]) => v === 'off').map(([id]) => id),
        on: [...st.overrides].filter(([, v]) => v === 'on').map(([id]) => id),
        time: Date.now(),
      };
      void this.context.globalState.update(LEARNED_KEY, recordDecision(this.learnedEntries(), entry, (a, b) => samePath(a, b)));
    });
  }

  learnedEntries(): LearnedEntry[] {
    return this.context.globalState.get<LearnedEntry[]>(LEARNED_KEY, []);
  }

  /** 이 폴더의 스택(표식 파일). 창마다 한 번만 찾는다. */
  folderSignature(): Promise<string[]> {
    if (!this.signature) {
      this.signature = Promise.resolve(vscode.workspace.findFiles(MARKER_GLOB, VENDORED_DIRS, 300)).then(
        (uris) => signatureOf(uris.map((u) => vscode.workspace.asRelativePath(u, false))),
        (): string[] => [],
      );
    }
    return this.signature;
  }

  /** 저장소 권장(extensions.json)과 내 결정에서 배운 제안을 읽어 화면에 넘긴다. */
  private async loadRepoAndLearned(snap: LoadoutSnapshot): Promise<void> {
    const texts: { text: string; ws: boolean }[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      try {
        texts.push({ text: await fs.promises.readFile(path.join(f.uri.fsPath, '.vscode', 'extensions.json'), 'utf8'), ws: false });
      } catch {
        // 없음
      }
    }
    const wf = vscode.workspace.workspaceFile;
    if (wf?.scheme === 'file') {
      try {
        texts.push({ text: await fs.promises.readFile(wf.fsPath, 'utf8'), ws: true });
      } catch {
        // 없음
      }
    }
    this.repo = mergeRecommendations(texts.map((x) => parseRecommendations(x.text, x.ws)));
    const folder = this.model.workspaceFolder;
    const sig = await this.folderSignature();
    this.learned = folder ? learnedSuggestions(this.learnedEntries(), sig, folder.uri.fsPath, snap.rows, (a, b) => samePath(a, b)) : [];
    this.tree.setRepoAndLearned(this.repo, this.learned);
    this.changed.fire();
  }

  repoRecommendations(): RepoRecommendations {
    return this.repo;
  }

  learnedList(): LearnedSuggestion[] {
    return this.learned;
  }

  // -----------------------------------------------------------------------------------------
  // 프리셋

  presets(): Preset[] {
    return this.context.globalState.get<Preset[]>(PRESETS_KEY, []);
  }

  async savePreset(name?: string): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st) return;
    const presetName =
      name ??
      (await vscode.window.showInputBox({
        title: t('Save this loadout as a preset'),
        prompt: t('Presets can be applied to any folder and follow you through Settings Sync.'),
        value: vscode.workspace.name ?? '',
        validateInput: (v) => (v.trim() ? undefined : t('Enter a name.')),
      }));
    if (!presetName?.trim()) return;
    const rules: LoadoutRules = st.configExists
      ? { enable: [...st.rules.enable], disable: [...st.rules.disable], notes: { ...st.rules.notes } }
      : {
          enable: [...st.overrides].filter(([, v]) => v === 'on').map(([id]) => id),
          disable: [...st.overrides].filter(([, v]) => v === 'off').map(([id]) => id),
          notes: {},
        };
    const others = this.presets().filter((p) => p.name !== presetName.trim());
    await this.context.globalState.update(PRESETS_KEY, [...others, { name: presetName.trim(), rules, savedAt: Date.now() }].sort((a, b) => a.name.localeCompare(b.name)));
    void vscode.window.showInformationMessage(t('Saved preset "{0}".', presetName.trim()));
  }

  async applyPreset(name?: string): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st) return;
    const list = this.presets();
    if (!list.length) {
      void vscode.window.showInformationMessage(t('No presets yet. Use "Save Loadout as Preset" first.'));
      return;
    }
    const preset =
      list.find((p) => p.name === name) ??
      (
        await vscode.window.showQuickPick(
          list.map((p) => ({
            label: p.name,
            description: t('{0} on · {1} off', p.rules.enable.length, p.rules.disable.length),
            detail: [...p.rules.enable.map((x) => `+${x}`), ...p.rules.disable.map((x) => `−${x}`)].slice(0, 8).join('  '),
            preset: p,
          })),
          { title: t('Apply a preset to this folder'), placeHolder: t('Replaces this folder\'s loadout file.') },
        )
      )?.preset;
    if (!preset) return;
    await this.model.writeConfigText(serializeRules(preset.rules));
    await this.refresh();
    this.offerApply(t('Applied preset "{0}" to the loadout file.', preset.name));
  }

  async deletePreset(): Promise<void> {
    const list = this.presets();
    const pick = await vscode.window.showQuickPick(list.map((p) => ({ label: p.name, preset: p })), { title: t('Delete a preset') });
    if (!pick) return;
    await this.context.globalState.update(PRESETS_KEY, list.filter((p) => p !== pick.preset));
  }

  // -----------------------------------------------------------------------------------------
  // 보기 옵션

  viewOptions(): ViewOptions {
    return { show: 'all', sort: 'name', ...this.context.globalState.get<Partial<ViewOptions>>(VIEW_KEY, {}) };
  }

  async setViewOptions(next: Partial<ViewOptions>): Promise<void> {
    const opts = { ...this.viewOptions(), ...next };
    await this.context.globalState.update(VIEW_KEY, opts);
    this.tree.setViewOptions(opts);
    const snap = await this.snapshot();
    for (const v of this.views) v.description = snap ? this.viewDescription(snap) : undefined;
    if (opts.show === 'memory' || opts.sort === 'memory') void this.measureMemory();
  }

  async chooseViewOptions(): Promise<void> {
    const cur = this.viewOptions();
    const mark = (on: boolean) => (on ? '$(check) ' : '$(blank) ');
    type Item = vscode.QuickPickItem & { apply?: Partial<ViewOptions> };
    const items: Item[] = [
      { label: t('Show'), kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(cur.show === 'all')}${t('All extensions')}`, apply: { show: 'all' } },
      { label: `${mark(cur.show === 'running')}${t('Running in this window')}`, apply: { show: 'running' } },
      { label: `${mark(cur.show === 'always')}${t('Start in every window (⚡ always)')}`, apply: { show: 'always' } },
      { label: `${mark(cur.show === 'memory')}${t('Using memory now')}`, apply: { show: 'memory' } },
      { label: t('Sort'), kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(cur.sort === 'name')}${t('By name')}`, apply: { sort: 'name' } },
      { label: `${mark(cur.sort === 'memory')}${t('By memory, biggest first')}`, apply: { sort: 'memory' } },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: t('Extension Loadout view') });
    if (pick?.apply) await this.setViewOptions(pick.apply);
  }

  private viewDescription(snap: LoadoutSnapshot): string {
    const opts = this.viewOptions();
    const show = { all: '', running: t('running only'), always: t('⚡ always only'), memory: t('using memory only') }[opts.show];
    return [summaryOf(snap), show, opts.sort === 'memory' ? t('by memory') : ''].filter(Boolean).join(' · ');
  }

  private readBefore(dbPath: string): Record<string, string | null> {
    try {
      const v = readItems(dbPath, KEYS);
      return Object.fromEntries(KEYS.map((k) => [k, v[k] ?? null]));
    } catch {
      return Object.fromEntries(KEYS.map((k) => [k, null]));
    }
  }

  history(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  async applyNow(others: StorageEntry[] = []): Promise<void> {
    const targets = await this.targetsFor(others);
    if (!targets) return;
    try {
      this.recordHistory(others.length ? t('Applied to {0} folders', targets.length) : t('Applied'), targets);
      this.output.info(`Applying now: ${targets.map((x) => `${x.label} ${JSON.stringify(x.items)}`).join(' | ')}`);
      await restartNow(this.context, targets);
    } catch (e) {
      this.output.error('Restart failed', e as Error);
      void vscode.window.showErrorMessage(t('Could not restart VS Code: {0} (log: {1})', (e as Error).message, logPath()));
    }
  }

  async applyOnQuit(others: StorageEntry[] = []): Promise<void> {
    const targets = await this.targetsFor(others);
    if (!targets) return;
    try {
      this.recordHistory(t('Applied when VS Code quit'), targets);
      scheduleOnQuit(this.context, targets);
      this.output.info(`Scheduled on quit: ${targets.map((x) => x.label).join(', ')}`);
      await this.refresh();
      void vscode.window.showInformationMessage(t('The loadout will be applied when you quit VS Code. Keep working; nothing restarts now.'));
    } catch (e) {
      this.report(t('could not schedule the loadout'), e);
    }
  }

  async cancelApplyOnQuit(): Promise<void> {
    const db = this.model.workspaceDbPath;
    if (!db) return;
    cancelOnQuit(this.context, [db]);
    // 예약할 때 남긴 기록은 실제로 적용되지 않으므로 지운다.
    const list = this.history();
    if (list[0]?.targets.some((x) => samePath(x.dbPath, db))) await this.context.globalState.update(HISTORY_KEY, list.slice(1));
    await this.refresh();
  }

  /** 상태 표시줄을 눌렀을 때: 지금 재시작 / 종료할 때 / 취소. */
  async applyMenu(): Promise<void> {
    const scheduled = this.scheduledHere();
    const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = [
      { label: `$(debug-restart) ${t('Apply and Restart VS Code')}`, detail: t('VS Code closes and reopens your windows in a few seconds.'), run: () => this.applyNow() },
    ];
    if (!scheduled) items.push({ label: `$(clock) ${t('Apply When VS Code Quits')}`, detail: t('Nothing restarts now; the loadout is applied the next time you quit VS Code.'), run: () => this.applyOnQuit() });
    else items.push({ label: `$(close) ${t('Cancel Apply on Quit')}`, run: () => this.cancelApplyOnQuit() });
    items.push({ label: `$(folder-library) ${t('Apply to Other Folders…')}`, detail: t('Also apply to other worktrees or folders of yours, with one restart.'), run: () => this.applyToOtherFolders() });
    const pick = await vscode.window.showQuickPick(items, { title: t('Apply the loadout') });
    await pick?.run();
  }

  // -----------------------------------------------------------------------------------------
  // 되돌리기 · 초기화

  async undo(confirm = true): Promise<void> {
    const [entry, ...rest] = this.history();
    if (!entry) {
      void vscode.window.showInformationMessage(t('There is nothing to undo.'));
      return;
    }
    if (confirm) {
      const when = new Date(entry.time).toLocaleString();
      const names = entry.targets.map((x) => x.label ?? path.basename(path.dirname(x.dbPath))).join(', ');
      const go = await vscode.window.showWarningMessage(
        t('Undo "{0}" from {1}?', entry.label, when),
        { modal: true, detail: t('Restores the extension state of: {0}. VS Code restarts.', names) },
        t('Undo and Restart'),
      );
      if (go !== t('Undo and Restart')) return;
    }
    await this.context.globalState.update(HISTORY_KEY, rest);
    if (entry.config && this.model.configPath && samePath(entry.config.path, this.model.configPath)) {
      const here = entry.targets.find((x) => this.model.workspaceDbPath && samePath(x.dbPath, this.model.workspaceDbPath));
      let text = entry.config.before;
      // 직전 파일 내용을 모르면 직전 저장소 값으로 파일을 만든다.
      if (text === null && here) {
        const before = overridesFromStored(parseStoredIdentifiers(here.before[KEYS[0]]), parseStoredIdentifiers(here.before[KEYS[1]]));
        text = editLoadoutText(undefined, [...before].map(([id, value]) => ({ id, value })));
      }
      if (text !== null) await this.model.writeConfigText(text);
      await this.context.workspaceState.update('extensionLoadout.appliedText', text);
    }
    try {
      await restartNow(this.context, undoTargets(entry));
    } catch (e) {
      this.report(t('could not restart VS Code'), e);
    }
  }

  async resetToGlobal(): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st || !st.overrides.size) {
      void vscode.window.showInformationMessage(t('This folder already follows the global setting.'));
      return;
    }
    const go = await vscode.window.showWarningMessage(
      t('Make every extension in this folder follow the global setting?'),
      { modal: true, detail: t('Removes {0} folder-specific choices from the loadout file.', st.overrides.size) },
      t('Reset'),
    );
    if (go !== t('Reset')) return;
    const n = await this.applyChanges([...st.overrides.keys()].map((id) => ({ id, value: undefined })));
    if (n) this.offerApply(t('Reset {0}.', plural(n)));
  }

  // -----------------------------------------------------------------------------------------
  // 다른 폴더에 적용

  async otherFolderCandidates(): Promise<{ worktrees: StorageEntry[]; others: StorageEntry[]; neverOpened: string[] }> {
    const root = this.model.workspaceStorageRoot;
    const here = this.model.workspaceFolder?.uri.fsPath;
    const storages = root ? latestStoragePerFolder(await listWorkspaceStorages(root, (u) => vscode.Uri.parse(u).fsPath)) : [];
    const trees = here ? await gitWorktrees(here) : [];
    const isHere = (p: string) => !!here && samePath(p, here);
    const worktrees = storages.filter((s) => trees.some((w) => samePath(w, s.folder)) && !isHere(s.folder));
    const neverOpened = trees.filter((w) => !isHere(w) && !storages.some((s) => samePath(s.folder, w)));
    const others = storages.filter((s) => !worktrees.includes(s) && !isHere(s.folder) && fs.existsSync(s.folder));
    return { worktrees, others, neverOpened };
  }

  async applyToOtherFolders(): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st) return;
    const { worktrees, others, neverOpened } = await this.otherFolderCandidates();
    type Item = vscode.QuickPickItem & { entry?: StorageEntry };
    const items: Item[] = [];
    if (worktrees.length) items.push({ label: t('Worktrees of this repository'), kind: vscode.QuickPickItemKind.Separator });
    for (const e of worktrees) items.push({ label: path.basename(e.folder), description: e.folder, picked: true, entry: e });
    if (others.length) items.push({ label: t('Other folders you opened in VS Code'), kind: vscode.QuickPickItemKind.Separator });
    for (const e of others.slice(0, 60)) items.push({ label: path.basename(e.folder), description: e.folder, entry: e });
    if (!items.length) {
      void vscode.window.showInformationMessage(t('No other folders to apply to. VS Code keeps extension state only for folders it has opened.'));
      return;
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      title: t('Apply this loadout to other folders'),
      placeHolder: neverOpened.length
        ? t('{0} worktree(s) were never opened in VS Code and are not listed; open them once first.', neverOpened.length)
        : t('Only their VS Code extension state changes; their files are not touched.'),
    });
    const picked = (chosen ?? []).map((c) => c.entry).filter((e): e is StorageEntry => !!e);
    if (!chosen) return;
    const how = await vscode.window.showQuickPick(
      [
        { label: `$(debug-restart) ${t('Apply and Restart VS Code')}`, now: true },
        { label: `$(clock) ${t('Apply When VS Code Quits')}`, now: false },
      ],
      { title: t('Apply to this folder and {0} more', picked.length) },
    );
    if (!how) return;
    if (how.now) await this.applyNow(picked);
    else await this.applyOnQuit(picked);
  }

  // -----------------------------------------------------------------------------------------
  // 추천

  findSuggestions(snap: LoadoutSnapshot): Promise<Suggestion[]> {
    const p = this.activationLog
      .read()
      .then((acts) => {
        this.activations = acts;
        this.tree.setActivations(acts);
        const chains = startedBy(acts);
        this.chainKey = chainKeyOf(chains);
        return computeSuggestions(snap, this.output, chains);
      })
      .catch((e) => {
        this.output.error('Could not check which extensions this folder needs', e as Error);
        return [] as Suggestion[];
      })
      .then((list) => {
        // 저장소가 "원하지 않음"으로 적은 확장도 확실한 근거다.
        const seen = new Set(list.map((x) => x.id));
        const unwanted = snap.rows
          .filter((r) => this.repo.unwanted.has(r.id) && !seen.has(r.id) && r.desiredOn && r.override !== 'on' && !r.locked)
          .map((r) => ({ id: r.id, reason: t('This repository lists it under unwantedRecommendations') }));
        return [...list, ...unwanted];
      });
    this.suggestions = p;
    void p.then((list) => {
      this.tree.setSuggestions(list);
      this.changed.fire();
    });
    return p;
  }

  /**
   * 활성화 기록을 다시 읽는다(새로 붙은 줄만). 추천을 계산한 뒤에 새 연쇄가 생겼으면
   * (예: Markdown 파일을 열자 Ruff가 켜지고 Python·Pylance까지 켬) 추천을 다시 계산한다.
   */
  async refreshActivations(): Promise<Map<string, Activated>> {
    const acts = await this.activationLog.read();
    this.activations = acts;
    this.tree.setActivations(acts);
    if (this.suggestions && chainKeyOf(startedBy(acts)) !== this.chainKey) {
      const snap = await this.snapshot();
      if (snap) await this.findSuggestions(snap);
    }
    return acts;
  }

  /** 이 창에서 왜 켜졌는지(테스트·대시보드용): 확장 ID → 이벤트, 원인들(가까운 것부터). */
  activationInfo(): Map<string, { event: string; causes: string[] }> {
    return new Map([...this.activations.values()].map((a) => [a.id, { event: a.event, causes: causesOf(this.activations, a.id) }]));
  }

  async currentSuggestions(): Promise<Suggestion[]> {
    if (this.suggestions) return this.suggestions;
    const snap = await this.snapshot();
    if (!snap) return [];
    await this.loadRepoAndLearned(snap);
    return this.findSuggestions(snap);
  }

  async suggest(): Promise<void> {
    const st = await this.requireWorkspace();
    if (!st) return;
    await vscode.window.withProgress({ location: { viewId: 'extensionLoadout.extensions' } }, async () => {
      const list = await this.findSuggestions(await this.model.snapshot(st));
      if (!list.length) void vscode.window.showInformationMessage(t('Nothing here is certainly unneeded. Every extension that starts on its own could be used in this folder.'));
    });
    await vscode.commands.executeCommand('extensionLoadout.extensions.focus');
  }

  async turnOffSuggested(): Promise<void> {
    const ids = this.tree.activeSuggestions().map((x) => x.row.id);
    const n = await this.set(ids, 'off');
    if (n) this.offerApply(t('Turned off {0} for this folder.', plural(n)));
  }

  async turnOffLearned(): Promise<void> {
    const ids = this.tree.activeLearned().map((x) => x.row.id);
    const n = await this.set(ids, 'off');
    if (n) this.offerApply(t('Turned off {0} for this folder.', plural(n)));
  }

  async installRecommended(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
    this.tree.invalidate();
  }

  async turnOffSelected(): Promise<void> {
    const ids = this.tree.selectedIds();
    if (!ids.length) {
      void vscode.window.showInformationMessage(t('Select extensions with the checkboxes first.'));
      return;
    }
    const n = await this.set(ids, 'off');
    this.tree.clearSelection();
    if (n) this.offerApply(t('Turned off {0} for this folder.', plural(n)));
    else void vscode.window.showInformationMessage(t('The selected extensions are already off in this folder.'));
  }

  rowsOf(ids: string[], snap: LoadoutSnapshot | undefined): ExtensionRow[] {
    const byId = new Map(snap?.rows.map((r) => [r.id, r]) ?? []);
    return ids.map((id) => byId.get(id)).filter((r): r is ExtensionRow => !!r);
  }

  overrides(): Overrides {
    return this.lastStatus?.overrides ?? new Map();
  }
}
