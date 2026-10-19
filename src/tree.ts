// 사이드바 목록.
//  - Memory in this window: 확장이 띄운 프로세스의 메모리(큰 순).
//  - Not needed in this folder: 이 폴더에서 확실히 필요 없는 확장(추천). 버튼 하나로 모두 끌 수 있다.
//  - You usually turn these off: 비슷한 폴더에서 내가 직접 끈 확장(내 결정에서 배운 제안).
//  - Recommended by this repo: 저장소(.vscode/extensions.json)가 권장하는데 여기서 꺼져 있거나 설치되지 않은 확장.
//  - ON in this folder / OFF in this folder: 이 폴더 전용 설정. 초록 ✓ / 빨강 ✕ 배지와 글자색으로 구분한다.
//  - Same as global setting: 전역 설정을 따른다. 켜진 것을 먼저, 꺼진 것은 흐리게.
// 항목 아이콘은 각 확장의 아이콘이고, 설명에는 메모리, 언제 켜지는지(⚡ always 등), 지금 실행 중인지를 짧게 적는다.
// 확장 팩은 펼치면 팩에 든 확장이 보인다. 설치 목록은 화면이 실제로 그려질 때만 읽는다.
import * as vscode from 'vscode';
import { Activated, causesOf } from './activations';
import { Activation, InstalledExtension } from './catalog';
import type { ViewOptions } from './controller';
import type { LearnedSuggestion } from './learning';
import { ExtensionRow, LoadoutSnapshot } from './model';
import { ExtMemory, formatBytes } from './processes';
import type { Suggestion } from './recommend';
import type { RepoRecommendations } from './repoRecs';
import { learnedText, localizeError, startedShort, startedText, startsText, suggestionText } from './text';

const t = vscode.l10n.t;

type GroupKind = 'memory' | 'suggest' | 'learned' | 'repo' | 'on' | 'off' | 'global';

export type Node =
  | { kind: 'group'; group: GroupKind; rows: ExtensionRow[]; missing?: string[] }
  | {
      kind: 'ext';
      row: ExtensionRow;
      pending: boolean;
      suggestion?: Suggestion;
      learned?: LearnedSuggestion;
      inMemoryGroup?: boolean;
      inRepoGroup?: boolean;
      memberOf?: string;
    }
  | { kind: 'missing'; id: string }
  | { kind: 'notice'; label: string; detail?: string; icon: vscode.ThemeIcon; command?: vscode.Command };

function groups(): Record<GroupKind, { label: string; icon: vscode.ThemeIcon; tooltip: string }> {
  return {
    memory: {
      label: t('Memory in this window'),
      icon: new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.orange')),
      tooltip: t(
        'Memory used by processes that extensions started in this window (language servers, daemons), including memory macOS has compressed. Memory inside the shared extension host cannot be split per extension.',
      ),
    },
    suggest: {
      label: t('Not needed in this folder'),
      icon: new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow')),
      tooltip: t('These only start for certain languages or files, and this folder has none of them, or the repository marks them as unwanted. Turning them off here is safe.'),
    },
    learned: {
      label: t('You usually turn these off'),
      icon: new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.purple')),
      tooltip: t('You turned these off in folders with a similar stack (same kind of project files). Based on your own choices, so check before turning them off.'),
    },
    repo: {
      label: t('Recommended by this repo'),
      icon: new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow')),
      tooltip: t('Listed in .vscode/extensions.json (or the workspace file) but off here or not installed.'),
    },
    on: {
      label: t('ON in this folder'),
      icon: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
      tooltip: t('Turned on for this folder, whatever the global setting says.'),
    },
    off: {
      label: t('OFF in this folder'),
      icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red')),
      tooltip: t('Turned off for this folder, whatever the global setting says.'),
    },
    global: {
      label: t('Same as global setting'),
      icon: new vscode.ThemeIcon('globe'),
      tooltip: t('No folder-specific choice. These follow the Extensions view.'),
    },
  };
}

const DECORATION_SCHEME = 'extension-loadout';

/** 이 폴더에서 원하는 상태와 실제 실행 상태가 다른지. 적용 대기 중이면 아직 판단하지 않는다. */
const mismatchOf = (r: ExtensionRow, pending: boolean) => !pending && !r.locked && !r.builtin && r.desiredOn !== r.running;

export function summaryOf(snap: LoadoutSnapshot): string {
  const on = snap.rows.filter((r) => r.override === 'on').length;
  const off = snap.rows.filter((r) => r.override === 'off').length;
  return on || off ? t('{0} on · {1} off here', on, off) : t('same as global');
}

export class LoadoutTree implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly loaded = new vscode.EventEmitter<LoadoutSnapshot | undefined>();
  /** 목록을 새로 읽을 때마다. 제목 옆 요약과 추천 계산에 쓴다. */
  readonly onDidLoad = this.loaded.event;
  private snap?: LoadoutSnapshot;
  private stale = true;
  private loading?: Promise<LoadoutSnapshot | undefined>;
  private byId = new Map<string, ExtensionRow>();
  private suggestions: Suggestion[] = [];
  private learned: LearnedSuggestion[] = [];
  private repo: RepoRecommendations = { recommended: new Set(), unwanted: new Set() };
  private memory = new Map<string, ExtMemory>();
  private builtins = new Map<string, InstalledExtension>();
  /** 이 창에서 확장이 켜진 이유(VS Code 활성화 기록). */
  private activations = new Map<string, Activated>();
  private activationKey = '';
  /** 언어 서버 재시작 명령을 찾는 함수(컨트롤러가 넘겨준다). */
  private restartOf: (id: string) => string | undefined = () => undefined;
  private view: ViewOptions = { show: 'all', sort: 'name' };
  /** 체크박스로 고른 확장 ID. 켜짐/꺼짐 상태가 아니라 "한꺼번에 처리할 대상"이다. */
  private readonly checked = new Set<string>();
  private readonly selectionChanged = new vscode.EventEmitter<number>();
  readonly onDidChangeSelection = this.selectionChanged.event;

  constructor(private readonly load: () => Promise<LoadoutSnapshot | undefined>) {}

  /** 다음에 화면이 그려질 때 다시 읽게 한다. 보이지 않는 동안에는 아무것도 읽지 않는다. */
  invalidate(): void {
    this.stale = true;
    this.changed.fire();
  }

  setSuggestions(list: Suggestion[]): void {
    this.suggestions = list;
    this.changed.fire();
  }

  setRepoAndLearned(repo: RepoRecommendations, learned: LearnedSuggestion[]): void {
    this.repo = repo;
    this.learned = learned;
    this.changed.fire();
  }

  setMemory(list: ExtMemory[], builtins: InstalledExtension[]): void {
    this.memory = new Map(list.map((m) => [m.id, m]));
    this.builtins = new Map(builtins.map((b) => [b.id, b]));
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
  }

  /** 활성화 기록이 바뀌었을 때만 다시 그린다. */
  setActivations(acts: Map<string, Activated>): void {
    const key = [...acts.values()].map((a) => `${a.id}<${a.cause ?? a.event}`).join('|');
    if (key === this.activationKey) return;
    this.activationKey = key;
    this.activations = new Map(acts);
    this.changed.fire();
  }

  setRestartLookup(fn: (id: string) => string | undefined): void {
    this.restartOf = fn;
  }

  /** 확장 ID → 화면 이름(설치 목록, 내장 확장 순). */
  readonly nameOf = (id: string): string => this.byId.get(id)?.displayName ?? this.builtins.get(id)?.displayName ?? id;

  /** 다른 확장 때문에 켜졌으면 그 원인들(가까운 것부터). */
  causes(id: string): string[] {
    return causesOf(this.activations, id);
  }

  /** 프로세스를 띄워 메모리를 쓰고 있고, 언어 서버를 다시 시작하는 명령이 있으면 그 명령. */
  restartCommand(id: string): string | undefined {
    return this.memory.get(id)?.pids.length ? this.restartOf(id) : undefined;
  }

  setViewOptions(view: ViewOptions): void {
    this.view = view;
    this.changed.fire();
  }

  memoryOf(id: string): ExtMemory | undefined {
    return this.memory.get(id);
  }

  private heavyThreshold(): number {
    return vscode.workspace.getConfiguration('extensionLoadout').get<number>('heavyThresholdMB', 500) * 1024 ** 2;
  }

  // ------------------------------------------------------------------ 선택(체크박스)

  selectedIds(): string[] {
    // 목록을 읽은 뒤라면 그 사이 제거된 확장은 빼고 돌려준다.
    return this.snap ? [...this.checked].filter((id) => this.byId.has(id)) : [...this.checked];
  }

  select(ids: string[]): void {
    for (const id of ids) this.checked.add(id);
    this.selectionUpdated();
  }

  clearSelection(): void {
    this.checked.clear();
    this.selectionUpdated();
  }

  /** 체크박스 변경. 묶음을 체크하면 그 묶음의 확장을 모두 고른다. */
  toggle(items: readonly (readonly [Node, vscode.TreeItemCheckboxState])[]): void {
    for (const [node, state] of items) {
      const on = state === vscode.TreeItemCheckboxState.Checked;
      const rows = node.kind === 'ext' ? [node.row] : node.kind === 'group' ? this.rowsOf(node) : [];
      for (const r of rows) {
        if (r.locked || r.builtin) continue;
        if (on) this.checked.add(r.id);
        else this.checked.delete(r.id);
      }
    }
    this.selectionUpdated();
  }

  private selectionUpdated(): void {
    this.selectionChanged.fire(this.selectedIds().length);
    this.changed.fire();
  }

  // ------------------------------------------------------------------ 묶음 내용

  /** 지금 화면 기준으로, 아직 켜져 있어서 끌 의미가 있는 추천. */
  activeSuggestions(): { row: ExtensionRow; suggestion: Suggestion }[] {
    return this.suggestions
      .map((s) => ({ row: this.byId.get(s.id)!, suggestion: s }))
      .filter((x) => x.row && x.row.desiredOn && x.row.override !== 'on' && !x.row.locked);
  }

  activeLearned(): { row: ExtensionRow; learned: LearnedSuggestion }[] {
    const certain = new Set(this.activeSuggestions().map((x) => x.row.id));
    return this.learned
      .map((l) => ({ row: this.byId.get(l.id)!, learned: l }))
      .filter((x) => x.row && x.row.desiredOn && x.row.override !== 'on' && !x.row.locked && !certain.has(x.row.id));
  }

  /** 저장소가 권장하는데 여기서 꺼져 있는 확장과, 설치되지 않은 권장 확장. */
  repoMissing(): { rows: ExtensionRow[]; notInstalled: string[] } {
    const rows: ExtensionRow[] = [];
    const notInstalled: string[] = [];
    for (const id of [...this.repo.recommended].sort()) {
      const r = this.byId.get(id);
      if (!r) notInstalled.push(id);
      else if (!r.desiredOn) rows.push(r);
    }
    return { rows, notInstalled };
  }

  /** 메모리 묶음에 보일 줄: 설치된 확장은 목록의 줄을, 내장 확장은 정보용 줄을 만든다. */
  private memoryRows(): ExtensionRow[] {
    const out: ExtensionRow[] = [];
    for (const m of [...this.memory.values()].filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes)) {
      const row = this.byId.get(m.id);
      if (row) out.push(row);
      else {
        const b = this.builtins.get(m.id);
        if (b) out.push({ ...b, globallyEnabled: true, desiredOn: true, running: true, active: true, locked: true });
      }
    }
    return out;
  }

  private rowsOf(node: Extract<Node, { kind: 'group' }>): ExtensionRow[] {
    if (node.group === 'suggest') return this.activeSuggestions().map((x) => x.row);
    if (node.group === 'learned') return this.activeLearned().map((x) => x.row);
    return node.rows;
  }

  /** 보기 옵션(필터·정렬)을 적용한다. ON/OFF/전역 묶음에만 쓴다. */
  private shown(rows: ExtensionRow[]): ExtensionRow[] {
    const mem = (r: ExtensionRow) => this.memory.get(r.id)?.bytes ?? 0;
    const filtered = rows.filter((r) =>
      this.view.show === 'running' ? r.running : this.view.show === 'always' ? r.activation.kind === 'always' : this.view.show === 'memory' ? mem(r) > 0 : true,
    );
    if (this.view.sort === 'memory') return [...filtered].sort((a, b) => mem(b) - mem(a) || a.displayName.localeCompare(b.displayName));
    return filtered;
  }

  async current(): Promise<LoadoutSnapshot | undefined> {
    if (this.stale) {
      this.stale = false;
      this.loading = this.load().then((snap) => {
        this.snap = snap;
        this.byId = new Map(snap?.rows.map((r) => [r.id, r]) ?? []);
        this.decorationsChanged.fire(undefined);
        this.loaded.fire(snap);
        return snap;
      });
    }
    return this.loading ?? this.snap;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    // 묶음을 펼칠 때는 이미 읽은 목록을 쓴다.
    const snap = node ? this.snap : await this.current();
    if (!snap) return [];
    if (!node) return this.rootNodes(snap);
    if (node.kind === 'group') {
      if (node.group === 'memory') return node.rows.map((row): Node => ({ kind: 'ext', row, pending: snap.pending, inMemoryGroup: true }));
      if (node.group === 'suggest' || node.group === 'learned') {
        const list =
          node.group === 'suggest'
            ? this.activeSuggestions().map(({ row, suggestion }): Node => ({ kind: 'ext', row, pending: snap.pending, suggestion }))
            : this.activeLearned().map(({ row, learned }): Node => ({ kind: 'ext', row, pending: snap.pending, learned }));
        const turnAllOff: Node = {
          kind: 'notice',
          label: list.length > 1 ? t('Turn all {0} off', list.length) : t('Turn it off'),
          detail: t('in this folder'),
          icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red')),
          command: {
            command: node.group === 'suggest' ? 'extensionLoadout.disableSuggested' : 'extensionLoadout.disableLearned',
            title: t('Turn Off All'),
          },
        };
        return [turnAllOff, ...list];
      }
      if (node.group === 'repo') {
        return [
          ...node.rows.map((row): Node => ({ kind: 'ext', row, pending: snap.pending, inRepoGroup: true })),
          ...(node.missing ?? []).map((id): Node => ({ kind: 'missing', id })),
        ];
      }
      return node.rows.map((row): Node => ({ kind: 'ext', row, pending: snap.pending }));
    }
    if (node.kind === 'ext' && !node.memberOf && !node.suggestion && !node.learned && !node.inMemoryGroup) {
      // 확장 팩: 팩에 든 확장을 보여준다.
      return node.row.packMembers.map((id) => this.byId.get(id)).filter((r): r is ExtensionRow => !!r).map((row): Node => ({ kind: 'ext', row, pending: snap.pending, memberOf: node.row.id }));
    }
    return [];
  }

  private rootNodes(snap: LoadoutSnapshot): Node[] {
    const out: Node[] = [];
    for (const err of snap.configErrors) {
      out.push({
        kind: 'notice',
        label: t('Loadout file has a problem'),
        detail: localizeError(err),
        icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
        command: { command: 'extensionLoadout.openConfig', title: t('Open') },
      });
    }
    for (const c of snap.conflicts) out.push({ kind: 'notice', label: t('Folders disagree'), detail: localizeError(c), icon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')) });
    if (snap.pending) {
      out.push({
        kind: 'notice',
        label: t('Restart VS Code to apply'),
        detail: t('click here'),
        icon: new vscode.ThemeIcon('debug-restart', new vscode.ThemeColor('charts.orange')),
        command: { command: 'extensionLoadout.applyMenu', title: t('Apply') },
      });
    }
    for (const id of snap.missing) out.push({ kind: 'notice', label: id, detail: t('in the loadout but not installed'), icon: new vscode.ThemeIcon('warning') });
    const heavy = this.memoryRows();
    if (heavy.length) out.push({ kind: 'group', group: 'memory', rows: heavy });
    const suggested = this.activeSuggestions();
    if (suggested.length) out.push({ kind: 'group', group: 'suggest', rows: suggested.map((s) => s.row) });
    const learned = this.activeLearned();
    if (learned.length) out.push({ kind: 'group', group: 'learned', rows: learned.map((s) => s.row) });
    const repo = this.repoMissing();
    if (repo.rows.length || repo.notInstalled.length) out.push({ kind: 'group', group: 'repo', rows: repo.rows, missing: repo.notInstalled });
    // 다른 팩에 든 확장은 팩 아래에서도 보이지만, 위쪽 목록에도 그대로 둔다(찾기 쉽게).
    out.push({ kind: 'group', group: 'on', rows: this.shown(snap.rows.filter((r) => r.override === 'on')) });
    out.push({ kind: 'group', group: 'off', rows: this.shown(snap.rows.filter((r) => r.override === 'off')) });
    // 전역을 따르는 것 중 켜진 것을 먼저 보여준다.
    const global = snap.rows.filter((r) => !r.override);
    out.push({ kind: 'group', group: 'global', rows: this.shown([...global.filter((r) => r.globallyEnabled), ...global.filter((r) => !r.globallyEnabled)]) });
    return out;
  }

  // ------------------------------------------------------------------ 그리기

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') return this.groupItem(node);
    if (node.kind === 'notice') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.detail;
      item.tooltip = node.detail ? `${node.label}: ${node.detail}` : node.label;
      item.iconPath = node.icon;
      item.command = node.command;
      return item;
    }
    if (node.kind === 'missing') {
      const item = new vscode.TreeItem(node.id);
      item.id = `missing:${node.id}`;
      item.description = t('not installed · recommended by this repo');
      item.iconPath = new vscode.ThemeIcon('cloud-download');
      item.contextValue = 'rec:missing';
      item.tooltip = t('Recommended in .vscode/extensions.json but not installed. Use the download button to install it.');
      item.command = { command: 'workbench.extensions.search', title: t('Show'), arguments: [`@id:${node.id}`] };
      return item;
    }
    return this.extItem(node);
  }

  private groupItem(node: Extract<Node, { kind: 'group' }>): vscode.TreeItem {
    const g = groups()[node.group];
    const item = new vscode.TreeItem(
      g.label,
      node.group === 'global' && node.rows.length > 15 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `group:${node.group}`;
    item.iconPath = g.icon;
    item.description =
      node.group === 'suggest'
        ? t('{0} · safe to turn off', node.rows.length)
        : node.group === 'learned'
          ? t('{0} · from your choices', node.rows.length)
          : node.group === 'memory'
            ? formatBytes(node.rows.reduce((a, r) => a + (this.memory.get(r.id)?.bytes ?? 0), 0))
            : node.group === 'repo'
              ? String(node.rows.length + (node.missing?.length ?? 0))
              : String(node.rows.length);
    item.tooltip = g.tooltip;
    item.contextValue = `group:${node.group}`;
    const selectable = this.rowsOf(node).filter((r) => !r.locked && !r.builtin);
    if (selectable.length && node.group !== 'memory') {
      const all = selectable.every((r) => this.checked.has(r.id));
      item.checkboxState = { state: all ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked, tooltip: t('Select all in this group') };
    }
    return item;
  }

  private extItem(node: Extract<Node, { kind: 'ext' }>): vscode.TreeItem {
    const r = node.row;
    const members = !node.memberOf && !node.suggestion && !node.learned && !node.inMemoryGroup ? r.packMembers.filter((id) => this.byId.has(id)) : [];
    const item = new vscode.TreeItem(r.displayName, members.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.iconPath = r.icon ? vscode.Uri.file(r.icon) : new vscode.ThemeIcon(r.packMembers.length ? 'package' : 'extensions');
    item.command = { command: 'extension.open', title: t('Show Extension'), arguments: [r.id] };
    const mem = this.memory.get(r.id);
    if (!r.locked && !r.builtin) {
      item.checkboxState = {
        state: this.checked.has(r.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: t('Select (then use "Turn Off Selected" at the top)'),
      };
    }
    const state = r.override ?? (r.globallyEnabled ? 'global-on' : 'global-off');

    if (node.inMemoryGroup) {
      item.id = `memory:${r.id}`;
      const parts = mem ? [formatBytes(mem.bytes), mem.pids.length === 1 ? t('1 process') : t('{0} processes', mem.pids.length)] : [];
      if (mem && mem.allWindowsBytes > mem.bytes) parts.push(t('all windows {0}', formatBytes(mem.allWindowsBytes)));
      if (r.builtin) parts.push(t('built-in'));
      const by = startedShort(this.causes(r.id), this.nameOf);
      if (by) parts.push(by);
      item.description = parts.join(' · ');
      item.contextValue = (r.builtin ? 'ext:builtin:locked' : `ext:${state}:${r.locked ? 'locked' : 'switchable'}`) + (this.restartCommand(r.id) ? ':restart' : '');
      item.tooltip = this.tooltip(r, false, { mem });
      if (r.builtin) item.checkboxState = undefined;
      return item;
    }
    if (node.suggestion || node.learned) {
      const kind = node.suggestion ? 'suggest' : 'learned';
      item.id = `${kind}:${r.id}`;
      item.description = node.suggestion ? this.suggestionLine(node.suggestion) : learnedText(node.learned!);
      item.contextValue = `ext:${kind}:${r.locked ? 'locked' : 'switchable'}`;
      item.tooltip = this.tooltip(r, false, { suggestion: node.suggestion, learned: node.learned, mem });
      return item;
    }

    const mismatch = mismatchOf(r, node.pending);
    item.id = node.memberOf ? `member:${node.memberOf}:${r.id}` : node.inRepoGroup ? `repo:${r.id}` : `ext:${r.id}`;
    // 배지와 글자색은 provideFileDecoration이 이 URI를 보고 붙인다.
    item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${r.id}` });
    item.contextValue = `ext:${state}:${r.locked ? 'locked' : 'switchable'}` + (this.restartCommand(r.id) ? ':restart' : '');
    const parts: string[] = [];
    if (mem && mem.bytes > 0) parts.push(formatBytes(mem.bytes));
    if (mismatch) parts.push(r.desiredOn ? t('not running yet') : t('still running'));
    else if (r.active) parts.push(t('● running'));
    const by = r.active ? startedShort(this.causes(r.id), this.nameOf) : undefined;
    if (by) parts.push(by);
    parts.push(startsText(r.activation, r.packMembers.length));
    if (r.override) parts.push(r.globallyEnabled ? t('elsewhere: on') : t('elsewhere: off'));
    if (this.repo.recommended.has(r.id)) parts.push(t('★ repo'));
    if (r.via) parts.push(t('via {0}', r.via));
    if (r.note) parts.push(`“${r.note}”`);
    item.description = parts.join(' · ');
    item.tooltip = this.tooltip(r, mismatch, { mem });
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) return undefined;
    const r = this.byId.get(uri.path.slice(1));
    if (!r) return undefined;
    if (mismatchOf(r, !!this.snap?.pending)) {
      return new vscode.FileDecoration('!', t('Not in the state the loadout asks for'), new vscode.ThemeColor('problemsWarningIcon.foreground'));
    }
    if (r.override === 'on') return new vscode.FileDecoration('✓', t('ON in this folder'), new vscode.ThemeColor('charts.green'));
    if (r.override === 'off') return new vscode.FileDecoration('✕', t('OFF in this folder'), new vscode.ThemeColor('charts.red'));
    if (!r.globallyEnabled) return new vscode.FileDecoration(undefined, t('Off everywhere'), new vscode.ThemeColor('disabledForeground'));
    const mem = this.memory.get(r.id);
    if (mem && mem.bytes >= this.heavyThreshold()) return new vscode.FileDecoration(undefined, t('Heavy: {0} in this window', formatBytes(mem.bytes)), new vscode.ThemeColor('charts.orange'));
    return undefined;
  }

  private tooltip(r: ExtensionRow, mismatch: boolean, extra: { suggestion?: Suggestion; learned?: LearnedSuggestion; mem?: ExtMemory }): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${r.displayName}**  \n\`${r.id}\` · v${r.version} · ${r.publisher}\n\n`);
    if (r.description) md.appendMarkdown(`${r.description}\n\n`);
    if (extra.suggestion) md.appendMarkdown(`$(lightbulb) **${t('Safe to turn off here.')}** ${this.suggestionLine(extra.suggestion)}.\n\n`);
    if (extra.learned) md.appendMarkdown(`$(history) **${t('Based on your choices.')}** ${learnedText(extra.learned)}.\n\n`);
    const here = r.override === 'on' ? t('ON (folder setting)') : r.override === 'off' ? t('OFF (folder setting)') : t('same as global');
    md.appendMarkdown(`**${t('This folder')}:** ${here}  \n`);
    md.appendMarkdown(`**${t('Global setting')}:** ${r.globallyEnabled ? t('on') : t('off')}  \n`);
    md.appendMarkdown(`**${t('Starts')}:** ${this.activationDetail(r.activation)}  \n`);
    md.appendMarkdown(`**${t('Now')}:** ${r.active ? t('running') : r.running ? t('loaded, not started yet') : t('not loaded')}`);
    const act = this.activations.get(r.id);
    if (act) md.appendMarkdown(`  \n**${t('Started here')}:** ${startedText(act, this.causes(r.id), this.nameOf)}`);
    const mem = extra.mem;
    if (mem && (mem.bytes || mem.allWindowsBytes)) {
      md.appendMarkdown(`  \n**${t('Memory')}:** ${t('{0} in this window ({1} processes), {2} in all windows', formatBytes(mem.bytes), mem.pids.length, formatBytes(mem.allWindowsBytes))}`);
      const cmds = mem.commands.slice(0, 4).map((c) => '`' + c.replace(/`/g, "'").slice(0, 110) + (c.length > 110 ? '…' : '') + '`');
      if (cmds.length) md.appendMarkdown(`\n\n${cmds.join('  \n')}`);
    }
    if (r.categories.length) md.appendMarkdown(`  \n**${t('Categories')}:** ${r.categories.join(', ')}`);
    if (r.dependencies.length) md.appendMarkdown(`  \n**${t('Needs')}:** ${r.dependencies.join(', ')}`);
    if (r.packMembers.length) md.appendMarkdown(`  \n**${t('Pack of')}:** ${r.packMembers.join(', ')}`);
    if (this.repo.recommended.has(r.id)) md.appendMarkdown(`  \n$(star-full) ${t('Recommended by this repository')}`);
    if (r.note) md.appendMarkdown(`  \n**${t('Note')}:** ${r.note}`);
    if (r.via) md.appendMarkdown(`  \n**${t('Set by pattern')}:** \`${r.via}\``);
    if (r.inheritedFrom?.length) md.appendMarkdown(`  \n**${t('From folder')}:** ${r.inheritedFrom.join(', ')}`);
    if (r.builtin) md.appendMarkdown(`\n\n${t('Built-in extension. Turn it off from the Extensions view if you really need to.')}`);
    else if (r.locked) md.appendMarkdown(`\n\n${t('Extension Loadout always stays on so you can change the loadout.')}`);
    if (mismatch) {
      md.appendMarkdown(
        `\n\n$(warning) ${
          r.desiredOn
            ? t('The loadout turns this on, but it is not running. It may need an extension it depends on, or it may not support this VS Code.')
            : t('The loadout turns this off, but it is still running. Another extension may depend on it.')
        }`,
      );
    }
    return md;
  }

  /** 추천 사유. 연쇄 추천이면 켠 확장들이 지금 쓰는 메모리도 덧붙인다. */
  private suggestionLine(s: Suggestion): string {
    const text = suggestionText(s, this.nameOf);
    const bytes = (s.started ?? []).reduce((sum, id) => sum + (this.memory.get(id)?.bytes ?? 0), 0);
    return bytes > 0 ? `${text} · ${t('{0} in this window', formatBytes(bytes))}` : text;
  }

  private activationDetail(a: Activation): string {
    if (a.kind === 'none') return t('never runs code (theme, snippets, grammar or similar)');
    if (a.kind === 'always') return t('every time VS Code opens a window, in every folder');
    const why: string[] = [];
    if (a.languages.length) why.push(t('when you open {0} files', a.languages.join(', ')));
    if (a.files.length) why.push(t('when the folder contains {0}', a.files.slice(0, 3).join(', ')));
    return why.length ? why.join('; ') : t('only when you use one of its commands or views');
  }
}
