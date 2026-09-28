import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
// 通过 require 加载内置实验模块，避免打包器把 node: 前缀解析成裸模块名
const { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSyncCtor(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    revision_no INTEGER NOT NULL,
    active INTEGER NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    before_summary TEXT NOT NULL,
    after_summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (case_id, before_hash, after_hash)
  );

  CREATE TABLE IF NOT EXISTS diffs (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    diff_key TEXT NOT NULL,
    category TEXT NOT NULL,
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    impact TEXT NOT NULL,
    UNIQUE (revision_id, diff_key)
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    diff_id TEXT NOT NULL REFERENCES diffs(id),
    base_version INTEGER NOT NULL,
    state TEXT NOT NULL,
    actor TEXT NOT NULL,
    rationale TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT NOT NULL,
    before_summary TEXT NOT NULL,
    after_summary TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    event_no INTEGER NOT NULL,
    kind TEXT NOT NULL,
    revision_id TEXT,
    diff_id TEXT,
    from_revision_id TEXT,
    state TEXT,
    actor TEXT,
    rationale TEXT,
    expires_at TEXT,
    before_summary TEXT,
    after_summary TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (case_id, event_no)
  );
  `);
}
