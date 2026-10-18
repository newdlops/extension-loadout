// 사이드바 목록.
//  - Not needed in this folder: 이 폴더에서 확실히 필요 없는 확장(추천). 버튼 하나로 모두 끌 수 있다.
//  - ON in this folder / OFF in this folder: 이 폴더 전용 설정. 초록 ✓ / 빨강 ✕ 배지와 글자색으로 구분한다.
//  - Same as global setting: 전역 설정을 따른다. 켜진 것을 먼저, 꺼진 것은 흐리게.
// 항목 아이콘은 각 확장의 아이콘이고, 설명에는 언제 켜지는지(⚡ always 등)와 지금 실행 중인지를 짧게 적는다.
// 설치 목록은 화면이 실제로 그려질 때만 읽는다.
import * as vscode from 'vscode';
import { Activation, InstalledExtension, activationText } from './catalog';
import { ExtensionRow, LoadoutSnapshot } from './model';
import { ExtMemory, formatBytes } from './processes';
import type { Suggestion } from './recommend';

const t = vscode.l10n.t;

type GroupKind = 'memory' | 'suggest' | 'on' | 'off' | 'global';

export type Node =
  | { kind: 'group'; group: GroupKind; rows: ExtensionRow[] }
  | { kind: 'ext'; row: ExtensionRow; pending: boolean; suggestion?: Suggestion; inMemoryGroup?: boolean }
  | { kind: 'notice'; label: string; detail?: string; icon: vscode.ThemeIcon; command?: vscode.Command };

const GROUPS: Record<GroupKind, { label: string; icon: vscode.ThemeIcon; tooltip: string }> = {
  memory: {
    label: 'Memory in this window',
    icon: new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.orange')),
    tooltip:
      'Memory used by processes that extensions started in this window (language servers, daemons), including memory macOS has compressed. Memory inside the shared extension host cannot be split per extension.',
  },
  suggest: {
    label: 'Not needed in this folder',
    icon: new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow')),
    tooltip:
      'These only start for certain languages or files, and this folder has none of them. Turning them off here is safe. Use the button on the right to turn them all off.',
  },
  on: {
    label: 'ON in this folder',
    icon: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
    tooltip: 'Turned on for this folder, whatever the global setting says.',
  },
  off: {
    label: 'OFF in this folder',
    icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red')),
    tooltip: 'Turned off for this folder, whatever the global setting says.',
  },
  global: {
    label: 'Same as global setting',
    icon: new vscode.ThemeIcon('globe'),
    tooltip: 'No folder-specific choice. These follow the Extensions view.',
  },
};

const DECORATION_SCHEME = 'extension-loadout';

/** 이 폴더에서 원하는 상태와 실제 실행 상태가 다른지. 적용 대기 중이면 아직 판단하지 않는다. */
const mismatchOf = (r: ExtensionRow, pending: boolean) => !pending && !r.locked && r.desiredOn !== r.running;

/** 다른 폴더에서는 어떤지. 이 폴더 전용 설정이 있을 때만 의미가 있다. */
function elsewhereText(r: ExtensionRow): string | undefined {
  if (!r.override) return undefined;
  return `elsewhere: ${r.globallyEnabled ? 'on' : 'off'}`;
}

export function summaryOf(snap: LoadoutSnapshot): string {
  const on = snap.rows.filter((r) => r.override === 'on').length;
  const off = snap.rows.filter((r) => r.override === 'off').length;
  return on || off ? `${on} on · ${off} off here` : 'same as global';
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
  private memory = new Map<string, ExtMemory>();
  private builtins = new Map<string, InstalledExtension>();
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

  setMemory(list: ExtMemory[], builtins: InstalledExtension[]): void {
    this.memory = new Map(list.map((m) => [m.id, m]));
    this.builtins = new Map(builtins.map((b) => [b.id, b]));
    this.decorationsChanged.fire(undefined);
    this.changed.fire();
  }

  memoryOf(id: string): ExtMemory | undefined {
    return this.memory.get(id);
  }

  private heavyThreshold(): number {
    return vscode.workspace.getConfiguration('extensionLoadout').get<number>('heavyThresholdMB', 500) * 1024 ** 2;
  }

  /** 메모리 묶음에 보일 줄: 설치된 확장은 목록의 줄을, 내장 확장은 정보용 줄을 만든다. */
  private memoryRows(snap: LoadoutSnapshot): ExtensionRow[] {
    const out: ExtensionRow[] = [];
    for (const m of [...this.memory.values()].filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes)) {
      const row = this.byId.get(m.id);
      if (row) out.push(row);
      else {
        const b = this.builtins.get(m.id);
        if (b) out.push({ ...b, globallyEnabled: true, desiredOn: true, running: true, active: true, locked: true });
      }
    }
    void snap;
    return out;
  }

  setSuggestions(list: Suggestion[]): void {
    this.suggestions = list;
    this.changed.fire();
  }

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
        if (r.locked) continue;
        if (on) this.checked.add(r.id);
        else this.checked.delete(r.id);
      }
    }
    this.selectionUpdated();
  }

  private rowsOf(node: Extract<Node, { kind: 'group' }>): ExtensionRow[] {
    return node.group === 'suggest' ? this.activeSuggestions().map((x) => x.row) : node.rows;
  }

  private selectionUpdated(): void {
    this.selectionChanged.fire(this.selectedIds().length);
    this.changed.fire();
  }

  /** 지금 화면 기준으로, 아직 켜져 있어서 끌 의미가 있는 추천. */
  activeSuggestions(): { row: ExtensionRow; suggestion: Suggestion }[] {
    return this.suggestions
      .map((s) => ({ row: this.byId.get(s.id)!, suggestion: s }))
      .filter((x) => x.row && x.row.desiredOn && x.row.override !== 'on' && !x.row.locked);
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
    if (!node) {
      const out: Node[] = [];
      for (const err of snap.configErrors) {
        out.push({
          kind: 'notice',
          label: 'Loadout file has a problem',
          detail: err,
          icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
          command: { command: 'extensionLoadout.openConfig', title: 'Open' },
        });
      }
      if (snap.pending) {
        out.push({
          kind: 'notice',
          label: 'Restart VS Code to apply',
          detail: 'click here',
          icon: new vscode.ThemeIcon('debug-restart', new vscode.ThemeColor('charts.orange')),
          command: { command: 'extensionLoadout.applyAndRestart', title: 'Apply' },
        });
      }
      for (const id of snap.missing) {
        out.push({ kind: 'notice', label: id, detail: 'in the loadout but not installed', icon: new vscode.ThemeIcon('warning') });
      }
      const heavy = this.memoryRows(snap);
      if (heavy.length) out.push({ kind: 'group', group: 'memory', rows: heavy });
      const suggested = this.activeSuggestions();
      if (suggested.length) out.push({ kind: 'group', group: 'suggest', rows: suggested.map((s) => s.row) });
      out.push({ kind: 'group', group: 'on', rows: snap.rows.filter((r) => r.override === 'on') });
      out.push({ kind: 'group', group: 'off', rows: snap.rows.filter((r) => r.override === 'off') });
      // 전역을 따르는 것 중 켜진 것을 먼저 보여준다.
      const global = snap.rows.filter((r) => !r.override);
      out.push({ kind: 'group', group: 'global', rows: [...global.filter((r) => r.globallyEnabled), ...global.filter((r) => !r.globallyEnabled)] });
      return out;
    }
    if (node.kind === 'group') {
      if (node.group === 'memory') return node.rows.map((row): Node => ({ kind: 'ext', row, pending: snap.pending, inMemoryGroup: true }));
      if (node.group === 'suggest') {
        const list = this.activeSuggestions();
        const turnAllOff: Node = {
          kind: 'notice',
          label: list.length > 1 ? `Turn all ${list.length} off` : 'Turn it off',
          detail: 'in this folder',
          icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red')),
          command: { command: 'extensionLoadout.disableSuggested', title: 'Turn Off All Suggested' },
        };
        return [turnAllOff, ...list.map(({ row, suggestion }): Node => ({ kind: 'ext', row, pending: snap.pending, suggestion }))];
      }
      return node.rows.map((row) => ({ kind: 'ext', row, pending: snap.pending }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = GROUPS[node.group];
      const item = new vscode.TreeItem(
        g.label,
        node.group === 'global' && node.rows.length > 15
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `group:${node.group}`;
      item.iconPath = g.icon;
      item.description =
        node.group === 'suggest'
          ? `${node.rows.length} · safe to turn off`
          : node.group === 'memory'
            ? formatBytes(node.rows.reduce((a, r) => a + (this.memory.get(r.id)?.bytes ?? 0), 0))
            : String(node.rows.length);
      item.tooltip = g.tooltip;
      item.contextValue = `group:${node.group}`;
      const selectable = this.rowsOf(node).filter((r) => !r.locked);
      if (selectable.length) {
        const all = selectable.every((r) => this.checked.has(r.id));
        item.checkboxState = { state: all ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked, tooltip: 'Select all in this group' };
      }
      return item;
    }
    if (node.kind === 'notice') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.detail;
      item.tooltip = node.detail ? `${node.label}: ${node.detail}` : node.label;
      item.iconPath = node.icon;
      item.command = node.command;
      return item;
    }
    const r = node.row;
    const item = new vscode.TreeItem(r.displayName);
    item.iconPath = r.icon ? vscode.Uri.file(r.icon) : new vscode.ThemeIcon('extensions');
    item.command = { command: 'extension.open', title: 'Show Extension', arguments: [r.id] };
    if (!r.locked) {
      item.checkboxState = {
        state: this.checked.has(r.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: 'Select (then use "Turn Off Selected" at the top)',
      };
    }
    const mem = this.memory.get(r.id);
    if (node.inMemoryGroup && mem) {
      item.id = `memory:${r.id}`;
      const parts = [formatBytes(mem.bytes), mem.pids.length === 1 ? t('1 process') : t('{0} processes', mem.pids.length)];
      if (mem.allWindowsBytes > mem.bytes) parts.push(t('all windows {0}', formatBytes(mem.allWindowsBytes)));
      if (r.builtin) parts.push(t('built-in'));
      item.description = parts.join(' · ');
      item.contextValue = r.builtin ? 'ext:builtin:locked' : `ext:${r.override ?? (r.globallyEnabled ? 'global-on' : 'global-off')}:${r.locked ? 'locked' : 'switchable'}`;
      item.tooltip = this.tooltip(r, false, undefined, mem);
      item.checkboxState = undefined;
      if (r.builtin) item.command = undefined;
      return item;
    }
    if (node.suggestion) {
      item.id = `suggest:${r.id}`;
      item.description = node.suggestion.reason.replace(/ in this folder$/, '');
      item.contextValue = `ext:suggest:${r.locked ? 'locked' : 'switchable'}`;
      item.tooltip = this.tooltip(r, false, node.suggestion);
      return item;
    }
    const mismatch = mismatchOf(r, node.pending);
    item.id = `ext:${r.id}`;
    // 배지와 글자색은 provideFileDecoration이 이 URI를 보고 붙인다.
    item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${r.id}` });
    const state = r.override ?? (r.globallyEnabled ? 'global-on' : 'global-off');
    item.contextValue = `ext:${state}:${r.locked ? 'locked' : 'switchable'}`;
    const parts: string[] = [];
    if (mem && mem.bytes > 0) parts.push(formatBytes(mem.bytes));
    if (mismatch) parts.push(r.desiredOn ? 'not running yet' : 'still running');
    else if (r.active) parts.push('● running');
    parts.push(activationText(r.activation));
    const elsewhere = elsewhereText(r);
    if (elsewhere) parts.push(elsewhere);
    item.description = parts.join(' · ');
    item.tooltip = this.tooltip(r, mismatch, undefined, mem);
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) return undefined;
    const r = this.byId.get(uri.path.slice(1));
    if (!r) return undefined;
    if (mismatchOf(r, !!this.snap?.pending)) {
      return new vscode.FileDecoration('!', 'Not in the state the loadout asks for', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    }
    if (r.override === 'on') return new vscode.FileDecoration('✓', 'ON in this folder', new vscode.ThemeColor('charts.green'));
    if (r.override === 'off') return new vscode.FileDecoration('✕', 'OFF in this folder', new vscode.ThemeColor('charts.red'));
    if (!r.globallyEnabled) return new vscode.FileDecoration(undefined, 'Off everywhere', new vscode.ThemeColor('disabledForeground'));
    const mem = this.memory.get(r.id);
    if (mem && mem.bytes >= this.heavyThreshold()) return new vscode.FileDecoration(undefined, `Heavy: ${formatBytes(mem.bytes)} in this window`, new vscode.ThemeColor('charts.orange'));
    return undefined;
  }

  private tooltip(r: ExtensionRow, mismatch: boolean, suggestion?: Suggestion, mem?: ExtMemory): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${r.displayName}**  \n\`${r.id}\` · v${r.version} · ${r.publisher}\n\n`);
    if (r.description) md.appendMarkdown(`${r.description}\n\n`);
    if (suggestion) {
      md.appendMarkdown(`$(lightbulb) **Safe to turn off here.** ${suggestion.reason}, and it only starts for those.\n\n`);
    }
    md.appendMarkdown(`**This folder:** ${r.override === 'on' ? 'ON (folder setting)' : r.override === 'off' ? 'OFF (folder setting)' : 'same as global'}  \n`);
    md.appendMarkdown(`**Global setting:** ${r.globallyEnabled ? 'on' : 'off'}  \n`);
    md.appendMarkdown(`**Starts:** ${this.activationDetail(r.activation)}  \n`);
    md.appendMarkdown(`**Now:** ${r.active ? 'running' : r.running ? 'loaded, not started yet' : 'not loaded'}`);
    if (mem && (mem.bytes || mem.allWindowsBytes)) {
      md.appendMarkdown(`  \n**Memory:** ${formatBytes(mem.bytes)} in this window (${mem.pids.length} processes), ${formatBytes(mem.allWindowsBytes)} in all windows`);
      const cmds = mem.commands.slice(0, 4).map((c) => '`' + c.replace(/`/g, "'").slice(0, 110) + (c.length > 110 ? '…' : '') + '`');
      if (cmds.length) md.appendMarkdown(`\n\n${cmds.join('  \n')}`);
    }
    if (r.note) md.appendMarkdown(`  \n**Note:** ${r.note}`);
    if (r.via) md.appendMarkdown(`  \n**Set by pattern:** \`${r.via}\``);
    if (r.inheritedFrom?.length) md.appendMarkdown(`  \n**From folder:** ${r.inheritedFrom.join(', ')}`);
    if (r.builtin) md.appendMarkdown('\n\nBuilt-in extension. Turn it off from the Extensions view if you really need to.');
    if (r.categories.length) md.appendMarkdown(`  \n**Categories:** ${r.categories.join(', ')}`);
    if (r.locked) md.appendMarkdown('\n\nExtension Loadout always stays on so you can change the loadout.');
    if (mismatch) {
      md.appendMarkdown(
        r.desiredOn
          ? '\n\n$(warning) The loadout turns this on, but it is not running. It may need an extension it depends on, or it may not support this VS Code.'
          : '\n\n$(warning) The loadout turns this off, but it is still running. Another extension may depend on it.',
      );
    }
    return md;
  }

  private activationDetail(a: Activation): string {
    if (a.kind === 'none') return 'never runs code (theme, snippets, grammar or similar)';
    if (a.kind === 'always') return 'every time VS Code opens a window, in every folder';
    const why: string[] = [];
    if (a.languages.length) why.push(`when you open ${a.languages.join(', ')} files`);
    if (a.files.length) why.push(`when the folder contains ${a.files.slice(0, 3).join(', ')}`);
    return why.length ? why.join('; ') : 'only when you use one of its commands or views';
  }
}
