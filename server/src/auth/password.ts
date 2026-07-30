import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem?: number;
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams,
) => Promise<Buffer>;

// scrypt cost parameters. N=2^15 keeps a single hash around ~100ms on a laptop,
// which is slow enough to make offline cracking expensive and fast enough that
// login feels instant.
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LEN = 32;

/**
 * scrypt needs roughly 128 * N * r bytes, which for our parameters is ~34 MB —
 * above Node's 32 MB default. We raise the ceiling generously rather than
 * weakening N, and derive it so changing PARAMS can't silently break hashing.
 */
function maxmemFor(p: { N: number; r: number }): number {
  return Math.max(64 * 1024 * 1024, 256 * p.N * p.r);
}

/** Formats as `scrypt$N$r$p$salt$hash`, so parameters can change without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, { ...PARAMS, maxmem: maxmemFor(PARAMS) });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  // Cost parameters come from the stored hash, so hashes written under older
  // settings keep verifying after PARAMS changes.
  const stored_params = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };

  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, {
      ...stored_params,
      maxmem: maxmemFor(stored_params),
    });
  } catch {
    return false;
  }

  // Constant-time compare so we don't leak how much of the hash matched.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface PasswordProblem {
  ok: false;
  message: string;
}

/**
 * Deliberately minimal rules: length is what actually matters, and complexity
 * requirements mostly push people toward `Password1!`.
 */
export function validatePassword(password: unknown): { ok: true } | PasswordProblem {
  if (typeof password !== 'string') return { ok: false, message: 'Password is required.' };
  if (password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (password.length > 200) return { ok: false, message: 'Password must be under 200 characters.' };
  return { ok: true };
}
