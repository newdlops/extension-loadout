// 내 결정에서 배우기: 폴더마다 "어떤 스택인지"(표식 파일)와 "무엇을 껐는지"를 기록해 두고,
// 비슷한 스택의 새 폴더에서 같은 확장을 끄자고 제안한다. 근거가 사용자 자신의 선택이라 "확실히 필요 없음"과는 따로 보여준다.
import * as path from 'path';

/** 스택을 알려주는 표식 파일. 저장소 맨 위와 한 단계 아래에서 찾는다. */
export const MARKERS = [
  'package.json', 'tsconfig.json', 'deno.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'manage.py',
  'go.mod', 'Cargo.toml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'gradlew',
  'Gemfile', 'composer.json', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'Dockerfile', 'docker-compose.yml',
  'mix.exs', 'angular.json', '*.csproj', '*.sln', '*.tf', 'next.config.*', 'vite.config.*', 'nuxt.config.*', 'svelte.config.*',
];

export const MARKER_GLOB = `{${MARKERS.flatMap((m) => [m, `*/${m}`]).join(',')}}`;

const markerRe = MARKERS.map((m) => ({ m, re: new RegExp(`^${m.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`, 'i') }));

/** 찾은 파일들(상대 경로) → 표식 이름 목록(정렬, 중복 없음). */
export function signatureOf(found: string[]): string[] {
  const out = new Set<string>();
  for (const f of found) {
    const base = path.basename(f.replace(/\\/g, '/'));
    const hit = markerRe.find(({ re }) => re.test(base));
    if (hit) out.add(hit.m);
  }
  return [...out].sort();
}

export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  return inter / (a.length + b.length - inter);
}

export interface LearnedEntry {
  /** 폴더 경로(같은 폴더는 한 항목만). */
  folder: string;
  name: string;
  signature: string[];
  off: string[];
  on: string[];
  time: number;
}

export const LEARNED_LIMIT = 60;

export function recordDecision(list: LearnedEntry[], entry: LearnedEntry, sameFolder: (a: string, b: string) => boolean): LearnedEntry[] {
  return [entry, ...list.filter((e) => !sameFolder(e.folder, entry.folder))].slice(0, LEARNED_LIMIT);
}

export interface LearnedSuggestion {
  id: string;
  reason: string;
  folders: string[];
}

/**
 * 비슷한 스택(유사도 minSimilarity 이상)의 다른 폴더에서 끈 확장 중, 여기서는 아직 켜져 있고 사용자가 직접 켜지 않은 것.
 */
export function learnedSuggestions(
  list: LearnedEntry[],
  signature: string[],
  folder: string,
  rows: { id: string; desiredOn: boolean; override?: 'on' | 'off'; locked: boolean }[],
  sameFolder: (a: string, b: string) => boolean,
  minSimilarity = 0.6,
): LearnedSuggestion[] {
  const similar = list.filter((e) => !sameFolder(e.folder, folder) && similarity(e.signature, signature) >= minSimilarity);
  const byId = new Map<string, string[]>();
  for (const e of similar) for (const id of e.off) byId.set(id, [...(byId.get(id) ?? []), e.name]);
  const out: LearnedSuggestion[] = [];
  for (const r of rows) {
    const folders = byId.get(r.id);
    if (!folders || !r.desiredOn || r.override === 'on' || r.locked) continue;
    const names = [...new Set(folders)];
    out.push({
      id: r.id,
      folders: names,
      reason: names.length === 1 ? `You turned it off in ${names[0]}, a similar folder` : `You turned it off in ${names.length} similar folders: ${names.slice(0, 3).join(', ')}`,
    });
  }
  return out.sort((a, b) => b.folders.length - a.folders.length || a.id.localeCompare(b.id));
}
