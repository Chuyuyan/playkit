import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-validation';
process.env.SIGNUP_MAX_ATTEMPTS = '10000';
process.env.RESET_MAX_ATTEMPTS = '10000';
// Enough config for reset to be "enabled"; mail is captured, never sent.
process.env.PUBLIC_URL = 'https://playkit.test';
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'playkit@test';

const { buildApp } = await import('../src/app.ts');
const { issueResetToken, consumeResetToken } = await import('../src/auth/reset.ts');
const { findByEmail } = await import('../src/auth/users.ts');

// Capture outbound mail instead of sending it.
const sent: { to: string; subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

let app: FastifyInstance;
let counter = 0;

before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); globalThis.fetch = realFetch; });

async function newUser(password = 'a-good-password') {
  const email = `reset${++counter}@example.com`;
  const res = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { email, password, displayName: `Player ${counter}` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { email, password };
}

/** Pulls the token out of the most recent captured email. */
function tokenFromLastMail(): string {
  const mail = sent.at(-1);
  assert.ok(mail, 'expected an email to have been sent');
  const m = mail.text.match(/token=([^\s]+)/);
  assert.ok(m, `no token in email: ${mail.text}`);
  return decodeURIComponent(m[1]);
}

describe('forgot password', () => {
  test('sends a reset link to a real account', async () => {
    const { email } = await newUser();
    sent.length = 0;
    const res = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, email);
    assert.match(sent[0].text, /playkit\.test\/reset\?token=/);
  });

  test('answers identically for an unknown address, and sends nothing', async () => {
    const { email } = await newUser();
    const known = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    sent.length = 0;
    const unknown = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'nobody-at-all@example.com' },
    });
    // Same status and same body — the endpoint must not reveal who has an account.
    assert.equal(unknown.statusCode, known.statusCode);
    assert.deepEqual(unknown.json(), known.json());
    assert.equal(sent.length, 0, 'must not email a non-existent account');
  });

  test('rejects a malformed address', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password', payload: { email: 'not-an-email' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('reset password', () => {
  test('sets the new password and lets the player sign in with it', async () => {
    const { email } = await newUser();
    sent.length = 0;
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const token = tokenFromLastMail();

    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token, password: 'a-brand-new-password' },
    });
    assert.equal(res.statusCode, 200, res.body);

    const withNew = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: 'a-brand-new-password' },
    });
    assert.equal(withNew.statusCode, 200, 'new password should work');

    const withOld = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: 'a-good-password' },
    });
    assert.equal(withOld.statusCode, 401, 'old password must stop working');
  });

  test('a token works only once', async () => {
    const { email } = await newUser();
    sent.length = 0;
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const token = tokenFromLastMail();

    const first = await app.inject({
      method: 'POST', url: '/auth/reset-password', payload: { token, password: 'first-new-password' },
    });
    assert.equal(first.statusCode, 200);

    const replay = await app.inject({
      method: 'POST', url: '/auth/reset-password', payload: { token, password: 'second-new-password' },
    });
    assert.equal(replay.statusCode, 400, 'a used token must be refused');
  });

  test('requesting a second link invalidates the first', async () => {
    const { email } = await newUser();
    sent.length = 0;
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const older = tokenFromLastMail();
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const newer = tokenFromLastMail();
    assert.notEqual(older, newer);

    const stale = await app.inject({
      method: 'POST', url: '/auth/reset-password', payload: { token: older, password: 'x-good-password' },
    });
    assert.equal(stale.statusCode, 400, 'superseded token must be refused');

    const current = await app.inject({
      method: 'POST', url: '/auth/reset-password', payload: { token: newer, password: 'x-good-password' },
    });
    assert.equal(current.statusCode, 200);
  });

  test('an expired token is refused', async () => {
    const { email } = await newUser();
    const user = findByEmail(email)!;
    const token = issueResetToken(user.id);
    // Reach into the row rather than waiting 30 minutes.
    const { getDb } = await import('../src/db/index.ts');
    getDb()
      .prepare('UPDATE reset_tokens SET expires_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), user.id);

    const outcome = await consumeResetToken(token, 'another-good-password');
    assert.equal(outcome.ok, false);
    assert.match(outcome.message ?? '', /expired/i);
  });

  test('a forged token is refused', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'not-a-real-token', password: 'a-good-password' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('rejects a weak new password', async () => {
    const { email } = await newUser();
    sent.length = 0;
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const token = tokenFromLastMail();
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password', payload: { token, password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'weak_password');
  });

  test('resetting revokes every existing session', async () => {
    const { email, password } = await newUser();
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw]).find((c) =>
      typeof c === 'string' && c.startsWith('playkit_refresh='),
    ) as string;
    const refreshCookie = cookie.split(';')[0];

    // The session works before the reset.
    const before = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: refreshCookie } });
    assert.equal(before.statusCode, 200);

    sent.length = 0;
    await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: tokenFromLastMail(), password: 'a-replacement-password' },
    });

    const after = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: refreshCookie } });
    assert.equal(after.statusCode, 401, 'sessions must not survive a password reset');
  });
});

describe('the reset page', () => {
  test('is served, and reads the token from the URL itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/reset?token=abc123' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /URLSearchParams/);
  });

  test('never reflects the token into the page', async () => {
    const nasty = '"></script><script>alert(1)</script>';
    const res = await app.inject({
      method: 'GET', url: `/reset?token=${encodeURIComponent(nasty)}`,
    });
    assert.equal(res.statusCode, 200);
    // Nothing from the query string reaches the document at all, so there is
    // no escaping to get wrong.
    assert.ok(!res.body.includes('alert(1)'), 'token must never appear in the markup');
    const plain = await app.inject({ method: 'GET', url: '/reset' });
    assert.equal(res.body, plain.body, 'the page is static regardless of the query');
  });
});
