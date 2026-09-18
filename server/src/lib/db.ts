import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

/**
 * SQLite comes with Node itself, so the app has no native dependency to
 * compile and `npm install` needs no C++ toolchain on any platform.
 */
export type DB = DatabaseSync;

let instance: DB | null = null;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  // A quiz writes constantly — every buzz and every score. Write-ahead logging
  // keeps those writes from blocking the reads that build everyone's screen,
  // and leaves the file recoverable if the host restarts mid-question.
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

export function getDb(): DB {
  if (!instance) {
    instance = openDatabase(process.env.DATABASE_FILE ?? resolve(process.cwd(), 'data/quizbuzz.sqlite'));
  }
  return instance;
}

/** Test helper: swap in an in-memory database. */
export function setDb(db: DB): void {
  instance = db;
}

/** Runs `fn` in a transaction, rolling back if it throws. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
