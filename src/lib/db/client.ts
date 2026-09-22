/**
 * Database client — wraps Node's built-in synchronous SQLite (node:sqlite).
 *
 * The rest of the application never touches SQL directly; it goes through
 * the repository modules, which take a `Db` handle. Unit tests inject an
 * in-memory handle, the app injects the shared file-backed handle.
 *
 * Adapter contract for a future PostgreSQL implementation: every repository
 * function takes `db` as its first argument; only these modules and
 * schema.ts know which engine is underneath.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export type Db = DatabaseSync;

export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      SCHEMA_VERSION,
    );
  }
}

/** Transaction helper — rolls back on any thrown error. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

let singleton: Db | null = null;

export function dbPath(): string {
  return resolve(process.env.DATABASE_PATH ?? './data/terminal.sqlite');
}

/** Shared application handle. Lazily created and migrated on first use. */
export function getDb(): Db {
  if (singleton) return singleton;
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  singleton = db;
  return db;
}

/** Fresh in-memory database for tests. */
export function createTestDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Test hook — swap/reset the singleton (used by integration tests). */
export function _setSingletonForTests(db: Db | null): void {
  singleton = db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
