import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { getDb, nowIso, type Db } from '../db/index.ts';
import { hashPassword } from './password.ts';
import { revokeAllForUser } from './tokens.ts';

/** Reset tokens are opaque randoms; only their SHA-256 is stored. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueResetToken(userId: string, db: Db = getDb()): string {
  // Any earlier token becomes useless the moment a new one is asked for, so a
  // forwarded old email can't be used after the fact.
  db.prepare('UPDATE reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(nowIso(), userId);

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.resetTokenTtlMinutes * 60_000);
  db.prepare(
    `INSERT INTO reset_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, hashToken(token), expires.toISOString(), nowIso());
  return token;
}

export interface ResetOutcome {
  ok: boolean;
  /** Present only on failure, safe to show the player. */
  message?: string;
}

/**
 * Consumes a reset token and sets the new password.
 *
 * Every session is revoked afterwards: if the reset was triggered because
 * someone else had access, leaving their existing logins alive would defeat
 * the point.
 */
export async function consumeResetToken(
  token: string,
  newPassword: string,
  db: Db = getDb(),
): Promise<ResetOutcome> {
  const row = db
    .prepare('SELECT id, user_id, expires_at, used_at FROM reset_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null }
    | undefined;

  if (!row || row.used_at) {
    return { ok: false, message: 'This reset link has already been used. Request a new one.' };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, message: 'This reset link has expired. Request a new one.' };
  }

  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(await hashPassword(newPassword), nowIso(), row.user_id);
  db.prepare('UPDATE reset_tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
  revokeAllForUser(row.user_id, db);

  return { ok: true };
}

/** Housekeeping: drop tokens that can no longer be used. */
export function pruneResetTokens(db: Db = getDb()): void {
  db.prepare('DELETE FROM reset_tokens WHERE expires_at < ? OR used_at IS NOT NULL')
    .run(new Date(Date.now() - 86_400_000).toISOString());
}
