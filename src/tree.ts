// 사이드바: "이 워크스페이스에서 켬 / 끔 / 전역 설정 따름" 세 묶음으로 확장을 보여준다.
import * as vscode from 'vscode';
import { ExtensionRow, LoadoutSnapshot } from './model';

type GroupKind = 'on' | 'off' | 'global';

export type Node =
  | { kind: 'group'; group: GroupKind; rows: ExtensionRow[] }
  | { kind: 'ext'; row: ExtensionRow; pending: boolean }
  | { kind: 'notice'; label: string; detail?: string; icon: string; command?: vscode.Command };

const GROUP_LABEL: Record<GroupKind, string> = {
  on: 'Turned on here',
  off: 'Turned off here',
  global: 'Following global setting',
};

export class LoadoutTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private snap?: LoadoutSnapshot;

  refresh(snap: LoadoutSnapshot | undefined): void {
    this.snap = snap;
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    const snap = this.snap;
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
      const by = (g: GroupKind) =>
        snap.rows.filter((r) => (g === 'global' ? !r.override : r.override === g));
      for (const g of ['on', 'off', 'global'] as GroupKind[]) out.push({ kind: 'group', group: g, rows: by(g) });
      return out;
    }
    if (node.kind === 'group') return node.rows.map((row) => ({ kind: 'ext', row, pending: snap.pending }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        GROUP_LABEL[node.group],
        node.group === 'global' && node.rows.length > 15
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(node.rows.length);
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
    const item = new vscode.TreeItem(r.displayName);
    item.id = r.id;
    const state = r.override ?? (r.globallyEnabled ? 'global-on' : 'global-off');
    item.contextValue = `ext:${state}:${r.locked ? 'locked' : 'switchable'}`;
    // 적용이 끝났는데도 원하는 상태와 실제 실행 상태가 다르면 경고로 보여준다.
    const mismatch = !node.pending && !r.locked && r.desiredOn !== r.running;
    const parts = [r.id];
    if (!r.override) parts.push(r.globallyEnabled ? 'on globally' : 'off globally');
    if (mismatch) parts.push(r.desiredOn ? 'not running' : 'still running');
    item.description = parts.join(' · ');
    item.iconPath = mismatch
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : r.desiredOn
        ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor(r.override ? 'testing.iconPassed' : 'foreground'))
        : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${r.displayName}** \`${r.id}\` v${r.version}\n\n`);
    if (r.description) md.appendMarkdown(`${r.description}\n\n`);
    md.appendMarkdown(`Global setting: ${r.globallyEnabled ? 'on' : 'off'}  \n`);
    md.appendMarkdown(`This workspace: ${r.override ? `turned ${r.override}` : 'follows global'}  \n`);
    md.appendMarkdown(`Running now: ${r.running ? 'yes' : 'no'}`);
    if (r.locked) md.appendMarkdown('\n\nExtension Loadout always stays on so you can change the loadout.');
    if (mismatch) {
      md.appendMarkdown(
        r.desiredOn
          ? '\n\nThe loadout turns this on, but it is not running. It may need an extension it depends on, or it may not support this VS Code.'
          : '\n\nThe loadout turns this off, but it is still running. Another extension may depend on it.',
      );
    }
    item.tooltip = md;
    return item;
  }
}
