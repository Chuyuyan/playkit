import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-validation';
process.env.SIGNUP_MAX_ATTEMPTS = '10000';

const { buildApp } = await import('../src/app.ts');

const GAME = 'investment-time-machine';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
});

let counter = 0;

/** Registers a fresh player and returns an auth header for them. */
async function newPlayer(displayName?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `gamer${++counter}@example.com`,
      password: 'a-good-password',
      displayName: displayName ?? `Gamer ${counter}`,
    },
  });
  assert.equal(res.statusCode, 201, `register failed: ${res.body}`);
  return { auth: { authorization: `Bearer ${res.json().accessToken}` } };
}

describe('cloud saves', () => {
  test('returns null before anything is saved', async () => {
    const { auth } = await newPlayer();
    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/save`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().save, null);
  });

  test('round-trips an arbitrary JSON save', async () => {
    const { auth } = await newPlayer();
    const data = {
      day: 2,
      cash: 7500.5,
      decisions: [{ id: 'the-spike', choice: 'partial-position' }],
      investorDna: { fomo: 0.3, patience: 0.8 },
    };

    const put = await app.inject({
      method: 'PUT',
      url: `/games/${GAME}/save`,
      headers: auth,
      payload: { data },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().save.version, 1);

    const get = await app.inject({ method: 'GET', url: `/games/${GAME}/save`, headers: auth });
    assert.deepEqual(get.json().save.data, data, 'save must survive the round trip exactly');
  });

  test('bumps the version on each write', async () => {
    const { auth } = await newPlayer();
    for (const expected of [1, 2, 3]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/games/${GAME}/save`,
        headers: auth,
        payload: { data: { n: expected } },
      });
      assert.equal(res.json().save.version, expected);
    }
  });

  test('rejects a stale write instead of clobbering newer progress', async () => {
    const { auth } = await newPlayer();
    await app.inject({ method: 'PUT', url: `/games/${GAME}/save`, headers: auth, payload: { data: { n: 1 } } });
    await app.inject({ method: 'PUT', url: `/games/${GAME}/save`, headers: auth, payload: { data: { n: 2 } } });
    // Now at version 2. A client that still thinks it's on version 1 must lose.
    const stale = await app.inject({
      method: 'PUT',
      url: `/games/${GAME}/save`,
      headers: auth,
      payload: { data: { n: 99 }, version: 1 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().currentVersion, 2);

    // The newer data is intact.
    const get = await app.inject({ method: 'GET', url: `/games/${GAME}/save`, headers: auth });
    assert.deepEqual(get.json().save.data, { n: 2 });
  });

  test("players cannot see each other's saves", async () => {
    const a = await newPlayer();
    const b = await newPlayer();

    await app.inject({
      method: 'PUT',
      url: `/games/${GAME}/save`,
      headers: a.auth,
      payload: { data: { secret: 'player-a-only' } },
    });

    const asB = await app.inject({ method: 'GET', url: `/games/${GAME}/save`, headers: b.auth });
    assert.equal(asB.json().save, null, 'player B must not read player A data');
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/save` });
    assert.equal(res.statusCode, 401);
  });

  test('rejects an unregistered game id', async () => {
    const { auth } = await newPlayer();
    const res = await app.inject({ method: 'GET', url: '/games/not-a-real-game/save', headers: auth });
    assert.equal(res.statusCode, 404);
  });

  test('rejects an oversized save', async () => {
    const { auth } = await newPlayer();
    const res = await app.inject({
      method: 'PUT',
      url: `/games/${GAME}/save`,
      headers: auth,
      payload: { data: { blob: 'x'.repeat(300 * 1024) } },
    });
    assert.equal(res.statusCode, 413);
  });

  test('save can be deleted', async () => {
    const { auth } = await newPlayer();
    await app.inject({ method: 'PUT', url: `/games/${GAME}/save`, headers: auth, payload: { data: { n: 1 } } });
    await app.inject({ method: 'DELETE', url: `/games/${GAME}/save`, headers: auth });
    const get = await app.inject({ method: 'GET', url: `/games/${GAME}/save`, headers: auth });
    assert.equal(get.json().save, null);
  });
});

describe('leaderboards', () => {
  test('ranks players by their best score, descending', async () => {
    const board = 'test-ranking';
    const low = await newPlayer('Low Scorer');
    const high = await newPlayer('High Scorer');
    const mid = await newPlayer('Mid Scorer');

    for (const [player, score] of [[low, 100], [high, 900], [mid, 500]] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/games/${GAME}/scores`,
        headers: player.auth,
        payload: { score, board },
      });
      assert.equal(res.statusCode, 201);
    }

    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?board=${board}` });
    const names = res.json().entries.map((e: { displayName: string }) => e.displayName);
    assert.deepEqual(names, ['High Scorer', 'Mid Scorer', 'Low Scorer']);
    assert.deepEqual(
      res.json().entries.map((e: { rank: number }) => e.rank),
      [1, 2, 3],
    );
  });

  test('keeps only a player best, not one row per attempt', async () => {
    const board = 'test-best-only';
    const { auth } = await newPlayer('Improving Player');

    for (const score of [10, 300, 50]) {
      await app.inject({ method: 'POST', url: `/games/${GAME}/scores`, headers: auth, payload: { score, board } });
    }

    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?board=${board}` });
    const entries = res.json().entries;
    assert.equal(entries.length, 1, 'one row per player');
    assert.equal(entries[0].score, 300, 'best score wins');
  });

  test('boards are independent', async () => {
    const { auth } = await newPlayer('Two Board Player');
    await app.inject({ method: 'POST', url: `/games/${GAME}/scores`, headers: auth, payload: { score: 7, board: 'alpha' } });

    const alpha = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?board=alpha` });
    const beta = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?board=beta` });
    assert.equal(alpha.json().entries.length, 1);
    assert.equal(beta.json().entries.length, 0);
  });

  test('reports the caller rank', async () => {
    const board = 'test-my-rank';
    const first = await newPlayer('First');
    const second = await newPlayer('Second');
    await app.inject({ method: 'POST', url: `/games/${GAME}/scores`, headers: first.auth, payload: { score: 1000, board } });
    await app.inject({ method: 'POST', url: `/games/${GAME}/scores`, headers: second.auth, payload: { score: 10, board } });

    const rank = await app.inject({ method: 'GET', url: `/games/${GAME}/my-rank?board=${board}`, headers: second.auth });
    assert.equal(rank.json().rank, 2);
    assert.equal(rank.json().best, 10);
  });

  test('rank is null for a player with no score', async () => {
    const { auth } = await newPlayer();
    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/my-rank?board=empty`, headers: auth });
    assert.equal(res.json().rank, null);
  });

  test('rejects a non-numeric score', async () => {
    const { auth } = await newPlayer();
    const res = await app.inject({
      method: 'POST',
      url: `/games/${GAME}/scores`,
      headers: auth,
      payload: { score: 'not a number' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('submitting a score requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: `/games/${GAME}/scores`, payload: { score: 5 } });
    assert.equal(res.statusCode, 401);
  });

  test('leaderboard is readable without signing in', async () => {
    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard` });
    assert.equal(res.statusCode, 200);
  });

  test('respects the limit parameter and caps it', async () => {
    const res = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?limit=1` });
    assert.ok(res.json().entries.length <= 1);
    const huge = await app.inject({ method: 'GET', url: `/games/${GAME}/leaderboard?limit=99999` });
    assert.equal(huge.statusCode, 200, 'an absurd limit should be clamped, not an error');
  });
});
