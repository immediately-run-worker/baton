// store.ts — `node:sqlite` as the core's Store (BATON_SPEC §3a R-BTN-55): synchronous like the
// Durable Object's SQLite, so no logic changes. Transactions nest as savepoints, as
// `transactionSync` does; rows come back as plain objects and blobs as ArrayBuffers, as the
// object returns them.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Cursor, Row, SqlValue, Store } from '../core/ports';

function cursor<T>(rows: T[]): Cursor<T> {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
  };
}

const toSqlite = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
const fromSqlite = (v: unknown): SqlValue => (v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : (v as SqlValue));

export function sqliteStore(db: DatabaseSync): Store {
  const statements = new Map<string, StatementSync>();
  let depth = 0;
  return {
    exec<T = Row>(query: string, ...params: unknown[]): Cursor<T> {
      let stmt = statements.get(query);
      if (!stmt) {
        stmt = db.prepare(query);
        statements.set(query, stmt);
      }
      const rows = stmt.all(...(params.map(toSqlite) as never[])).map((r) => {
        const out: Row = {};
        for (const [k, v] of Object.entries(r)) out[k] = fromSqlite(v);
        return out as T;
      });
      return cursor(rows);
    },
    script(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      const name = `baton_tx_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/** A database at `path` (`:memory:` for a throwaway one), foreign keys enforced as on Cloudflare. */
export function openStore(path: string): { db: DatabaseSync; store: Store } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return { db, store: sqliteStore(db) };
}
