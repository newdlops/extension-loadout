// Loadout 파일과 VS Code 워크스페이스 저장소 키 사이의 순수 로직. vscode 모듈에 의존하지 않는다.
//
// 파일 형식(JSONC):
//   {
//     "enable":  ["vscjava.vscode-gradle"],
//     "disable": ["ms-toolsai.*", "!ms-toolsai.jupyter", "rust-lang.rust-analyzer"],
//     "notes":   { "ms-toolsai.*": "no notebooks in this repo" }
//   }
// - 항목은 확장 ID, 와일드카드 패턴(* ?), 또는 앞에 !를 붙인 제외 항목이다.
// - 같은 목록의 패턴 일치에서 ! 항목이 가리키는 확장을 뺀다(gitignore와 같은 방식).
// - 정확한 ID가 패턴보다 우선한다. 두 목록의 패턴이 같은 확장을 가리키면 오류로 알리고 적용하지 않는다.
// - 파일을 고칠 때는 바뀐 목록만 다시 쓰므로 사용자가 적은 패턴·메모·다른 키·주석은 그대로 남는다.
import { ParseError, applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';

/** VS Code가 워크스페이스 저장소(state.vscdb)에 확장 활성 상태를 기록하는 키. */
export const ENABLED_KEY = 'extensionsIdentifiers/enabled';
export const DISABLED_KEY = 'extensionsIdentifiers/disabled';

export type Override = 'on' | 'off';

/** 확장 ID(소문자) → 이 워크스페이스에서 강제할 상태. 목록에 없으면 전역 설정을 따른다. */
export type Overrides = Map<string, Override>;

/** 한 파일 안에서의 판정. clear는 "! 항목으로 이 아래 단계(패턴·다른 폴더 파일)의 설정을 지움". */
export type LayerValue = Override | 'clear';

/** state.vscdb에 저장되는 확장 식별자 형태. */
export interface StoredIdentifier {
  id: string;
  uuid?: string;
}

export interface LoadoutRules {
  enable: string[];
  disable: string[];
  notes: Record<string, string>;
}

export const emptyRules = (): LoadoutRules => ({ enable: [], disable: [], notes: {} });

export const normalizeId = (id: string): string => id.trim().toLowerCase();

export const isPattern = (entry: string): boolean => /[*?]/.test(entry);

const ENTRY = /^!?(?:[^.\s!]+\.[^\s!]+|[^\s!]*[*?][^\s!]*)$/;

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

export const DEFAULT_TEXT = '{\n  "enable": [],\n  "disable": []\n}\n';

// ---------------------------------------------------------------------------------------------
// 읽기

export function parseLoadoutRules(text: string): { rules: LoadoutRules; errors: string[] } {
  const rules = emptyRules();
  const errors: string[] = [];
  const parseErrors: ParseError[] = [];
  const data = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
  if (parseErrors.length) {
    const e = parseErrors[0];
    return { rules, errors: [`Not valid JSON: ${printParseErrorCode(e.error)} at offset ${e.offset}`] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { rules, errors: ['The loadout file must be a JSON object with "enable" and "disable" lists.'] };
  }
  const obj = data as Record<string, unknown>;
  for (const field of ['enable', 'disable'] as const) {
    const list = obj[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`"${field}" must be a list of extension IDs or patterns.`);
      continue;
    }
    const seen = new Set<string>();
    for (const raw of list) {
      const entry = typeof raw === 'string' ? normalizeId(raw) : '';
      if (!entry || !ENTRY.test(entry)) {
        errors.push(`"${field}" has an entry that is not an extension ID or pattern: ${JSON.stringify(raw)}`);
        continue;
      }
      if (seen.has(entry)) continue;
      seen.add(entry);
      rules[field].push(entry);
    }
  }
  if (obj.notes !== undefined) {
    if (!obj.notes || typeof obj.notes !== 'object' || Array.isArray(obj.notes)) errors.push('"notes" must be an object of { "id or pattern": "note" }.');
    else for (const [k, v] of Object.entries(obj.notes as Record<string, unknown>)) if (typeof v === 'string') rules.notes[normalizeId(k)] = v;
  }
  const exactOn = new Set(rules.enable.filter((e) => !e.startsWith('!') && !isPattern(e)));
  for (const e of rules.disable) if (exactOn.has(e)) errors.push(`${e} is listed in both "enable" and "disable".`);
  return { rules, errors };
}

const patternRegex = new Map<string, RegExp>();
export function matchesEntry(entry: string, id: string): boolean {
  if (!isPattern(entry)) return entry === id;
  let re = patternRegex.get(entry);
  if (!re) {
    re = new RegExp(`^${entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    patternRegex.set(entry, re);
  }
  return re.test(id);
}

interface ListMatch {
  exact: boolean;
  /** ! 항목에 걸리지 않은 패턴이 이 ID를 가리키는가. */
  pattern?: string;
  negated: boolean;
}

function matchList(list: string[], id: string): ListMatch {
  let exact = false;
  let pattern: string | undefined;
  let negated = false;
  for (const e of list) {
    if (e.startsWith('!')) {
      if (matchesEntry(e.slice(1), id)) negated = true;
    } else if (!isPattern(e)) {
      if (e === id) exact = true;
    } else if (!pattern && matchesEntry(e, id)) {
      pattern = e;
    }
  }
  return { exact, pattern: negated ? undefined : pattern, negated };
}

/**
 * 한 파일의 규칙을 확장별 판정으로 바꾼다. 패턴은 knownIds(설치된 확장)에만 적용한다.
 * 정확한 ID는 설치되어 있지 않아도 판정에 넣는다(목록에서 "설치되지 않음"으로 보여주기 위해).
 */
export function resolveRules(rules: LoadoutRules, knownIds: Iterable<string>): { values: Map<string, LayerValue>; errors: string[]; via: Map<string, string> } {
  const values = new Map<string, LayerValue>();
  const via = new Map<string, string>();
  const errors: string[] = [];
  const ids = new Set<string>([...knownIds].map(normalizeId));
  for (const e of [...rules.enable, ...rules.disable]) {
    const bare = e.startsWith('!') ? e.slice(1) : e;
    if (!isPattern(bare)) ids.add(bare);
  }
  for (const id of ids) {
    const en = matchList(rules.enable, id);
    const dis = matchList(rules.disable, id);
    if (en.exact && dis.exact) continue; // parseLoadoutRules가 이미 오류로 알렸다.
    if (en.exact) {
      values.set(id, 'on');
      via.set(id, id);
    } else if (dis.exact) {
      values.set(id, 'off');
      via.set(id, id);
    } else if (en.pattern && dis.pattern) {
      errors.push(`${id} matches both "${en.pattern}" (enable) and "${dis.pattern}" (disable); list it explicitly.`);
    } else if (en.pattern) {
      values.set(id, 'on');
      via.set(id, en.pattern);
    } else if (dis.pattern) {
      values.set(id, 'off');
      via.set(id, dis.pattern);
    } else if (en.negated || dis.negated) {
      values.set(id, 'clear');
    }
  }
  return { values, errors, via };
}

/**
 * 여러 파일의 판정을 합친다. inputs(멀티 루트의 각 폴더 파일)는 같은 순위이고 서로 다르면 켜는 쪽을 따른다.
 * editable(이 창에서 고치는 파일)이 가장 우선한다.
 */
export function mergeLayers(
  inputs: { name: string; values: Map<string, LayerValue> }[],
  editable: Map<string, LayerValue> | undefined,
): { overrides: Overrides; conflicts: string[]; inherited: Map<string, { value: Override; from: string[] }> } {
  const inherited = new Map<string, { value: Override; from: string[] }>();
  const conflicts: string[] = [];
  const seenOff = new Map<string, string[]>();
  for (const { name, values } of inputs) {
    for (const [id, v] of values) {
      if (v === 'clear') continue;
      if (v === 'off') seenOff.set(id, [...(seenOff.get(id) ?? []), name]);
      const prev = inherited.get(id);
      if (!prev) inherited.set(id, { value: v, from: [name] });
      else if (prev.value === v) prev.from.push(name);
      else if (v === 'on') inherited.set(id, { value: 'on', from: [name] });
    }
  }
  for (const [id, off] of seenOff) {
    const final = inherited.get(id);
    if (final?.value === 'on') conflicts.push(`${id} is turned on in ${final.from.join(', ')} but off in ${off.join(', ')}; keeping it on.`);
  }
  const overrides: Overrides = new Map([...inherited].map(([id, x]) => [id, x.value]));
  for (const [id, v] of editable ?? []) {
    if (v === 'clear') overrides.delete(id);
    else overrides.set(id, v);
  }
  return { overrides, conflicts, inherited };
}

// ---------------------------------------------------------------------------------------------
// 고치기

export interface LoadoutChange {
  id: string;
  /** undefined는 "전역 설정을 따름". */
  value: Override | undefined;
}

/**
 * loadout 파일 텍스트에 변경을 적용한다. 바뀐 목록만 다시 쓰고 나머지 내용은 보존한다.
 * inherited: 다른 폴더 파일에서 물려받은 설정(멀티 루트). 전역 따름으로 바꾸려면 ! 항목으로 지워야 한다.
 */
export function editLoadoutText(text: string | undefined, changes: LoadoutChange[], inherited: ReadonlyMap<string, Override> = new Map()): string {
  let source = text && text.trim() ? text : DEFAULT_TEXT;
  const { rules, errors } = parseLoadoutRules(source);
  if (errors.some((e) => e.startsWith('Not valid JSON') || e.includes('must be'))) throw new Error(`Fix the loadout file first: ${errors[0]}`);
  const lists = { enable: [...rules.enable], disable: [...rules.disable] };
  for (const { id: rawId, value } of changes) {
    const id = normalizeId(rawId);
    for (const key of ['enable', 'disable'] as const) lists[key] = lists[key].filter((e) => e !== id && e !== `!${id}`);
    const en = matchList(lists.enable, id).pattern;
    const dis = matchList(lists.disable, id).pattern;
    if (value === 'on') {
      if (!(en && !dis)) lists.enable.push(id);
    } else if (value === 'off') {
      if (!(dis && !en)) lists.disable.push(id);
    } else {
      if (en) lists.enable.push(`!${id}`);
      if (dis) lists.disable.push(`!${id}`);
      const from = inherited.get(id);
      if (!en && !dis && from) lists[from === 'on' ? 'enable' : 'disable'].push(`!${id}`);
    }
  }
  for (const key of ['enable', 'disable'] as const) {
    if (lists[key].join('\n') === rules[key].join('\n')) continue;
    source = applyEdits(source, modify(source, [key], lists[key], FORMAT));
  }
  return source.endsWith('\n') ? source : `${source}\n`;
}

/** 프리셋처럼 규칙 전체를 새로 쓸 때. */
export function serializeRules(rules: LoadoutRules): string {
  const out: Record<string, unknown> = { enable: rules.enable, disable: rules.disable };
  if (Object.keys(rules.notes).length) out.notes = rules.notes;
  return JSON.stringify(out, null, 2) + '\n';
}

/** 이 ID에 해당하는 메모(정확한 ID 우선, 그다음 패턴). */
export function noteFor(notes: Record<string, string>, id: string): string | undefined {
  if (notes[id]) return notes[id];
  for (const [k, v] of Object.entries(notes)) if (isPattern(k) && matchesEntry(k, id)) return v;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// VS Code 저장소 키

/** state.vscdb의 키 값(JSON 문자열)을 식별자 목록으로 읽는다. 형식이 깨졌으면 빈 목록. */
export function parseStoredIdentifiers(value: string | undefined | null): StoredIdentifier[] {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list)
      ? list.filter((e): e is StoredIdentifier => !!e && typeof e === 'object' && typeof e.id === 'string')
      : [];
  } catch {
    return [];
  }
}

/** 워크스페이스 저장소에 이미 기록된 상태를 Overrides로 되돌린다(loadout 파일이 없을 때 시작점). */
export function overridesFromStored(enabled: StoredIdentifier[], disabled: StoredIdentifier[]): Overrides {
  const overrides: Overrides = new Map();
  for (const e of enabled) overrides.set(normalizeId(e.id), 'on');
  for (const e of disabled) overrides.set(normalizeId(e.id), 'off');
  return overrides;
}

/** Overrides를 워크스페이스 저장소 키 값으로 바꾼다. 빈 목록은 키 삭제(null)로 표현한다. */
export function storedValuesFor(
  overrides: Overrides,
  uuidOf: (id: string) => string | undefined,
): Record<typeof ENABLED_KEY | typeof DISABLED_KEY, string | null> {
  const list = (value: Override): StoredIdentifier[] =>
    [...overrides]
      .filter(([, v]) => v === value)
      .map(([id]) => id)
      .sort()
      .map((id) => {
        const uuid = uuidOf(id);
        return uuid ? { id, uuid } : { id };
      });
  const encode = (l: StoredIdentifier[]) => (l.length ? JSON.stringify(l) : null);
  return { [ENABLED_KEY]: encode(list('on')), [DISABLED_KEY]: encode(list('off')) };
}

/** 워크스페이스 저장소가 loadout과 다르면 true. 순서와 대소문자, uuid 유무는 비교하지 않는다. */
export function isPending(overrides: Overrides, enabled: StoredIdentifier[], disabled: StoredIdentifier[]): boolean {
  const stored = overridesFromStored(enabled, disabled);
  if (stored.size !== overrides.size) return true;
  for (const [id, v] of overrides) if (stored.get(id) !== v) return true;
  return false;
}

/** 이 워크스페이스에서 확장이 켜져 있어야 하는지. */
export function desiredOn(id: string, overrides: Overrides, globallyEnabled: boolean): boolean {
  const o = overrides.get(normalizeId(id));
  return o ? o === 'on' : globallyEnabled;
}

/**
 * "이 워크스페이스에서 켤 확장" 선택 결과를 변경 목록으로 바꾼다.
 * 전역 설정과 같은 선택은 덮어쓰지 않고 전역을 따르게 둔다.
 */
export function changesFromSelection(
  candidates: { id: string; globallyEnabled: boolean }[],
  selected: Set<string>,
  current: Overrides,
): LoadoutChange[] {
  const changes: LoadoutChange[] = [];
  for (const c of candidates) {
    const id = normalizeId(c.id);
    const wantOn = selected.has(id);
    const next: Override | undefined = wantOn === c.globallyEnabled ? undefined : wantOn ? 'on' : 'off';
    if (current.get(id) !== next) changes.push({ id, value: next });
  }
  return changes;
}

/** 원하는 Overrides가 되도록 하는 변경 목록(프리셋 적용 등). */
export function changesBetween(current: Overrides, next: Overrides): LoadoutChange[] {
  const changes: LoadoutChange[] = [];
  for (const id of new Set([...current.keys(), ...next.keys()])) {
    if (current.get(id) !== next.get(id)) changes.push({ id, value: next.get(id) });
  }
  return changes;
}

export const hasPatterns = (rules: LoadoutRules): boolean => [...rules.enable, ...rules.disable].some((e) => isPattern(e.replace(/^!/, '')));
