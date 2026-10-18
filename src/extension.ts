import * as fs from 'fs';
import * as vscode from 'vscode';
import { Override, normalizeId, overridesFromSelection, storedValuesFor } from './loadout';
import { LoadoutModel, LoadoutSnapshot } from './model';
import { logPath, restartWith } from './restart';
import { sqliteAvailable } from './stateDb';
import { LoadoutTree, Node } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  if (!sqliteAvailable()) {
    vscode.window.showErrorMessage('Extension Loadout needs VS Code 1.101 or newer.');
    return;
  }
  const model = new LoadoutModel(context);
  const tree = new LoadoutTree();
  const output = vscode.window.createOutputChannel('Extension Loadout', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'extensionLoadout.applyAndRestart';
  // 전용 액티비티 바 패널과 탐색기 사이드바 양쪽에 같은 목록을 띄운다.
  context.subscriptions.push(
    output,
    status,
    vscode.window.createTreeView('extensionLoadout.extensions', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.createTreeView('extensionLoadout.explorer', { treeDataProvider: tree, showCollapseAll: true }),
  );

  let snap: LoadoutSnapshot | undefined;
  const refresh = (): LoadoutSnapshot | undefined => {
    try {
      snap = model.workspaceDbPath ? model.snapshot() : undefined;
    } catch (e) {
      snap = undefined;
      output.error('Could not read the extension state', e as Error);
      vscode.window.showErrorMessage(`Extension Loadout could not read the extension state: ${(e as Error).message}`);
    }
    tree.refresh(snap);
    void vscode.commands.executeCommand('setContext', 'extensionLoadout.pending', !!snap?.pending);
    if (snap?.pending) {
      status.text = '$(debug-restart) Loadout: restart to apply';
      status.tooltip = 'This workspace\'s extension loadout changed. Click to apply it and restart VS Code.';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      status.show();
    } else {
      status.hide();
    }
    return snap;
  };

  const requireWorkspace = (): LoadoutSnapshot | undefined => {
    const s = refresh();
    if (!s || !model.configPath) {
      vscode.window.showWarningMessage('Open a local folder to set up its extension loadout.');
      return undefined;
    }
    return s;
  };

  const applyAndRestart = async () => {
    const s = requireWorkspace();
    if (!s) return;
    if (s.configErrors.length) {
      vscode.window.showErrorMessage(`Fix the loadout file first: ${s.configErrors[0]}`);
      return;
    }
    if (!s.configExists) await model.save(new Map(s.overrides));
    const uuid = new Map(s.rows.map((r) => [r.id, r.uuid]));
    const items = storedValuesFor(s.overrides, (id) => uuid.get(id));
    try {
      output.info(`Applying loadout to ${model.workspaceDbPath}: ${JSON.stringify(items)}`);
      await restartWith(context, model.workspaceDbPath!, items);
    } catch (e) {
      output.error('Restart failed', e as Error);
      vscode.window.showErrorMessage(`Could not restart VS Code: ${(e as Error).message} (log: ${logPath()})`);
    }
  };

  const setOverride = async (target: Node | string | undefined, value: Override | undefined) => {
    const s = requireWorkspace();
    if (!s) return;
    const id = typeof target === 'string' ? normalizeId(target) : target?.kind === 'ext' ? target.row.id : undefined;
    if (!id || id === model.selfId) return;
    const next = new Map(s.overrides);
    const row = s.rows.find((r) => r.id === id);
    // 전역 설정과 같은 상태로 "강제"하는 것은 의미가 없으므로 전역 따름으로 정리한다.
    if (value === undefined || (row && (value === 'on') === row.globallyEnabled)) next.delete(id);
    else next.set(id, value);
    await model.save(next);
    refresh();
  };

  const pick = async () => {
    const s = requireWorkspace();
    if (!s) return;
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = s.rows
      .filter((r) => !r.locked)
      .map((r) => ({
        id: r.id,
        label: r.displayName,
        description: r.id,
        detail: r.override ? `Turned ${r.override} here · ${r.globallyEnabled ? 'on' : 'off'} globally` : `Follows global setting (${r.globallyEnabled ? 'on' : 'off'})`,
        picked: r.desiredOn,
      }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      title: 'Extensions to run in this workspace',
      placeHolder: 'Checked extensions run here. Unchecked ones are turned off here.',
    });
    if (!chosen) return;
    const next = overridesFromSelection(
      s.rows.filter((r) => !r.locked),
      new Set(chosen.map((c) => c.id)),
      s.overrides,
    );
    await model.save(next);
    const after = refresh();
    if (after?.pending) {
      const go = await vscode.window.showInformationMessage('Loadout saved. Restart VS Code to apply it?', 'Apply and Restart', 'Later');
      if (go === 'Apply and Restart') await applyAndRestart();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('extensionLoadout.applyAndRestart', applyAndRestart),
    vscode.commands.registerCommand('extensionLoadout.pick', pick),
    vscode.commands.registerCommand('extensionLoadout.enableHere', (n?: Node | string) => setOverride(n, 'on')),
    vscode.commands.registerCommand('extensionLoadout.disableHere', (n?: Node | string) => setOverride(n, 'off')),
    vscode.commands.registerCommand('extensionLoadout.followGlobal', (n?: Node | string) => setOverride(n, undefined)),
    vscode.commands.registerCommand('extensionLoadout.refresh', () => refresh()),
    vscode.commands.registerCommand('extensionLoadout.openConfig', async () => {
      const s = requireWorkspace();
      if (!s) return;
      if (!fs.existsSync(model.configPath!)) await model.save(new Map(s.overrides));
      await vscode.window.showTextDocument(vscode.Uri.file(model.configPath!));
      refresh();
    }),
  );

  const folder = model.workspaceFolder;
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/extension-loadout.json'));
    watcher.onDidChange(() => refresh());
    watcher.onDidCreate(() => refresh());
    watcher.onDidDelete(() => refresh());
    context.subscriptions.push(watcher);
  }

  const first = refresh();
  // 저장소에 커밋된 loadout을 처음 연 경우처럼, 파일과 실제 적용 상태가 다르면 한 번 알려준다.
  if (first?.pending) {
    void vscode.window
      .showInformationMessage("This workspace has an extension loadout that isn't applied yet.", 'Apply and Restart', 'Show Loadout')
      .then((choice) => {
        if (choice === 'Apply and Restart') void applyAndRestart();
        if (choice === 'Show Loadout') void vscode.commands.executeCommand('extensionLoadout.extensions.focus');
      });
  }
}

export function deactivate(): void {}
