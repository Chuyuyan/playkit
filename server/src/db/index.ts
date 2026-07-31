import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                 -- NULL for Google-only accounts
  google_sub    TEXT UNIQUE,          -- Google's stable user id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Refresh tokens are stored hashed, one row per issued token, so a stolen
-- database does not hand out usable sessions and we can revoke individually.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- One save blob per (user, game). Games decide their own save shape.
CREATE TABLE IF NOT EXISTS saves (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL,
  board      TEXT NOT NULL DEFAULT 'default',
  score      REAL NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_board ON scores(game_id, board, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id, game_id, board);

-- Password-reset tokens. Stored hashed and single-use, for the same reason as
-- refresh tokens: a leaked database must not hand anyone an account.
CREATE TABLE IF NOT EXISTS reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON reset_tokens(user_id);

-- Auth attempt log, used for rate limiting. Cheap to prune.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON auth_attempts(key, created_at);
`;

export type Db = DatabaseSync;

export function openDb(path: string = config.databasePath): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

let singleton: Db | null = null;

export function getDb(): Db {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function nowIso(): string {
  return new Date().toISOString();
}
