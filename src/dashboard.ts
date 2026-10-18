// 표 형태 대시보드(편집기 탭). 필요할 때만 열고, 숨겨진 동안에는 내용을 붙잡아 두지 않는다(retainContextWhenHidden 없음).
// 화면은 media/dashboard.js가 그리고, 바꾸는 일은 모두 controller를 거친다.
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LoadoutController } from './controller';
import { buildDashRows } from './dashboardModel';
import { Override } from './loadout';
import { formatBytes } from './processes';
import { learnedText, localizeError, pressureText, startsText, suggestionText } from './text';

const t = vscode.l10n.t;

type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'set'; ids: string[]; value: Override | 'global' }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'open'; id: string };

/** 웹뷰에서 부를 수 있는 명령(그 밖의 명령은 무시한다). */
const ALLOWED = new Set([
  'extensionLoadout.applyAndRestart',
  'extensionLoadout.applyOnQuit',
  'extensionLoadout.cancelApplyOnQuit',
  'extensionLoadout.applyToOtherFolders',
  'extensionLoadout.undo',
  'extensionLoadout.resetToGlobal',
  'extensionLoadout.savePreset',
  'extensionLoadout.applyPreset',
  'extensionLoadout.openConfig',
  'extensionLoadout.restartExtensionHost',
  'extensionLoadout.suggest',
  'extensionLoadout.measureMemory',
]);

export class Dashboard implements vscode.Disposable {
  private static current?: Dashboard;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  static show(c: LoadoutController): Dashboard {
    if (Dashboard.current) {
      Dashboard.current.panel.reveal();
      return Dashboard.current;
    }
    const roots = [
      vscode.Uri.joinPath(c.context.extensionUri, 'media'),
      vscode.Uri.file(c.model.extensionsDir()),
      vscode.Uri.file(path.join(vscode.env.appRoot, 'extensions')),
    ];
    const panel = vscode.window.createWebviewPanel('extensionLoadout.dashboard', t('Extension Loadout'), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: roots,
    });
    panel.iconPath = vscode.Uri.joinPath(c.context.extensionUri, 'media', 'loadout.svg');
    Dashboard.current = new Dashboard(c, panel);
    return Dashboard.current;
  }

  static get open(): Dashboard | undefined {
    return Dashboard.current;
  }

  private constructor(
    private readonly c: LoadoutController,
    readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m)),
      c.onDidChange(() => this.schedule()),
      panel.onDidChangeViewState(() => panel.visible && this.schedule()),
    );
    void c.measureMemory();
  }

  dispose(): void {
    Dashboard.current = undefined;
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  /** 여러 변경이 몰려도 한 번만 다시 보낸다. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.post(), 150);
  }

  async handle(m: FromWebview): Promise<void> {
    if (m.type === 'ready' || m.type === 'refresh') {
      if (m.type === 'refresh') await this.c.refresh();
      await this.post();
    } else if (m.type === 'set') {
      const n = await this.c.set(m.ids, m.value === 'global' ? undefined : m.value);
      if (m.ids.length > 1 && n) this.c.offerApply(t('Updated {0} extensions for this folder.', n));
    } else if (m.type === 'command' && ALLOWED.has(m.command)) {
      await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
    } else if (m.type === 'open') {
      await vscode.commands.executeCommand('extension.open', m.id);
    }
  }

  async data(): Promise<object | undefined> {
    const snap = await this.c.snapshot();
    if (!snap) return undefined;
    const pressure = this.c.currentPressure();
    const rows = buildDashRows({
      rows: snap.rows,
      pending: snap.pending,
      memory: this.c.memoryList(),
      suggestions: await this.c.currentSuggestions(),
      learned: this.c.learnedList(),
      recommended: this.c.repoRecommendations().recommended,
      iconUri: (file) => this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(),
      text: { starts: startsText, suggestion: suggestionText, learned: learnedText },
    });
    const totalMemory = this.c.memoryList().reduce((a, m) => a + m.bytes, 0);
    return {
      folder: vscode.workspace.name ?? '',
      rows,
      pending: snap.pending,
      scheduled: this.c.scheduledHere(),
      canUndo: this.c.history().length > 0,
      errors: snap.configErrors.map(localizeError),
      conflicts: snap.conflicts.map(localizeError),
      missing: snap.missing,
      pressure: pressure.level === 'normal' ? undefined : { level: pressure.level, detail: pressureText(pressure) },
      totalMemory: totalMemory ? formatBytes(totalMemory) : '',
    };
  }

  private async post(): Promise<void> {
    if (!this.panel.visible) return;
    const data = await this.data();
    void this.panel.webview.postMessage({ type: 'data', data });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const webview = this.panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.c.context.extensionUri, 'media', f));
    const strings = {
      search: t('Search extensions'),
      all: t('All'),
      running: t('Running here'),
      always: t('⚡ Always'),
      memory: t('Using memory'),
      suggested: t('Suggested'),
      changed: t('Set in this folder'),
      extension: t('Extension'),
      here: t('This folder'),
      global: t('Global'),
      starts: t('Starts'),
      now: t('Now'),
      mem: t('Memory'),
      why: t('Why'),
      on: t('ON'),
      off: t('OFF'),
      follow: t('Global'),
      onGlobally: t('on'),
      offGlobally: t('off'),
      isRunning: t('running'),
      loaded: t('loaded'),
      notLoaded: t('—'),
      selected: t('{0} selected'),
      turnOff: t('Turn off here'),
      turnOn: t('Turn on here'),
      sameAsGlobal: t('Same as global'),
      clear: t('Clear'),
      pending: t('The loadout changed. Apply it to start or stop extensions.'),
      applyNow: t('Apply and restart'),
      applyOnQuit: t('Apply when VS Code quits'),
      scheduled: t('The loadout will be applied when you quit VS Code.'),
      cancel: t('Cancel'),
      memoryTight: t('Memory is tight'),
      restartHost: t('Restart extension host'),
      undo: t('Undo last apply'),
      otherFolders: t('Apply to other folders…'),
      savePreset: t('Save as preset…'),
      applyPreset: t('Apply preset…'),
      openFile: t('Open loadout file'),
      refresh: t('Refresh'),
      reset: t('Reset folder'),
      suggest: t('Check again'),
      noRows: t('No extensions match.'),
      suggestion: t('not needed here'),
      learned: t('you usually turn it off'),
      repo: t('recommended by this repo'),
      mismatchOn: t('not running yet'),
      mismatchOff: t('still running'),
      locked: t('always on'),
      builtin: t('built-in'),
      processes: t('processes'),
      allWindows: t('all windows'),
      total: t('Extension processes in this window: {0}'),
    };
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('dashboard.css')}">
<title>Extension Loadout</title>
</head>
<body>
<div id="app" data-strings="${encodeURIComponent(JSON.stringify(strings))}" data-default-icon="${media('extension-default.svg')}"></div>
<script nonce="${nonce}" src="${media('dashboard.js')}"></script>
</body>
</html>`;
  }
}
