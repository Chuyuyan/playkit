import { randomUUID } from 'node:crypto';
import { getDb, nowIso, type Db } from '../db/index.ts';
import { hashPassword, verifyPassword } from './password.ts';

export interface User {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  google_sub: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

export function toPublic(u: User): PublicUser {
  return { id: u.id, email: u.email, displayName: u.display_name };
}

const SELECT = 'SELECT id, email, display_name, password_hash, google_sub FROM users';

export function findByEmail(email: string, db: Db = getDb()): User | undefined {
  return db.prepare(`${SELECT} WHERE email_lower = ?`).get(email.trim().toLowerCase()) as
    | User
    | undefined;
}

export function findById(id: string, db: Db = getDb()): User | undefined {
  return db.prepare(`${SELECT} WHERE id = ?`).get(id) as User | undefined;
}

export function findByGoogleSub(sub: string, db: Db = getDb()): User | undefined {
  return db.prepare(`${SELECT} WHERE google_sub = ?`).get(sub) as User | undefined;
}

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function normalizeDisplayName(name: unknown, email: string): string {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 40);
  return email.split('@')[0].slice(0, 40);
}

export async function createUserWithPassword(
  email: string,
  password: string,
  displayName: unknown,
  db: Db = getDb(),
): Promise<User> {
  const id = randomUUID();
  const ts = nowIso();
  const trimmed = email.trim();
  db.prepare(
    `INSERT INTO users (id, email, email_lower, display_name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    trimmed,
    trimmed.toLowerCase(),
    normalizeDisplayName(displayName, trimmed),
    await hashPassword(password),
    ts,
    ts,
  );
  return findById(id, db)!;
}

export function createUserFromGoogle(
  args: { email: string; sub: string; name?: string },
  db: Db = getDb(),
): User {
  const id = randomUUID();
  const ts = nowIso();
  const trimmed = args.email.trim();
  db.prepare(
    `INSERT INTO users (id, email, email_lower, display_name, google_sub, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    trimmed,
    trimmed.toLowerCase(),
    normalizeDisplayName(args.name, trimmed),
    args.sub,
    ts,
    ts,
  );
  return findById(id, db)!;
}

/** Links a Google identity onto an existing password account with the same email. */
export function linkGoogleSub(userId: string, sub: string, db: Db = getDb()): void {
  db.prepare('UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?')
    .run(sub, nowIso(), userId);
}

export async function checkPassword(user: User, password: string): Promise<boolean> {
  if (!user.password_hash) return false;
  return verifyPassword(password, user.password_hash);
}

export function updateDisplayName(userId: string, name: string, db: Db = getDb()): void {
  db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(name.trim().slice(0, 40), nowIso(), userId);
}
