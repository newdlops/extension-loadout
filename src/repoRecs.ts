// 저장소가 권장하는 확장(.vscode/extensions.json, .code-workspace의 "extensions").
// recommendations는 "이 저장소 권장"으로 표시하고, unwantedRecommendations는 "확실히 필요 없음"의 근거로 쓴다.
import { parse } from 'jsonc-parser';
import { normalizeId } from './loadout';

export interface RepoRecommendations {
  recommended: Set<string>;
  unwanted: Set<string>;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(normalizeId) : []);

/** extensions.json 본문, 또는 .code-workspace 본문(안의 "extensions" 키)을 읽는다. */
export function parseRecommendations(text: string, fromWorkspaceFile = false): RepoRecommendations {
  const data = parse(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  const section = (fromWorkspaceFile ? data?.extensions : data) as Record<string, unknown> | undefined;
  return { recommended: new Set(ids(section?.recommendations)), unwanted: new Set(ids(section?.unwantedRecommendations)) };
}

export function mergeRecommendations(list: RepoRecommendations[]): RepoRecommendations {
  const out: RepoRecommendations = { recommended: new Set(), unwanted: new Set() };
  for (const r of list) {
    for (const id of r.recommended) out.recommended.add(id);
    for (const id of r.unwanted) out.unwanted.add(id);
  }
  // 어느 쪽에서든 권장하면 원치 않음으로 보지 않는다.
  for (const id of out.recommended) out.unwanted.delete(id);
  return out;
}
