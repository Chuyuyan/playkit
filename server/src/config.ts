import { randomBytes } from 'node:crypto';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * In development we generate an ephemeral signing secret so the server just
 * runs. In production a real secret is mandatory — otherwise every restart
 * would silently invalidate all tokens, and a default secret would let anyone
 * forge them.
 */
function jwtSecret(): Uint8Array {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }
    return new TextEncoder().encode(fromEnv);
  }
  if (isProd) throw new Error('JWT_SECRET is required in production');
  console.warn('[config] No JWT_SECRET set — using an ephemeral dev secret.');
  return randomBytes(32);
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',

  databasePath: process.env.DATABASE_PATH ?? './data/playkit.db',

  jwtSecret: jwtSecret(),
  accessTokenTtl: '15m',
  /** Refresh lifetime in days. Long enough that players stay logged in. */
  refreshTokenTtlDays: 30,

  /**
   * Exact origins allowed to call the API. Games live on different domains, so
   * this is an explicit allowlist — never a wildcard, because we send cookies.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://localhost:3000,http://localhost:5175')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Google OAuth client ID — only needed for Google sign-in. No secret required. */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',

  /** Registered game ids. Keeps a typo'd or hostile game id out of the DB. */
  games: (process.env.GAME_IDS ?? 'investment-time-machine,webcam-pose-runner,dance-trainer')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  maxSaveBytes: Number(process.env.MAX_SAVE_BYTES ?? 256 * 1024),

  /** Where the reset link points. Must be reachable by the player's browser. */
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  resetTokenTtlMinutes: Number(process.env.RESET_TOKEN_TTL_MINUTES ?? 30),

  // Email. 'smtp' suits a plain mailbox (Gmail app password); 'resend' is an
  // HTTP API and needs no dependency. Unset means reset emails are logged, not
  // sent — fine for development, refused in production (see the check below).
  emailProvider: (process.env.EMAIL_PROVIDER ?? '') as '' | 'smtp' | 'resend',
  emailFrom: process.env.EMAIL_FROM ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',

  // Tunable so a busy shared IP (a school network, a test suite) isn't locked
  // out by hard-coded numbers.
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 8),
  loginWindowMs: Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60_000),
  signupMaxAttempts: Number(process.env.SIGNUP_MAX_ATTEMPTS ?? 5),
  signupWindowMs: Number(process.env.SIGNUP_WINDOW_MS ?? 60 * 60_000),
} as const;

export function isKnownGame(gameId: string): boolean {
  return (config.games as readonly string[]).includes(gameId);
}

/** True once a reset link can actually be delivered and clicked. */
export const passwordResetEnabled = Boolean(config.publicUrl && config.emailProvider);

// Fail loudly rather than half-configured: a reset endpoint that silently logs
// the link to the server console in production looks like it works while
// leaving players stuck.
if (config.isProd && config.emailProvider && !config.publicUrl) {
  throw new Error('PUBLIC_URL is required when EMAIL_PROVIDER is set');
}
if (config.isProd && config.emailProvider === 'resend' && !config.resendApiKey) {
  throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
}
if (config.isProd && config.emailProvider === 'smtp' && !(config.smtpHost && config.smtpUser)) {
  throw new Error('SMTP_HOST and SMTP_USER are required when EMAIL_PROVIDER=smtp');
}
