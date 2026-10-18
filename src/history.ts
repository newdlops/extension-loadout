// 적용 기록과 되돌리기. 적용할 때마다 대상 저장소의 직전 값과 loadout 파일의 직전 내용을 남긴다.
import { DISABLED_KEY, ENABLED_KEY } from './loadout';
import type { PlanTarget } from './plan';

export const HISTORY_LIMIT = 10;

export interface HistoryTarget {
  dbPath: string;
  label?: string;
  /** 적용 직전 저장소 값. null은 키가 없었음. */
  before: Record<string, string | null>;
}

export interface HistoryEntry {
  time: number;
  label: string;
  targets: HistoryTarget[];
  /** 이 창의 loadout 파일. before가 null이면 파일이 없었다. */
  config?: { path: string; before: string | null };
}

export const KEYS = [ENABLED_KEY, DISABLED_KEY];

export function pushHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list].slice(0, HISTORY_LIMIT);
}

/** 되돌리기 계획: 각 저장소를 직전 값으로. */
export function undoTargets(entry: HistoryEntry): PlanTarget[] {
  return entry.targets.map((t) => ({
    dbPath: t.dbPath,
    label: t.label,
    items: Object.fromEntries(KEYS.map((k) => [k, t.before[k] ?? null])),
  }));
}
