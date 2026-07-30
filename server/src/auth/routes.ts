import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import {
  checkPassword,
  createUserFromGoogle,
  createUserWithPassword,
  findByEmail,
  findByGoogleSub,
  findById,
  isValidEmail,
  linkGoogleSub,
  toPublic,
  updateDisplayName,
} from './users.ts';
import { validatePassword } from './password.ts';
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens.ts';
import { clearLimit, hitLimit, LOGIN_RULE, SIGNUP_RULE } from '../lib/rate-limit.ts';
import { verifyGoogleIdToken } from './google.ts';

const REFRESH_COOKIE = 'playkit_refresh';

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Games are served from other domains, so the cookie must be cross-site.
    // SameSite=None requires Secure, which requires HTTPS in production.
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd,
    path: '/auth',
    maxAge: config.refreshTokenTtlDays * 86_400,
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
}

async function sessionPayload(userId: string) {
  const user = findById(userId);
  if (!user) return null;
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.display_name,
  });
  return { user: toPublic(user), accessToken };
}

/** Reads and verifies the bearer token; returns null when absent or invalid. */
export async function currentUser(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyAccessToken(header.slice(7));
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const claims = await currentUser(req);
  if (!claims) {
    reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
    return null;
  }
  return claims;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (req, reply) => {
    const { email, password, displayName } = (req.body ?? {}) as Record<string, unknown>;

    const limit = hitLimit(`signup:${req.ip}`, SIGNUP_RULE);
    if (limit.limited) {
      return reply
        .code(429)
        .header('retry-after', String(limit.retryAfterSec))
        .send({ error: 'rate_limited', message: 'Too many sign-ups from this address. Try again later.' });
    }

    if (!isValidEmail(email)) {
      return reply.code(400).send({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    const pw = validatePassword(password);
    if (!pw.ok) {
      return reply.code(400).send({ error: 'weak_password', message: pw.message });
    }
    if (findByEmail(email)) {
      // Registration is not an oracle we try to hide: a "pick another email"
      // message is far better UX, and email existence leaks via login anyway.
      return reply
        .code(409)
        .send({ error: 'email_taken', message: 'An account with that email already exists.' });
    }

    const user = await createUserWithPassword(email, password as string, displayName);
    setRefreshCookie(reply, issueRefreshToken(user.id));
    return reply.code(201).send(await sessionPayload(user.id));
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'invalid_request', message: 'Email and password are required.' });
    }

    const key = `login:${req.ip}:${email.toLowerCase()}`;
    const limit = hitLimit(key, LOGIN_RULE);
    if (limit.limited) {
      return reply
        .code(429)
        .header('retry-after', String(limit.retryAfterSec))
        .send({ error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' });
    }

    const user = findByEmail(email);
    const ok = user ? await checkPassword(user, password) : false;
    if (!user || !ok) {
      // Same message either way, so this endpoint can't be used to enumerate emails.
      return reply
        .code(401)
        .send({ error: 'invalid_credentials', message: 'That email and password combination is incorrect.' });
    }

    clearLimit(key);
    setRefreshCookie(reply, issueRefreshToken(user.id));
    return reply.send(await sessionPayload(user.id));
  });

  /** Exchanges the refresh cookie for a new access token, rotating the refresh token. */
  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: 'no_session', message: 'Not signed in.' });
    }
    const rotated = rotateRefreshToken(token);
    if (!rotated) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'session_expired', message: 'Your session expired. Sign in again.' });
    }
    setRefreshCookie(reply, rotated.nextToken);
    return reply.send(await sessionPayload(rotated.userId));
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) revokeRefreshToken(token);
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/auth/logout-everywhere', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;
    revokeAllForUser(claims.sub);
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;
    const user = findById(claims.sub);
    if (!user) return reply.code(404).send({ error: 'not_found', message: 'Account no longer exists.' });
    return reply.send({ user: toPublic(user) });
  });

  app.patch('/auth/me', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;
    const { displayName } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof displayName !== 'string' || !displayName.trim()) {
      return reply.code(400).send({ error: 'invalid_request', message: 'displayName is required.' });
    }
    updateDisplayName(claims.sub, displayName);
    return reply.send({ user: toPublic(findById(claims.sub)!) });
  });

  /**
   * Google sign-in. The browser obtains an ID token from Google Identity
   * Services and posts it here; we verify the signature against Google's public
   * keys. This needs only a client ID — no client secret to store or leak.
   */
  app.post('/auth/google', async (req, reply) => {
    const { idToken } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof idToken !== 'string' || !idToken) {
      return reply.code(400).send({ error: 'invalid_request', message: 'idToken is required.' });
    }
    if (!config.googleClientId) {
      return reply
        .code(501)
        .send({ error: 'google_not_configured', message: 'Google sign-in is not configured on this server.' });
    }

    const profile = await verifyGoogleIdToken(idToken);
    if (!profile) {
      return reply.code(401).send({ error: 'invalid_token', message: 'Google sign-in failed.' });
    }

    let user = findByGoogleSub(profile.sub);
    if (!user) {
      const existing = findByEmail(profile.email);
      if (existing) {
        // Same person signing in a different way — link, don't duplicate.
        linkGoogleSub(existing.id, profile.sub);
        user = findById(existing.id)!;
      } else {
        user = createUserFromGoogle({ email: profile.email, sub: profile.sub, name: profile.name });
      }
    }

    setRefreshCookie(reply, issueRefreshToken(user.id));
    return reply.send(await sessionPayload(user.id));
  });
}
