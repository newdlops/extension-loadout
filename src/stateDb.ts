// VS Code의 state.vscdb(SQLite, ItemTable(key, value)) 접근.
// VS Code가 열어 둔 상태에서는 읽기만 한다. 쓰기는 VS Code가 완전히 종료된 뒤 restartHelper가 한다.
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// node:sqlite는 Node 22.13+(VS Code 1.101+)에만 있다. 맨 위에서 import하면 오래된 VS Code에서
// 확장이 아무 안내 없이 활성화에 실패하므로 쓰는 시점에 불러온다.
export function sqliteAvailable(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function openDb(dbPath: string, readOnly: boolean): DatabaseSyncType {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly });
}

/** VS Code가 저장소에 쓰는 중이면 SQLITE_BUSY가 난다. 시작 직후에 흔하므로 잠시 기다린다. */
const BUSY_TIMEOUT_MS = 3000;

export function readItems(dbPath: string, keys: string[]): Record<string, string | undefined> {
  const db = openDb(dbPath, true);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
  const db = openDb(dbPath, false);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
