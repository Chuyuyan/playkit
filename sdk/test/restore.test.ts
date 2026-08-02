/**
 * Covers when `restore()` is allowed to stay off the network.
 *
 * The rule is easy to break in either direction, and both directions are
 * invisible in normal use: ask too often and every anonymous visitor pings the
 * auth server on every page load; cache "signed out" too well and a player who
 * made an account in one game looks logged out in the next one forever.
 */
import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPlaykit } from '../src/index.ts';

const BASE = 'https://playkit.example';
const HINT = `playkit_seen:${BASE}`;

/** Just enough localStorage for the SDK; the real one is a browser API. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

let store: MemoryStorage;
let calls: string[];

/** Replies to /auth/refresh as `signedIn` dictates, and counts every hit. */
function stubFetch(signedIn: boolean) {
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    if (!signedIn) return new Response('{}', { status: 401 });
    return new Response(
      JSON.stringify({
        accessToken: 'access-token',
        user: { id: 'u1', email: 'p@example.com', displayName: 'Player' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as any).localStorage = store;
  calls = [];
});

const client = () => createPlaykit({ baseUrl: BASE, gameId: 'test-game' });

describe('restore()', () => {
  test('asks the server the first time it is ever called', async () => {
    stubFetch(false);
    assert.equal(await client().restore(), null);
    assert.equal(calls.length, 1, 'a browser with no history must be checked');
  });

  test('does not ask again right after being told "signed out"', async () => {
    stubFetch(false);
    await client().restore();
    await client().restore();
    await client().restore();
    assert.equal(calls.length, 1, 'repeat page loads must be free');
  });

  test('asks again once the cached "signed out" goes stale', async () => {
    stubFetch(false);
    await client().restore();
    assert.equal(calls.length, 1);

    // A session made in another game on this same playkit — a different origin,
    // so this origin's localStorage still says "no". It must expire.
    store.setItem(HINT, `no:${Date.now() - 1}`);
    stubFetch(true);
    const user = await client().restore();
    assert.equal(calls.length, 2);
    assert.equal(user?.displayName, 'Player', 'the shared cookie must win eventually');
  });

  test('keeps checking for someone who is signed in', async () => {
    stubFetch(true);
    assert.ok(await client().restore());
    assert.equal(store.getItem(HINT), 'yes');
    assert.ok(await client().restore());
    assert.equal(calls.length, 2, 'a real session is re-established every load');
  });

  test('signing in clears a cached "signed out"', async () => {
    stubFetch(false);
    await client().restore();
    assert.match(store.getItem(HINT) ?? '', /^no:/);

    stubFetch(true);
    const pk = client();
    await pk.login('p@example.com', 'a-good-password');
    assert.equal(store.getItem(HINT), 'yes');
  });

  test('signing out stops the next load from asking', async () => {
    stubFetch(true);
    const pk = client();
    await pk.login('p@example.com', 'a-good-password');
    await pk.logout();
    assert.match(store.getItem(HINT) ?? '', /^no:/);

    calls = [];
    await client().restore();
    assert.equal(calls.length, 0);
  });

  test('still works where localStorage throws', async () => {
    (globalThis as any).localStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    stubFetch(true);
    // Private browsing must degrade to "always ask", never to a crash.
    assert.ok(await client().restore());
    assert.equal(calls.length, 1);
  });

  test('a forged hint grants nothing', async () => {
    store.setItem(HINT, 'yes');
    stubFetch(false);
    assert.equal(await client().restore(), null, 'the server still decides');
  });
});
