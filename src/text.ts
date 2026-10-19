// 화면에 보일 문장(번역). 순수 모듈은 데이터만 돌려주고, 문장은 여기서 vscode.l10n으로 만든다.
import * as vscode from 'vscode';
import type { Activated } from './activations';
import type { Activation } from './catalog';
import type { LearnedSuggestion } from './learning';
import type { Pressure, PressureLevel } from './pressure';
import type { Suggestion } from './recommend';

const t = vscode.l10n.t;

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** 목록에 짧게 보여줄 "언제 켜지는지". */
export function startsText(a: Activation, packCount = 0): string {
  if (packCount) return t('pack · {0}', packCount);
  if (a.kind === 'none') return t('no code');
  if (a.kind === 'always') return t('⚡ always');
  if (a.languages.length) return a.languages.slice(0, 3).join(', ') + (a.languages.length > 3 ? ', …' : '');
  if (a.files.length) return t('when {0} exists', a.files[0]);
  return t('on demand');
}

/** 이름 몇 개를 "A, B, C +2"처럼. */
const names = (list: string[], max = 3) => list.slice(0, max).join(', ') + (list.length > max ? ` +${list.length - max}` : '');

/** name: 확장 ID → 화면 이름. 연쇄 추천 문장에 쓴다. */
export function suggestionText(s: Suggestion, name: (id: string) => string = (id) => id): string {
  if (!s.what) return s.reason;
  const none = s.what.join(', ') + (s.more ? ', …' : '');
  if (s.generic?.length && s.started?.length) return t('Started {0} because of {1} files; no {2} here', names(s.started.map(name)), s.generic.join(', '), none);
  return t('No {0} in this folder', none);
}

/** 이 창에서 왜 켜졌는지. causes는 가까운 원인부터 처음 원인까지(activations.causesOf). */
export function startedText(a: Activated, causes: string[], name: (id: string) => string): string {
  if (causes.length) {
    const root = causes[causes.length - 1];
    const via = causes.slice(0, -1).reverse().map(name);
    return via.length ? t('started by {0} (via {1})', name(root), via.join(' → ')) : t('started by {0}', name(root));
  }
  const [kind, ...restParts] = a.event.split(':');
  const rest = restParts.join(':');
  if (a.event === '*') return t('at startup, in every window');
  if (kind === 'onStartupFinished') return t('after startup, in every window');
  if (kind === 'onLanguage') return t('when a {0} file was opened', rest);
  // VS Code는 패턴을 모두 이어 붙여 기록하므로 어느 것이 맞았는지는 알 수 없다.
  if (kind === 'workspaceContains') {
    const list = rest.split(',');
    return t('because the folder has one of: {0}', list.slice(0, 6).join(', ') + (list.length > 6 ? ', …' : ''));
  }
  if (kind === 'onCommand') return t('when {0} was run', rest);
  if (kind === 'onView') return t('when its view was shown');
  return a.event;
}

/** 목록에 짧게: 다른 확장이 켰으면 "started by Ruff". */
export function startedShort(causes: string[], name: (id: string) => string): string | undefined {
  return causes.length ? t('started by {0}', name(causes[causes.length - 1])) : undefined;
}

export function learnedText(l: LearnedSuggestion): string {
  return l.folders.length === 1
    ? t('You turned it off in {0}, a similar folder', l.folders[0])
    : t('You turned it off in {0} similar folders: {1}', l.folders.length, l.folders.slice(0, 3).join(', '));
}

export function levelText(level: PressureLevel): string {
  return { normal: t('normal'), warn: t('tight'), critical: t('critical') }[level];
}

export function pressureText(p: Pressure): string {
  const head = t('Memory pressure: {0}', levelText(p.level));
  const parts = [head];
  if (p.free !== undefined && p.total) parts.push(t('{0} of {1} free', gb(p.free), gb(p.total)));
  if (p.swapUsed !== undefined && p.swapTotal) parts.push(t('swap {0} / {1}', gb(p.swapUsed), gb(p.swapTotal)));
  // 스왑이 분당 64MB 이상 늘 때만 보인다. 그보다 적으면 잡음이다.
  if (p.swapRate !== undefined && p.swapRate >= 64 * 1024 ** 2) parts.push(t('swap growing {0} per minute', `${Math.round(p.swapRate / 1024 ** 2)} MB`));
  if (p.compressed !== undefined && p.physical) parts.push(t('compressed {0} of {1}', gb(p.compressed), gb(p.physical)));
  return parts.join(' · ');
}

/** loadout 파일 오류(영어로 만들어진 정해진 형식)를 번역한다. 모르는 형식은 그대로 둔다. */
export function localizeError(message: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^Not valid JSON: (.+) at offset (\d+)$/, (m) => t('Not valid JSON: {0} at offset {1}', m[1], m[2])],
    [/^The loadout file must be a JSON object with "enable" and "disable" lists\.$/, () => t('The loadout file must be a JSON object with "enable" and "disable" lists.')],
    [/^"(enable|disable)" must be a list of extension IDs or patterns\.$/, (m) => t('"{0}" must be a list of extension IDs or patterns.', m[1])],
    [/^"(enable|disable)" has an entry that is not an extension ID or pattern: (.*)$/, (m) => t('"{0}" has an entry that is not an extension ID or pattern: {1}', m[1], m[2])],
    [/^"notes" must be an object/, () => t('"notes" must be an object of { "id or pattern": "note" }.')],
    [/^(\S+) is listed in both "enable" and "disable"\.$/, (m) => t('{0} is listed in both "enable" and "disable".', m[1])],
    [/^(\S+) matches both "(.+)" \(enable\) and "(.+)" \(disable\); list it explicitly\.$/, (m) => t('{0} matches both "{1}" (enable) and "{2}" (disable); list it explicitly.', m[1], m[2], m[3])],
    [/^(\S+) is turned on in (.+) but off in (.+); keeping it on\.$/, (m) => t('{0} is turned on in {1} but off in {2}; keeping it on.', m[1], m[2], m[3])],
  ];
  const tryRules = (text: string) => {
    for (const [re, fn] of rules) {
      const m = re.exec(text);
      if (m) return fn(m);
    }
    return undefined;
  };
  // 멀티 루트에서는 "폴더 이름: 오류" 형식이다.
  const prefixed = /^([^:]+): (.+)$/s.exec(message);
  return tryRules(message) ?? (prefixed && tryRules(prefixed[2]) !== undefined ? `${prefixed[1]}: ${tryRules(prefixed[2])}` : message);
}
