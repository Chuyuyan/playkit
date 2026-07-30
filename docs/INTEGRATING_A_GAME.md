# Adding playkit to a game

The pattern used for Investment Time Machine, in the order that keeps the game
playable at every step.

## Principle: accounts are optional

A player who never signs in must get exactly the game they had before. So the
integration is written so that a missing or unreachable playkit server changes
nothing except that progress isn't synced. Concretely:

- the client is `null` when `VITE_PLAYKIT_URL` is unset,
- the sign-in UI renders nothing in that case,
- every cloud call is wrapped so a failure can't interrupt gameplay.

## 1. Vendor the SDK

The SDK is a single dependency-free ES module, so games copy the built file
rather than depending on a registry:

```bash
cd playkit/sdk && npm run build
cp dist/playkit.js ../../<your-game>/src/lib/playkit.js
```

## 2. Create the client

```js
// src/playkitClient.js
import { createPlaykit } from './lib/playkit.js';

const baseUrl = import.meta.env.VITE_PLAYKIT_URL ?? '';

export const accountsEnabled = Boolean(baseUrl);
export const playkit = accountsEnabled
  ? createPlaykit({ baseUrl, gameId: 'your-game-id' })
  : null;
```

`gameId` must be listed in the server's `GAME_IDS`, or saves and scores are
rejected with a 404.

For local development, add `.env.local` (git-ignored):

```
VITE_PLAYKIT_URL=http://localhost:4000
```

…and make sure your dev origin is in the server's `ALLOWED_ORIGINS`.

## 3. Restore the session on load

```js
useEffect(() => {
  if (!accountsEnabled) return;
  playkit.restore().then(setUser).catch(() => {});
}, []);
```

`restore()` uses the httpOnly refresh cookie, so a returning player is signed in
without typing anything. It resolves to `null` when there's no session — not an
error.

## 4. Save progress

Pass the `version` you loaded so a second device can't silently overwrite newer
progress:

```js
const existing = await playkit.loadProgress();     // { data, version } | null
await playkit.saveProgress(nextState, existing?.version);
```

Handle the conflict explicitly if the game has long sessions:

```js
import { SaveConflictError } from './lib/playkit.js';

try {
  await playkit.saveProgress(state, version);
} catch (err) {
  if (err instanceof SaveConflictError) {
    // Server has newer data — reload it, or ask the player which to keep.
  }
}
```

## 5. Choose the leaderboard metric deliberately

Investment Time Machine ranks **Decision Quality**, not money earned — ranking
returns would reward the exact luck-chasing the game is trying to unteach. Pick
the number that reflects what your game is actually about:

```js
await playkit.submitScore(dqScore, { board: 'decision-quality' });
const top = await playkit.getLeaderboard({ board: 'decision-quality', limit: 10 });
```

Boards are independent strings, so one game can have several (per campaign, per
difficulty).

Note that scores are client-reported: fine among friends, trivially cheatable by
a determined player. Server-authoritative scoring would mean replaying game logic
on the server.

## 6. Keep failures invisible

Cloud sync is never the point of the moment it happens in. In ITM the save runs
after the results screen is already on screen, and a failure is swallowed:

```js
async function recordRun(finished) {
  if (!accountsEnabled || !user) return;
  try {
    /* save + submit score */
  } catch {
    // Losing a cloud save must never interrupt the player.
  }
}
```

## Checklist

- [ ] `gameId` added to the server's `GAME_IDS`
- [ ] game origin added to the server's `ALLOWED_ORIGINS`
- [ ] `VITE_PLAYKIT_URL` set in the host's build environment
- [ ] game still fully playable with `VITE_PLAYKIT_URL` unset
- [ ] production build contains no localhost URL (`grep -r localhost dist/`)
