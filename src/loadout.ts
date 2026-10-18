// Loadout 파일(.vscode/extension-loadout.json)과 VS Code 워크스페이스 저장소 키 사이의 순수 변환 로직.
// vscode 모듈에 의존하지 않으므로 node:test로 바로 검증한다.

/** VS Code가 워크스페이스 저장소(state.vscdb)에 확장 활성 상태를 기록하는 키. */
export const ENABLED_KEY = 'extensionsIdentifiers/enabled';
export const DISABLED_KEY = 'extensionsIdentifiers/disabled';

export type Override = 'on' | 'off';

/** 확장 ID(소문자) → 이 워크스페이스에서 강제할 상태. 목록에 없으면 전역 설정을 따른다. */
export type Overrides = Map<string, Override>;

/** state.vscdb에 저장되는 확장 식별자 형태. */
export interface StoredIdentifier {
  id: string;
  uuid?: string;
}

export interface ParseResult {
  overrides: Overrides;
  errors: string[];
}

export const normalizeId = (id: string): string => id.trim().toLowerCase();

const isExtensionId = (id: string): boolean => /^[^.\s]+\.[^\s]+$/.test(id);

export function parseLoadout(text: string): ParseResult {
  const overrides: Overrides = new Map();
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { overrides, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { overrides, errors: ['The loadout file must be a JSON object with "enable" and "disable" lists.'] };
  }
  const read = (field: 'enable' | 'disable', value: Override) => {
    const list = (data as Record<string, unknown>)[field];
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      errors.push(`"${field}" must be a list of extension IDs.`);
      return;
    }
    for (const raw of list) {
      if (typeof raw !== 'string' || !isExtensionId(raw.trim())) {
        errors.push(`"${field}" has an entry that is not an extension ID: ${JSON.stringify(raw)}`);
        continue;
      }
      const id = normalizeId(raw);
      const prev = overrides.get(id);
      if (prev && prev !== value) errors.push(`${id} is listed in both "enable" and "disable".`);
      overrides.set(id, value);
    }
  };
  read('enable', 'on');
  read('disable', 'off');
  return { overrides, errors };
}

export function serializeLoadout(overrides: Overrides): string {
  const pick = (value: Override) => [...overrides].filter(([, v]) => v === value).map(([id]) => id).sort();
  return JSON.stringify({ enable: pick('on'), disable: pick('off') }, null, 2) + '\n';
}

/** state.vscdb의 키 값(JSON 문자열)을 식별자 목록으로 읽는다. 형식이 깨졌으면 빈 목록. */
export function parseStoredIdentifiers(value: string | undefined): StoredIdentifier[] {
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
 * "이 워크스페이스에서 켤 확장" 선택 결과를 Overrides로 바꾼다.
 * 전역 설정과 같은 선택은 덮어쓰지 않고 전역을 따르게 둔다.
 */
export function overridesFromSelection(
  candidates: { id: string; globallyEnabled: boolean }[],
  selected: Set<string>,
  previous: Overrides,
): Overrides {
  const next: Overrides = new Map(previous);
  for (const c of candidates) {
    const id = normalizeId(c.id);
    const wantOn = selected.has(id);
    if (wantOn === c.globallyEnabled) next.delete(id);
    else next.set(id, wantOn ? 'on' : 'off');
  }
  return next;
}
