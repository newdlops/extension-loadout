// recommend.ts의 판단을 VS Code 워크스페이스에 적용한다.
// 후보가 있을 때만, 후보 패턴에 맞는 파일을 한 번에 찾아(ripgrep) 메모리에서 대조하고, 결과가 잘렸으면 못 찾은 패턴만 따로 확인한다.
import * as vscode from 'vscode';
import { LanguageDef, languageDefsOf } from './catalog';
import { LoadoutSnapshot } from './model';
import { Suggestion, VENDORED_DIRS, combineGlobs, evaluateSuggestions, fileListMatcher, languageGlobs, planSuggestions } from './recommend';

const MAX_FILES = 5_000;

export async function computeSuggestions(snap: LoadoutSnapshot, log: vscode.LogOutputChannel): Promise<Suggestion[]> {
  const started = Date.now();
  // 언어 → 파일 패턴: 내장 확장과 설치된 확장(꺼진 것 포함)의 언어 정의를 모두 쓴다.
  const defs: LanguageDef[] = [];
  for (const e of vscode.extensions.all) defs.push(...languageDefsOf(e.packageJSON ?? {}));
  for (const r of snap.rows) defs.push(...r.languageDefs);
  // 이 폴더에서 직접 켠 확장은 사용자의 선택이므로 추천하지 않는다.
  const candidates = planSuggestions(
    snap.rows.filter((r) => r.override !== 'on'),
    languageGlobs(defs),
  );
  if (!candidates.length) return [];
  // 전체 파일 목록 대신 후보들의 패턴에 맞는 파일만 받는다. 후보는 대개 이 폴더에 없는 언어용이라 결과가 거의 없다.
  const globs = [...new Set(candidates.flatMap((c) => c.checks.flatMap((k) => k.globs)))];
  const files: string[] = [];
  let truncated = false;
  for (const query of combineGlobs(globs)) {
    const uris = await vscode.workspace.findFiles(query, VENDORED_DIRS, MAX_FILES);
    truncated ||= uris.length >= MAX_FILES;
    for (const u of uris) files.push(vscode.workspace.asRelativePath(u, false));
  }
  let fallbacks = 0;
  const exists = fileListMatcher(files, truncated, async (glob) => {
    fallbacks++;
    return (await vscode.workspace.findFiles(glob, VENDORED_DIRS, 1)).length > 0;
  });
  const list = await evaluateSuggestions(candidates, exists);
  log.info(
    `Suggestions: ${list.length} of ${candidates.length} candidates, ${files.length} matching files${truncated ? ' (truncated)' : ''}, ${fallbacks} extra searches, ${Date.now() - started} ms`,
  );
  return list;
}
