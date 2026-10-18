// 사이드바: "이 폴더에서 켬 / 이 폴더에서 끔 / 전역과 같음" 세 묶음으로 확장을 보여준다.
// 항목 아이콘은 각 확장의 아이콘을 쓰고, 이 폴더에서의 상태는 배지(✓ ✕ !)·글자색·설명 문구로 구분한다.
// 설치 목록은 화면이 실제로 그려질 때만 읽는다.
import * as vscode from 'vscode';
import { Activation, activationText } from './catalog';
import { ExtensionRow, LoadoutSnapshot } from './model';

type GroupKind = 'on' | 'off' | 'global';

export type Node =
  | { kind: 'group'; group: GroupKind; rows: ExtensionRow[] }
  | { kind: 'ext'; row: ExtensionRow; pending: boolean }
  | { kind: 'notice'; label: string; detail?: string; icon: string; command?: vscode.Command };

const GROUPS: Record<GroupKind, { label: string; icon: vscode.ThemeIcon; tooltip: string }> = {
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

function stateText(r: ExtensionRow): string {
  if (r.override === 'on') return r.globallyEnabled ? 'ON here · on elsewhere too' : 'ON only here · off elsewhere';
  if (r.override === 'off') return r.globallyEnabled ? 'OFF only here · on elsewhere' : 'OFF here · off elsewhere too';
  return r.globallyEnabled ? 'on everywhere' : 'off everywhere';
}

export class LoadoutTree implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private snap?: LoadoutSnapshot;
  private stale = true;
  private byId = new Map<string, ExtensionRow>();

  private loading?: Promise<LoadoutSnapshot | undefined>;

  constructor(private readonly load: () => Promise<LoadoutSnapshot | undefined>) {}

  /** 다음에 화면이 그려질 때 다시 읽게 한다. 보이지 않는 동안에는 아무것도 읽지 않는다. */
  invalidate(): void {
    this.stale = true;
    this.changed.fire();
  }

  private async current(): Promise<LoadoutSnapshot | undefined> {
    if (this.stale) {
      this.stale = false;
      this.loading = this.load().then((snap) => {
        this.snap = snap;
        this.byId = new Map(snap?.rows.map((r) => [r.id, r]) ?? []);
        this.decorationsChanged.fire(undefined);
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
        out.push({ kind: 'notice', label: 'Loadout file has a problem', detail: err, icon: 'error', command: { command: 'extensionLoadout.openConfig', title: 'Open' } });
      }
      if (snap.pending) {
        out.push({ kind: 'notice', label: 'Restart to apply changes', icon: 'debug-restart', command: { command: 'extensionLoadout.applyAndRestart', title: 'Apply' } });
      }
      for (const id of snap.missing) {
        out.push({ kind: 'notice', label: id, detail: 'In the loadout but not installed', icon: 'warning' });
      }
      const by = (g: GroupKind) => snap.rows.filter((r) => (g === 'global' ? !r.override : r.override === g));
      for (const g of ['on', 'off', 'global'] as GroupKind[]) out.push({ kind: 'group', group: g, rows: by(g) });
      return out;
    }
    if (node.kind === 'group') return node.rows.map((row) => ({ kind: 'ext', row, pending: snap.pending }));
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
      item.description = String(node.rows.length);
      item.tooltip = g.tooltip;
      item.contextValue = `group:${node.group}`;
      return item;
    }
    if (node.kind === 'notice') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.detail;
      item.tooltip = node.detail ?? node.label;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      return item;
    }
    const r = node.row;
    const mismatch = mismatchOf(r, node.pending);
    const item = new vscode.TreeItem(r.displayName);
    item.id = `ext:${r.id}`;
    // 배지와 글자색은 provideFileDecoration이 이 URI를 보고 붙인다.
    item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${r.id}` });
    item.iconPath = r.icon ? vscode.Uri.file(r.icon) : new vscode.ThemeIcon('extensions');
    const state = r.override ?? (r.globallyEnabled ? 'global-on' : 'global-off');
    item.contextValue = `ext:${state}:${r.locked ? 'locked' : 'switchable'}`;
    const parts = [stateText(r), activationText(r.activation)];
    if (mismatch) parts.unshift(r.desiredOn ? 'not running' : 'still running');
    else if (r.active) parts.push('running now');
    item.description = parts.join(' · ');
    item.command = { command: 'extension.open', title: 'Show Extension', arguments: [r.id] };
    item.tooltip = this.tooltip(r, mismatch);
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
    return undefined;
  }

  private tooltip(r: ExtensionRow, mismatch: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${r.displayName}**  \n\`${r.id}\` · v${r.version} · ${r.publisher}\n\n`);
    if (r.description) md.appendMarkdown(`${r.description}\n\n`);
    md.appendMarkdown(`**This folder:** ${r.override ? (r.override === 'on' ? 'ON (folder setting)' : 'OFF (folder setting)') : 'same as global'}  \n`);
    md.appendMarkdown(`**Global setting:** ${r.globallyEnabled ? 'on' : 'off'}  \n`);
    md.appendMarkdown(`**Starts:** ${this.activationDetail(r.activation)}  \n`);
    md.appendMarkdown(`**Now:** ${r.active ? 'running' : r.running ? 'loaded, not started yet' : 'not loaded'}`);
    if (r.categories.length) md.appendMarkdown(`  \n**Categories:** ${r.categories.join(', ')}`);
    if (r.locked) md.appendMarkdown('\n\nExtension Loadout always stays on so you can change the loadout.');
    if (mismatch) {
      md.appendMarkdown(
        r.desiredOn
          ? '\n\n$(warning) The loadout turns this on, but it is not running. It may need an extension it depends on, or it may not support this VS Code.'
          : '\n\n$(warning) The loadout turns this off, but it is still running. Another extension may depend on it.',
      );
    }
    md.supportThemeIcons = true;
    return md;
  }

  private activationDetail(a: Activation): string {
    if (a.kind === 'none') return 'never runs code (theme, snippets, grammar or similar)';
    if (a.kind === 'always') return 'every time VS Code opens a window';
    const why: string[] = [];
    if (a.languages.length) why.push(`when you open ${a.languages.join(', ')} files`);
    if (a.files.length) why.push(`when the folder contains ${a.files.slice(0, 3).join(', ')}`);
    return why.length ? why.join('; ') : 'only when you use one of its commands or views';
  }
}
