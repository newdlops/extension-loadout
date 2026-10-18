// VS Code의 state.vscdb(SQLite, ItemTable(key, value)) 접근.
// VS Code가 열어 둔 상태에서는 읽기만 한다. 쓰기는 VS Code가 완전히 종료된 뒤 restartHelper가 한다.
import { DatabaseSync } from 'node:sqlite';

export function readItems(dbPath: string, keys: string[]): Record<string, string | undefined> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const out: Record<string, string | undefined> = {};
    for (const key of keys) {
      const row = stmt.get(key) as { value?: unknown } | undefined;
      out[key] = row?.value == null ? undefined : String(row.value);
    }
    return out;
  } finally {
    db.close();
  }
}

/** 값이 null인 키는 삭제한다. 한 트랜잭션으로 처리한다. */
export function writeItems(dbPath: string, items: Record<string, string | null>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const put = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM ItemTable WHERE key = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(items)) {
        if (value === null) del.run(key);
        else put.run(key, value);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}
