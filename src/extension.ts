import * as vscode from 'vscode';
import { LoadoutController } from './controller';
import { Dashboard } from './dashboard';
import { Override } from './loadout';
import { sqliteAvailable } from './stateDb';
import type { Node } from './tree';

const t = vscode.l10n.t;

/** 명령 인자를 확장 ID 목록으로. 트리에서 여러 줄을 골랐으면 두 번째 인자로 모두 들어온다. */
function idsOf(target: unknown, many?: unknown): string[] {
  const list = Array.isArray(many) && many.length ? many : Array.isArray(target) ? target : [target];
  return list.flatMap((x) => (typeof x === 'string' ? [x] : (x as Node | undefined)?.kind === 'ext' ? [(x as Extract<Node, { kind: 'ext' }>).row.id] : []));
}

export function activate(context: vscode.ExtensionContext): LoadoutController | undefined {
  if (!sqliteAvailable()) {
    void vscode.window.showErrorMessage(t('Extension Loadout needs VS Code 1.101 or newer.'));
    return undefined;
  }
  const started = Date.now();
  const c = new LoadoutController(context);
  context.subscriptions.push(c);

  const set = async (target: unknown, many: unknown, value: Override | undefined) => {
    const ids = idsOf(target, many);
    const n = await c.set(ids, value);
    if (ids.length > 1 && n) c.offerApply(n === 1 ? t('Updated 1 extension for this folder.') : t('Updated {0} extensions for this folder.', n));
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('extensionLoadout.applyAndRestart', () => c.applyNow());
  reg('extensionLoadout.applyOnQuit', () => c.applyOnQuit());
  reg('extensionLoadout.cancelApplyOnQuit', () => c.cancelApplyOnQuit());
  reg('extensionLoadout.applyMenu', () => c.applyMenu());
  reg('extensionLoadout.applyToOtherFolders', () => c.applyToOtherFolders());
  reg('extensionLoadout.undo', () => c.undo());
  reg('extensionLoadout.resetToGlobal', () => c.resetToGlobal());
  reg('extensionLoadout.pick', () => c.pick());
  reg('extensionLoadout.suggest', () => c.suggest());
  reg('extensionLoadout.disableSuggested', () => c.turnOffSuggested());
  reg('extensionLoadout.disableSelected', () => c.turnOffSelected());
  reg('extensionLoadout.disableLearned', () => c.turnOffLearned());
  reg('extensionLoadout.installRecommended', (n?: { kind: string; id: string } | string) => {
    const id = typeof n === 'string' ? n : n?.id;
    if (id) void c.installRecommended(id);
  });
  reg('extensionLoadout.savePreset', () => c.savePreset());
  reg('extensionLoadout.applyPreset', () => c.applyPreset());
  reg('extensionLoadout.deletePreset', () => c.deletePreset());
  reg('extensionLoadout.viewOptions', () => c.chooseViewOptions());
  reg('extensionLoadout.openDashboard', () => Dashboard.show(c));
  reg('extensionLoadout.clearSelection', () => c.tree.clearSelection());
  reg('extensionLoadout.enableHere', (n?: unknown, many?: unknown) => set(n, many, 'on'));
  reg('extensionLoadout.disableHere', (n?: unknown, many?: unknown) => set(n, many, 'off'));
  reg('extensionLoadout.followGlobal', (n?: unknown, many?: unknown) => set(n, many, undefined));
  reg('extensionLoadout.refresh', async () => {
    await c.refresh();
    void c.measureMemory();
  });
  reg('extensionLoadout.showMemory', () => c.showMemory());
  reg('extensionLoadout.measureMemory', () => c.measureMemory());
  reg('extensionLoadout.restartExtensionHost', () => c.restartExtensionHost());
  reg('extensionLoadout.openConfig', async () => {
    const st = await c.requireWorkspace();
    if (!st) return;
    if (c.model.readConfigText() === undefined) await c.model.save([], st);
    await vscode.window.showTextDocument(vscode.Uri.file(c.model.configPath!));
    await c.refresh();
  });

  // 테스트용 명령(밑줄로 시작해 명령 팔레트에 나오지 않는다).
  reg('_extensionLoadout.suggestions', async () => (await c.currentSuggestions()).map((x) => x.id));
  reg('_extensionLoadout.memory', async () => (await c.measureMemory()).map((m) => ({ id: m.id, bytes: m.bytes, pids: m.pids.length, all: m.allWindowsBytes })));
  reg('_extensionLoadout.pressure', () => c.checkPressure());
  // 의존 관계 확인을 묻지 않고(all/only) 바꾼다.
  reg('_extensionLoadout.set', (ids: string[], value: Override | undefined, mode: 'all' | 'only' = 'all') => c.set(ids, value, mode));
  reg('_extensionLoadout.savePreset', (name: string) => c.savePreset(name));
  reg('_extensionLoadout.applyPreset', (name: string) => c.applyPreset(name));
  reg('_extensionLoadout.presets', () => c.presets().map((p) => ({ name: p.name, rules: p.rules })));
  reg('_extensionLoadout.recommendations', async () => {
    await c.currentSuggestions();
    const r = c.repoRecommendations();
    return { recommended: [...r.recommended], unwanted: [...r.unwanted], learned: c.learnedList().map((x) => x.id), signature: await c.folderSignature() };
  });
  reg('_extensionLoadout.setViewOptions', (opts: object) => c.setViewOptions(opts));
  reg('_extensionLoadout.dashboard', async (message?: object) => {
    const d = Dashboard.show(c);
    if (message) await d.handle(message as Parameters<Dashboard['handle']>[0]);
    const data = (await d.data()) as { rows: { id: string; memory: number }[] } | undefined;
    return { rows: data?.rows.length ?? 0, ids: data?.rows.map((r) => r.id) ?? [], html: d.panel.webview.html.includes('Content-Security-Policy') };
  });
  reg('_extensionLoadout.tree', async () => {
    const out: object[] = [];
    for (const n of await c.tree.getChildren()) {
      if (n.kind === 'notice') out.push({ notice: n.label });
      if (n.kind !== 'group') continue;
      const kids = await c.tree.getChildren(n);
      out.push({ group: n.group, items: kids.map((k) => (k.kind === 'ext' ? k.row.id : k.kind === 'missing' ? `missing:${k.id}` : `notice:${k.kind === 'notice' ? k.label : ''}`)) });
    }
    return out;
  });
  reg('_extensionLoadout.select', (ids: string[]) => c.tree.select(ids));
  reg('_extensionLoadout.applyOnQuit', () => c.applyOnQuit());
  reg('_extensionLoadout.undo', () => c.undo(false));
  reg('_extensionLoadout.applyToFolders', async (folders: string[], mode: 'now' | 'quit' = 'now') => {
    const { worktrees, others } = await c.otherFolderCandidates();
    const picked = [...worktrees, ...others].filter((e) => folders.some((f) => e.folder.toLowerCase() === f.toLowerCase()));
    if (mode === 'quit') await c.applyOnQuit(picked);
    else await c.applyNow(picked);
    return picked.map((p) => p.folder);
  });
  reg('_extensionLoadout.state', async () => {
    const st = await c.refresh();
    return { pending: st?.pending, scheduled: c.scheduledHere(), history: c.history().length, overrides: Object.fromEntries(st?.overrides ?? []), errors: st?.configErrors, conflicts: st?.conflicts };
  });

  void c.refresh().then((first) => {
    // 저장소에 커밋된 loadout을 처음 연 경우처럼, 파일과 실제 적용 상태가 다르면 한 번 알려준다.
    if (first?.pending && !c.current?.configErrors.length) {
      void vscode.window
        .showInformationMessage(t("This workspace has an extension loadout that isn't applied yet."), t('Apply and Restart'), t('Apply When VS Code Quits'), t('Show Loadout'))
        .then((choice) => {
          if (choice === t('Apply and Restart')) void c.applyNow();
          if (choice === t('Apply When VS Code Quits')) void c.applyOnQuit();
          if (choice === t('Show Loadout')) void vscode.commands.executeCommand('extensionLoadout.extensions.focus');
        });
    }
    c.output.info(`Activated in ${Date.now() - started} ms`);
  });
  return c;
}

export function deactivate(): void {}
