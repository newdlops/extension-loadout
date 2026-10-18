// "이 폴더에서는 확실히 필요 없는 확장" 추천.
// 확실한 경우만 고른다: 특정 언어 파일이나 특정 파일이 있을 때만 켜지는 확장인데, 그런 파일이 폴더에 하나도 없을 때.
// 판단할 근거가 부족하면(항상 켜짐, 범용 형식 대상, 확인할 수 없는 활성화 조건, 다른 확장이 의존) 추천하지 않는다.
// vscode 모듈에 의존하지 않고, 파일 존재 확인은 호출하는 쪽이 넘겨준다.
import type { Activation, LanguageDef } from './catalog';

/** 거의 모든 저장소에 있는 범용 형식. 이런 언어를 대상으로 하는 확장은 필요 여부를 단정하지 않는다. */
export const GENERIC_LANGUAGES = new Set([
  'json', 'jsonc', 'json5', 'jsonl', 'markdown', 'plaintext', 'yaml', 'ignore', 'log', 'properties', 'ini',
  'xml', 'toml', 'dotenv', 'shellscript', 'csv', 'tsv', 'git-commit', 'git-rebase', 'diff', 'editorconfig',
  'code-text-binary', 'search-result',
]);

/**
 * 레포 내용으로 확인할 수 있거나, 사용자가 직접 불러야 일어나는 활성화 이벤트.
 * 이 밖의 이벤트(onUri, onFileSystem, onNotebook, onCustomEditor, onTaskType 등)가 있으면 판단을 보류한다.
 */
const CHECKABLE_EVENT = /^(onLanguage|workspaceContains|onCommand|onView|onWalkthrough|onDebug\w*)(:|$)/;

/** 의존성·서드파티 폴더. 여기 있는 파일은 "이 레포의 코드"로 치지 않는다. */
export const VENDORED_DIRS = '{**/node_modules/**,**/bower_components/**,**/.git/**,**/.venv/**,**/venv/**,**/.tox/**,**/__pycache__/**,**/.mypy_cache/**,**/.pytest_cache/**,**/site-packages/**}';

export interface SuggestInput {
  id: string;
  displayName: string;
  activation: Activation;
  dependsOn: string[];
  /** 지금 이 폴더에서 켜져 있어야 하는 상태인지. 이미 꺼진 것은 추천할 필요가 없다. */
  desiredOn: boolean;
  locked: boolean;
}

export interface Check {
  /** 사람이 읽는 이름. 예: "rust files (*.rs)" */
  what: string;
  /** 워크스페이스 기준 glob들. 하나라도 일치하는 파일이 있으면 필요하다고 본다. */
  globs: string[];
}

export interface Candidate {
  id: string;
  checks: Check[];
}

export interface Suggestion {
  id: string;
  reason: string;
}

/** 언어 ID → 그 언어 파일을 찾는 glob 목록. 기본 내장 언어와 설치된 확장의 언어 정의를 합쳐 만든다. */
export function languageGlobs(defs: LanguageDef[]): Map<string, { globs: string[]; sample: string[] }> {
  const out = new Map<string, { globs: string[]; sample: string[] }>();
  for (const d of defs) {
    const entry = out.get(d.id) ?? { globs: [], sample: [] };
    for (const ext of d.extensions) {
      if (!ext.startsWith('.')) continue;
      entry.globs.push(`**/*${ext}`);
      entry.sample.push(`*${ext}`);
    }
    for (const name of d.filenames) {
      entry.globs.push(`**/${name}`);
      entry.sample.push(name);
    }
    for (const p of d.filenamePatterns) entry.globs.push(p.startsWith('**/') ? p : `**/${p}`);
    out.set(d.id, entry);
  }
  for (const v of out.values()) {
    v.globs = [...new Set(v.globs)];
    v.sample = [...new Set(v.sample)];
  }
  return out;
}

/** 추천 후보와, 각 후보가 "필요 없다"고 판단하려면 모두 비어 있어야 하는 파일 조건을 고른다. */
export function planSuggestions(rows: SuggestInput[], langs: Map<string, { globs: string[]; sample: string[] }>): Candidate[] {
  // 켜져 있는 다른 확장이 의존하는 확장은 끄면 그 확장도 망가지므로 제외한다.
  const neededByOthers = new Set(rows.filter((r) => r.desiredOn).flatMap((r) => r.dependsOn));
  const out: Candidate[] = [];
  for (const r of rows) {
    const a = r.activation;
    if (r.locked || !r.desiredOn || a.kind !== 'triggered' || neededByOthers.has(r.id)) continue;
    if (!a.languages.length && !a.globs.length) continue;
    if (a.events.some((e) => !CHECKABLE_EVENT.test(e))) continue;
    if (a.languages.some((l) => GENERIC_LANGUAGES.has(l))) continue;
    const checks: Check[] = [];
    let unknownLanguage = false;
    for (const l of a.languages) {
      const def = langs.get(l);
      if (!def || !def.globs.length) {
        unknownLanguage = true;
        break;
      }
      const sample = def.sample.slice(0, 3).join(', ');
      checks.push({ what: sample ? `${l} files (${sample})` : `${l} files`, globs: def.globs });
    }
    if (unknownLanguage) continue;
    for (const g of a.globs) checks.push({ what: g.replace(/^\*\*\//, ''), globs: [g] });
    out.push({ id: r.id, checks });
  }
  return out;
}

/** 중괄호가 없는 glob은 {a,b,c} 하나로 묶어 검색 횟수를 줄인다. 중괄호를 겹쳐 쓸 수는 없으므로 나머지는 따로 둔다. */
export function combineGlobs(globs: string[]): string[] {
  const simple = globs.filter((g) => !/[{}]/.test(g));
  const complex = globs.filter((g) => /[{}]/.test(g));
  return [...(simple.length > 1 ? [`{${simple.join(',')}}`] : simple), ...complex];
}

/** 확장 하나에 대한 "필요 없음" 사유. 같은 패턴은 합치고 3개까지만 적는다. */
export function reasonFor(checks: Check[]): string {
  const names = [...new Set(checks.map((k) => k.what.replace(/^(\*\*\/|\*\/)+/, '')))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
  return `No ${shown} in this folder`;
}

/** 모든 조건이 비어 있는 후보만 추천한다. 같은 glob은 한 번만 확인한다. */
export async function evaluateSuggestions(candidates: Candidate[], exists: (glob: string) => Promise<boolean>): Promise<Suggestion[]> {
  const memo = new Map<string, Promise<boolean>>();
  const check = (glob: string) => {
    let p = memo.get(glob);
    if (!p) memo.set(glob, (p = exists(glob)));
    return p;
  };
  const results = await Promise.all(
    candidates.map(async (c) => {
      const found = await Promise.all(c.checks.flatMap((k) => k.globs.map(check)));
      return found.some(Boolean) ? undefined : { id: c.id, reason: reasonFor(c.checks) };
    }),
  );
  return results.filter((s): s is Suggestion => !!s);
}

/** VS Code glob(**, *, ?, {a,b}, [..])을 정규식으로. 대소문자는 무시한다(놓치는 쪽보다 찾는 쪽이 안전하다). */
export function globToRegExp(glob: string): RegExp {
  let i = 0;
  const parse = (inBrace: boolean): string => {
    let out = '';
    while (i < glob.length) {
      const c = glob[i];
      if (inBrace && (c === ',' || c === '}')) return out;
      if (c === '*' && glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else if (c === '*') {
        i++;
        out += '[^/]*';
      } else if (c === '?') {
        i++;
        out += '[^/]';
      } else if (c === '{') {
        i++;
        const alts: string[] = [];
        for (;;) {
          alts.push(parse(true));
          if (glob[i] === ',') i++;
          else break;
        }
        i++; // '}'
        out += `(?:${alts.join('|')})`;
      } else if (c === '[') {
        const end = glob.indexOf(']', i + 1);
        if (end < 0) {
          out += '\\[';
          i++;
        } else {
          out += glob.slice(i, end + 1);
          i = end + 1;
        }
      } else {
        out += c.replace(/[.+^$()|\\]/g, '\\$&');
        i++;
      }
    }
    return out;
  };
  return new RegExp(`^${parse(false)}$`, 'i');
}

/**
 * 워크스페이스 파일 목록(상대 경로)으로 glob 존재를 판단한다. 목록이 잘렸으면(truncated) 목록에서 못 찾은 glob만
 * fallback으로 다시 확인한다. 이렇게 하면 큰 저장소에서도 검색은 대개 한 번으로 끝난다.
 */
export function fileListMatcher(
  files: string[],
  truncated: boolean,
  fallback: (glob: string) => Promise<boolean>,
): (glob: string) => Promise<boolean> {
  return async (glob) => {
    const re = globToRegExp(glob);
    if (files.some((f) => re.test(f))) return true;
    return truncated ? fallback(glob) : false;
  };
}
