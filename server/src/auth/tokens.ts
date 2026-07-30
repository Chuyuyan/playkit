import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { getDb, nowIso, type Db } from '../db/index.ts';

const ISSUER = 'playkit';

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(config.accessTokenTtl)
    .sign(config.jwtSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: ISSUER });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Refresh tokens are opaque random strings. Only their SHA-256 is stored, so a
 * leaked database cannot be replayed as valid sessions.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueRefreshToken(userId: string, db: Db = getDb()): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, hashToken(token), expires.toISOString(), nowIso());
  return token;
}

export interface RefreshResult {
  userId: string;
  /** A brand-new refresh token; the old one is now revoked. */
  nextToken: string;
}

/**
 * Verifies a refresh token and rotates it. Rotation means a stolen token is
 * only useful until the legitimate client refreshes once.
 */
export function rotateRefreshToken(token: string, db: Db = getDb()): RefreshResult | null {
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;

  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { userId: row.user_id, nextToken: issueRefreshToken(row.user_id, db) };
}

export function revokeRefreshToken(token: string, db: Db = getDb()): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(nowIso(), hashToken(token));
}

/** Used on password change / "log out everywhere". */
export function revokeAllForUser(userId: string, db: Db = getDb()): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId);
}
