// 적용 계획: "VS Code가 끝난 뒤 이 저장소(state.vscdb)에 이 키들을 쓴다".
// 바로 재시작할 때는 계획을 도우미에 직접 넘기고, "종료할 때 적용"은 계획 폴더에 파일로 남긴다.
// 계획 파일은 저장소마다 하나라서 같은 저장소에 대한 나중 요청이 앞의 것을 덮어쓴다.
// 각 계획은 JSON(Node 도우미용)과 SQL(sh + sqlite3 도우미용) 두 형식으로 함께 쓴다.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PlanTarget {
  dbPath: string;
  /** 키 → 값. null이면 키를 지운다. */
  items: Record<string, string | null>;
  /** 화면·로그용 이름(폴더 이름 등). */
  label?: string;
}

export const planBaseName = (dbPath: string): string => crypto.createHash('sha1').update(path.resolve(dbPath)).digest('hex').slice(0, 16);

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** sqlite3 CLI로 실행할 SQL. 첫 줄의 "-- db:" 주석에서 sh 도우미가 대상 저장소 경로를 읽는다. */
export function sqlForTarget(t: PlanTarget): string {
  const lines = [`-- db: ${t.dbPath}`, 'PRAGMA busy_timeout = 5000;', 'BEGIN IMMEDIATE;'];
  for (const [key, value] of Object.entries(t.items)) {
    lines.push(
      value === null
        ? `DELETE FROM ItemTable WHERE key = ${sqlString(key)};`
        : `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlString(key)}, ${sqlString(value)});`,
    );
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

export function writePlanFiles(planDir: string, targets: PlanTarget[]): void {
  fs.mkdirSync(planDir, { recursive: true });
  for (const t of targets) {
    const base = path.join(planDir, planBaseName(t.dbPath));
    // 반쯤 쓴 파일을 도우미가 읽지 않도록 임시 이름으로 쓴 뒤 바꾼다.
    fs.writeFileSync(`${base}.json.tmp`, JSON.stringify(t));
    fs.writeFileSync(`${base}.sql.tmp`, sqlForTarget(t));
    fs.renameSync(`${base}.json.tmp`, `${base}.json`);
    fs.renameSync(`${base}.sql.tmp`, `${base}.sql`);
  }
}

export function readPlanFiles(planDir: string): { file: string; target: PlanTarget }[] {
  let names: string[];
  try {
    names = fs.readdirSync(planDir);
  } catch {
    return [];
  }
  const out: { file: string; target: PlanTarget }[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      out.push({ file: path.join(planDir, n), target: JSON.parse(fs.readFileSync(path.join(planDir, n), 'utf8')) });
    } catch {
      // 깨진 파일은 무시한다.
    }
  }
  return out;
}

export function removePlanFiles(planDir: string, dbPaths?: string[]): void {
  const only = dbPaths && new Set(dbPaths.map(planBaseName));
  let names: string[];
  try {
    names = fs.readdirSync(planDir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^([0-9a-f]{16})\.(json|sql)$/.exec(n);
    if (m && (!only || only.has(m[1]))) fs.rmSync(path.join(planDir, n), { force: true });
  }
}

/**
 * 메인 프로세스가 끝나기를 기다렸다가 계획 폴더의 .sql을 적용하는 sh 스크립트. 기다리는 동안 드는 자원이 거의 없다.
 * 인자: $1=메인 pid, $2=계획 폴더, $3=로그 파일, $4=sqlite3 경로
 */
export const WAIT_AND_APPLY_SH = `
pid="$1"; dir="$2"; log="$3"; sqlite="$4"
echo $$ > "$dir/helper.pid"
# 0.5초 간격: Dock에서 바로 다시 열 때 새 VS Code가 저장소를 읽기 전에 쓰기 위해
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
for f in "$dir"/*.sql; do
  [ -f "$f" ] || continue
  db=$(sed -n '1s/^-- db: //p' "$f")
  if [ -f "$db" ] && "$sqlite" "$db" < "$f" > /dev/null 2>> "$log"; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S') applied on quit: $db" >> "$log"
    rm -f "$f" "\${f%.sql}.json"
  fi
done
rm -f "$dir/helper.pid"
`;
