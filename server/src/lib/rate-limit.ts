import { getDb, nowIso, type Db } from '../db/index.ts';
import { config } from '../config.ts';

export interface RateLimitRule {
  /** Max attempts allowed inside the window. */
  max: number;
  windowMs: number;
}

/**
 * Records an attempt and reports whether the caller is over its limit.
 * Backed by SQLite rather than memory so limits survive a restart — a restart
 * loop would otherwise reset an attacker's budget.
 */
export function hitLimit(key: string, rule: RateLimitRule, db: Db = getDb()): { limited: boolean; retryAfterSec: number } {
  const cutoff = new Date(Date.now() - rule.windowMs).toISOString();

  db.prepare('DELETE FROM auth_attempts WHERE created_at < ?').run(cutoff);
  db.prepare('INSERT INTO auth_attempts (key, created_at) VALUES (?, ?)').run(key, nowIso());

  const row = db
    .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM auth_attempts WHERE key = ? AND created_at >= ?')
    .get(key, cutoff) as { n: number; oldest: string | null };

  if (row.n <= rule.max) return { limited: false, retryAfterSec: 0 };

  const oldestMs = row.oldest ? new Date(row.oldest).getTime() : Date.now();
  const retryAfterSec = Math.max(1, Math.ceil((oldestMs + rule.windowMs - Date.now()) / 1000));
  return { limited: true, retryAfterSec };
}

/** Clears the counter for a key — called after a successful login. */
export function clearLimit(key: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM auth_attempts WHERE key = ?').run(key);
}

export const LOGIN_RULE: RateLimitRule = {
  max: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
};
export const SIGNUP_RULE: RateLimitRule = {
  max: config.signupMaxAttempts,
  windowMs: config.signupWindowMs,
};
