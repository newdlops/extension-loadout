// 확장 사이의 관계: extensionDependencies(이게 없으면 동작하지 않음)와 extensionPack(묶음).
// - 어떤 확장을 끄면, 그 확장이 필요한 확장들도 VS Code에서 동작하지 못한다 → 함께 끌지 묻는다.
// - 어떤 확장을 켜면, 그 확장이 필요한 확장도 켜져 있어야 한다 → 함께 켠다.
// - 확장 팩을 끄거나 켜면 팩에 든 확장도 같이 다룰지 묻거나 함께 켠다.

export interface DepRow {
  id: string;
  desiredOn: boolean;
  dependencies: string[];
  packMembers: string[];
}

/** ids를 끄면 동작하지 못하게 되는(직접·간접으로 의존하는) 켜진 확장. ids 자신은 빼고. */
export function dependentsOf(rows: DepRow[], ids: Iterable<string>): string[] {
  const off = new Set(ids);
  const out: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (!r.desiredOn || off.has(r.id)) continue;
      if (r.dependencies.some((d) => off.has(d))) {
        off.add(r.id);
        out.push(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** ids를 켜려면 함께 켜야 하는(직접·간접 의존) 확장 중 지금 꺼진 것. 설치되지 않은 것은 뺀다. */
export function missingDependencies(rows: DepRow[], ids: Iterable<string>): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set(ids);
  const stack = [...seen];
  const out: string[] = [];
  while (stack.length) {
    const r = byId.get(stack.pop()!);
    for (const d of r?.dependencies ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const dep = byId.get(d);
      if (!dep) continue;
      if (!dep.desiredOn) out.push(d);
      stack.push(d);
    }
  }
  return out;
}

/** 팩 ids에 든 확장 중 desiredOn이 want와 다른 것(설치된 것만). */
export function packMembers(rows: DepRow[], ids: Iterable<string>, want: boolean): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const id of ids) {
    for (const m of byId.get(id)?.packMembers ?? []) {
      const member = byId.get(m);
      if (member && member.desiredOn !== want) out.add(m);
    }
  }
  for (const id of ids) out.delete(id);
  return [...out];
}

/** 이 확장을 담고 있는 팩들. */
export function packsContaining(rows: DepRow[], id: string): string[] {
  return rows.filter((r) => r.packMembers.includes(id)).map((r) => r.id);
}
