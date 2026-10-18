// 대시보드(표)에 보낼 데이터. vscode 모듈에 의존하지 않는다.
import type { Activation } from './catalog';
import type { LearnedSuggestion } from './learning';
import type { ExtensionRow } from './model';
import type { ExtMemory } from './processes';
import type { Suggestion } from './recommend';

export interface DashRow {
  id: string;
  name: string;
  publisher: string;
  version: string;
  description?: string;
  /** 웹뷰에서 쓸 수 있는 아이콘 URI(없으면 기본 아이콘). */
  icon?: string;
  /** on/off: 이 폴더 전용 설정, global: 전역 설정을 따름. */
  here: 'on' | 'off' | 'global';
  globallyEnabled: boolean;
  desiredOn: boolean;
  running: boolean;
  active: boolean;
  starts: string;
  startsAlways: boolean;
  /** 이 창에서 쓰는 메모리(바이트, 없으면 0). */
  memory: number;
  allWindowsMemory: number;
  processes: number;
  /** "필요 없음" 추천 사유. */
  suggestion?: string;
  /** 내 결정에서 배운 제안 사유. */
  learned?: string;
  recommendedByRepo: boolean;
  note?: string;
  via?: string;
  locked: boolean;
  builtin: boolean;
  pack: string[];
  needs: string[];
  /** 적용이 끝났는데도 원하는 상태와 실제 상태가 다른지. */
  mismatch: boolean;
}

export function buildDashRows(input: {
  rows: ExtensionRow[];
  pending: boolean;
  memory: ExtMemory[];
  suggestions: Suggestion[];
  learned: LearnedSuggestion[];
  recommended: Set<string>;
  iconUri: (file: string) => string;
  /** 문장 만들기(번역). */
  text: {
    starts: (a: Activation, packCount: number) => string;
    suggestion: (s: Suggestion) => string;
    learned: (l: LearnedSuggestion) => string;
  };
}): DashRow[] {
  const mem = new Map(input.memory.map((m) => [m.id, m]));
  const sug = new Map(input.suggestions.map((s) => [s.id, input.text.suggestion(s)]));
  const lrn = new Map(input.learned.map((l) => [l.id, input.text.learned(l)]));
  return input.rows.map((r) => {
    const m = mem.get(r.id);
    return {
      id: r.id,
      name: r.displayName,
      publisher: r.publisher,
      version: r.version,
      description: r.description,
      icon: r.icon ? input.iconUri(r.icon) : undefined,
      here: r.override ?? 'global',
      globallyEnabled: r.globallyEnabled,
      desiredOn: r.desiredOn,
      running: r.running,
      active: r.active,
      starts: input.text.starts(r.activation, r.packMembers.length),
      startsAlways: r.activation.kind === 'always',
      memory: m?.bytes ?? 0,
      allWindowsMemory: m?.allWindowsBytes ?? 0,
      processes: m?.pids.length ?? 0,
      suggestion: r.desiredOn && r.override !== 'on' ? sug.get(r.id) : undefined,
      learned: r.desiredOn && r.override !== 'on' && !sug.has(r.id) ? lrn.get(r.id) : undefined,
      recommendedByRepo: input.recommended.has(r.id),
      note: r.note,
      via: r.via,
      locked: r.locked,
      builtin: !!r.builtin,
      pack: r.packMembers,
      needs: r.dependencies,
      mismatch: !input.pending && !r.locked && r.desiredOn !== r.running,
    };
  });
}
