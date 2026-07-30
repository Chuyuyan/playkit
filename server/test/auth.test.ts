import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Point the app at a throwaway database before anything imports config.
process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-validation';
// Every request in this suite shares one IP, so the production signup ceiling
// would lock the suite out. The rate-limit test below sets its own tight
// budget, so the limiter is still exercised.
process.env.SIGNUP_MAX_ATTEMPTS = '10000';
process.env.LOGIN_MAX_ATTEMPTS = '10';

const { buildApp } = await import('../src/app.ts');
const { hashPassword, verifyPassword } = await import('../src/auth/password.ts');

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
});

/** Pulls the refresh cookie out of a response so we can replay it. */
function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  const found = list.find((c) => typeof c === 'string' && c.startsWith('playkit_refresh='));
  assert.ok(found, 'expected a refresh cookie');
  return (found as string).split(';')[0];
}

let counter = 0;
const uniqueEmail = () => `player${++counter}@example.com`;

describe('password hashing', () => {
  test('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
  });

  test('produces a different hash each time (unique salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    assert.notEqual(a, b);
    // ...but both still verify.
    assert.equal(await verifyPassword('same password', a), true);
    assert.equal(await verifyPassword('same password', b), true);
  });

  test('never stores the plaintext', async () => {
    const hash = await hashPassword('super-secret-value');
    assert.ok(!hash.includes('super-secret-value'));
  });
});

describe('registration', () => {
  test('creates an account and returns an access token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: 'a-good-password', displayName: 'Chuyu' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.user.displayName, 'Chuyu');
    assert.ok(body.accessToken);
    assert.equal(body.user.password_hash, undefined, 'must not leak the hash');
    refreshCookie(res);
  });

  test('rejects a duplicate email', async () => {
    const email = uniqueEmail();
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'a-good-password' } });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'another-password' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'email_taken');
  });

  test('rejects a bad email and a short password', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'a-good-password' },
    });
    assert.equal(bad.statusCode, 400);

    const short = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: 'short' },
    });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error, 'weak_password');
  });

  test('defaults the display name to the email local part', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'no-name-given@example.com', password: 'a-good-password' },
    });
    assert.equal(res.json().user.displayName, 'no-name-given');
  });
});

describe('login', () => {
  test('succeeds with the right password', async () => {
    const email = uniqueEmail();
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'a-good-password' } });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'a-good-password' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().accessToken);
  });

  test('is case-insensitive on the email', async () => {
    const email = `MixedCase${++counter}@Example.com`;
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'a-good-password' } });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: email.toUpperCase(), password: 'a-good-password' },
    });
    assert.equal(res.statusCode, 200);
  });

  test('gives the same error for a wrong password and an unknown email', async () => {
    const email = uniqueEmail();
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'a-good-password' } });

    const wrongPw = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'not-the-password' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody-here@example.com', password: 'not-the-password' },
    });

    assert.equal(wrongPw.statusCode, 401);
    assert.equal(noSuchUser.statusCode, 401);
    // Identical response bodies — no email enumeration.
    assert.deepEqual(wrongPw.json(), noSuchUser.json());
  });

  test('rate-limits repeated failures', async () => {
    const email = uniqueEmail();
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'a-good-password' } });

    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'wrong' },
      });
      if (res.statusCode === 429) {
        sawLimit = true;
        assert.ok(res.headers['retry-after'], 'should tell the client when to retry');
        break;
      }
    }
    assert.ok(sawLimit, 'expected to be rate limited within 12 attempts');
  });
});

describe('sessions', () => {
  test('protected routes reject missing and forged tokens', async () => {
    const none = await app.inject({ method: 'GET', url: '/auth/me' });
    assert.equal(none.statusCode, 401);

    const forged = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    assert.equal(forged.statusCode, 401);
  });

  test('access token identifies the caller on /auth/me', async () => {
    const email = uniqueEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'a-good-password', displayName: 'Player One' },
    });
    const { accessToken } = reg.json();

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, email);
    assert.equal(me.json().user.displayName, 'Player One');
  });

  test('refresh rotates the token and invalidates the old one', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: 'a-good-password' },
    });
    const first = refreshCookie(reg);

    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: first } });
    assert.equal(refreshed.statusCode, 200);
    assert.ok(refreshed.json().accessToken);
    const second = refreshCookie(refreshed);
    assert.notEqual(first, second, 'refresh token should rotate');

    // Replaying the consumed token must fail.
    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: first } });
    assert.equal(replay.statusCode, 401);

    // The new one still works.
    const again = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: second } });
    assert.equal(again.statusCode, 200);
  });

  test('logout revokes the refresh token', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: 'a-good-password' },
    });
    const cookie = refreshCookie(reg);

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });

    const after = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });

  test('display name can be updated', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: 'a-good-password', displayName: 'Before' },
    });
    const { accessToken } = reg.json();

    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: 'After' },
    });
    assert.equal(res.json().user.displayName, 'After');
  });
});

describe('google sign-in', () => {
  test('rejects a token that is not a real Google ID token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'clearly.not.valid' },
    });
    // 501 when unconfigured, 401 when configured but the token is bogus.
    assert.ok([401, 501].includes(res.statusCode), `unexpected ${res.statusCode}`);
  });

  test('requires an idToken', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/google', payload: {} });
    assert.equal(res.statusCode, 400);
  });
});
