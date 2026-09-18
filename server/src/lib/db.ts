import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export type DB = Database.Database;

let instance: DB | null = null;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
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
