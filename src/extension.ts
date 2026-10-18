import * as fs from 'fs';
import * as vscode from 'vscode';
import { Override, normalizeId, overridesFromSelection, storedValuesFor } from './loadout';
import { LoadoutModel, LoadoutSnapshot, LoadoutStatus } from './model';
import { logPath, restartWith } from './restart';
import { sqliteAvailable } from './stateDb';
import { activationText } from './catalog';
import type { Suggestion } from './recommend';
import { computeSuggestions } from './suggestions';
import { LoadoutTree, Node, summaryOf } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  if (!sqliteAvailable()) {
    vscode.window.showErrorMessage('Extension Loadout needs VS Code 1.101 or newer.');
    return;
  }
  const started = Date.now();
  const model = new LoadoutModel(context);
  const output = vscode.window.createOutputChannel('Extension Loadout', { log: true });
  const report = (what: string, e: unknown) => {
    output.error(what, e as Error);
    vscode.window.showErrorMessage(`Extension Loadout: ${what}: ${(e as Error).message}`);
  };
  // 설치 목록 전체는 목록 화면이 그려질 때만 읽는다.
  const tree = new LoadoutTree(async () => {
    if (!model.workspaceDbPath) return undefined;
    try {
      return await model.snapshot();
    } catch (e) {
      report('could not read the extension state', e);
      return undefined;
    }
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  // 전용 액티비티 바 패널과 탐색기 사이드바 양쪽에 같은 목록을 띄운다.
  const views = [
    vscode.window.createTreeView('extensionLoadout.extensions', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.createTreeView('extensionLoadout.explorer', { treeDataProvider: tree, showCollapseAll: true }),
  ];

  // 추천은 목록을 처음 그릴 때 한 번, 그리고 확장이 바뀌거나 사용자가 다시 찾을 때만 계산한다.
  let suggestions: Promise<Suggestion[]> | undefined;
  const findSuggestions = (snap: LoadoutSnapshot) => {
    suggestions = computeSuggestions(snap, output).catch((e) => {
      output.error('Could not check which extensions this folder needs', e as Error);
      return [];
    });
    void suggestions.then((list) => tree.setSuggestions(list));
    return suggestions;
  };

  context.subscriptions.push(
    output,
    status,
    ...views,
    vscode.window.registerFileDecorationProvider(tree),
    vscode.extensions.onDidChange(() => {
      suggestions = undefined;
      tree.invalidate();
    }),
    tree.onDidLoad((snap) => {
      for (const v of views) v.description = snap ? summaryOf(snap) : undefined;
      if (snap && !suggestions) void findSuggestions(snap);
    }),
  );

  /** loadout 파일과 워크스페이스 저장소만 읽어 상태 표시줄을 갱신하고, 목록은 다음에 그릴 때 다시 읽게 한다. */
  const refresh = (): LoadoutStatus | undefined => {
    let st: LoadoutStatus | undefined;
    try {
      st = model.workspaceDbPath ? model.status() : undefined;
    } catch (e) {
      report('could not read the loadout', e);
    }
    tree.invalidate();
    void vscode.commands.executeCommand('setContext', 'extensionLoadout.pending', !!st?.pending);
    if (st?.pending) {
      status.text = '$(debug-restart) Loadout: restart to apply';
      status.tooltip = "This folder's extension loadout changed. Click to apply it and restart VS Code.";
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      status.command = 'extensionLoadout.applyAndRestart';
      status.show();
    } else if (st?.configExists && st.overrides.size) {
      // 이 폴더에 전용 설정이 있으면 몇 개를 켜고 껐는지 늘 보이게 한다. 누르면 목록을 연다.
      const on = [...st.overrides.values()].filter((v) => v === 'on').length;
      status.text = `$(checklist) ${on} on · ${st.overrides.size - on} off`;
      status.tooltip = 'Extension Loadout: extensions turned on / off only in this folder. Click to show them.';
      status.backgroundColor = undefined;
      status.command = 'extensionLoadout.extensions.focus';
      status.show();
    } else {
      status.hide();
    }
    return st;
  };

  const requireWorkspace = (): LoadoutStatus | undefined => {
    const st = refresh();
    if (!st || !model.configPath) {
      vscode.window.showWarningMessage('Open a local folder to set up its extension loadout.');
      return undefined;
    }
    return st;
  };

  const applyAndRestart = async () => {
    const s = requireWorkspace();
    if (!s) return;
    if (s.configErrors.length) {
      vscode.window.showErrorMessage(`Fix the loadout file first: ${s.configErrors[0]}`);
      return;
    }
    if (!s.configExists) await model.save(new Map(s.overrides));
    const uuid = new Map((await model.snapshot(s)).rows.map((r) => [r.id, r.uuid]));
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
    const globallyEnabled = !model.readGloballyDisabled().has(id);
    // 전역 설정과 같은 상태로 "강제"하는 것은 의미가 없으므로 전역 따름으로 정리한다.
    if (value === undefined || (value === 'on') === globallyEnabled) next.delete(id);
    else next.set(id, value);
    await model.save(next);
    refresh();
  };

  const pick = async () => {
    const st = requireWorkspace();
    if (!st) return;
    const s = await model.snapshot(st);
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = s.rows
      .filter((r) => !r.locked)
      .map((r) => ({
        id: r.id,
        label: r.displayName,
        description: r.id,
        detail:
          (r.override === 'on' ? 'ON in this folder' : r.override === 'off' ? 'OFF in this folder' : 'Same as global') +
          ` · ${r.globallyEnabled ? 'on' : 'off'} globally · ${activationText(r.activation)}`,
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

  const turnOffSuggested = async () => {
    const s = requireWorkspace();
    if (!s) return;
    const targets = tree.activeSuggestions().map((x) => x.row);
    if (!targets.length) return;
    const next = new Map(s.overrides);
    for (const r of targets) {
      if (r.globallyEnabled) next.set(r.id, 'off');
      else next.delete(r.id);
    }
    await model.save(next);
    const after = refresh();
    if (after?.pending) {
      const go = await vscode.window.showInformationMessage(
        `Turned off ${targets.length} extension${targets.length > 1 ? 's' : ''} for this folder. Restart VS Code to apply?`,
        'Apply and Restart',
        'Later',
      );
      if (go === 'Apply and Restart') await applyAndRestart();
    }
  };

  const suggest = async () => {
    const st = requireWorkspace();
    if (!st) return;
    await vscode.window.withProgress({ location: { viewId: 'extensionLoadout.extensions' } }, async () => {
      const list = await findSuggestions(await model.snapshot(st));
      if (!list.length) vscode.window.showInformationMessage('Nothing here is certainly unneeded. Every extension that starts on its own could be used in this folder.');
    });
    await vscode.commands.executeCommand('extensionLoadout.extensions.focus');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('extensionLoadout.suggest', suggest),
    vscode.commands.registerCommand('extensionLoadout.disableSuggested', turnOffSuggested),
    // 테스트용: 현재 추천 목록(ID). 아직 계산하지 않았으면 계산한다.
    vscode.commands.registerCommand('_extensionLoadout.suggestions', async () => {
      const st = refresh();
      if (!st) return [];
      const list = await (suggestions ?? findSuggestions(await model.snapshot(st)));
      return list.map((x) => x.id);
    }),
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
  output.info(`Activated in ${Date.now() - started} ms`);
}

export function deactivate(): void {}
