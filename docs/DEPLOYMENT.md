# Deploying playkit

playkit is one small Node process plus one SQLite file. The only real
requirement is a **persistent disk** — a host with an ephemeral filesystem will
delete every account on each deploy.

> The steps below need accounts (Fly.io / Google Cloud) that only you can create,
> so this is a checklist for you to run, not something automated.

---

## 1. Generate a production secret

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Keep it somewhere safe. Changing it later signs everyone out (harmless, but
noticeable). The server **refuses to start** in production without it — a silent
default would let anyone forge tokens.

## 2. Pick a host with a real disk

| Host | Free tier | Persistent disk | Notes |
|------|-----------|-----------------|-------|
| **Fly.io** | yes | yes (volumes) | Recommended — volumes work on the free allowance |
| Railway | trial credit | yes | Simplest UI |
| Render | yes | **no** on free web services | Free tier would wipe the database |
| Vercel / Netlify | yes | **no** | Serverless; no place for a SQLite file |

### Fly.io walkthrough

```bash
brew install flyctl
fly auth signup            # or: fly auth login

cd playkit/server
fly launch --no-deploy     # accept the detected Node app; pick a region near you
fly volumes create playkit_data --size 1     # 1 GB is plenty

# Secrets (never commit these)
fly secrets set JWT_SECRET="<the value from step 1>"
fly secrets set ALLOWED_ORIGINS="https://your-game.vercel.app"
fly secrets set DATABASE_PATH="/data/playkit.db"

fly deploy
```

In `fly.toml`, mount the volume so the database survives deploys:

```toml
[[mounts]]
  source      = "playkit_data"
  destination = "/data"

[env]
  PORT = "8080"
  HOST = "0.0.0.0"
  NODE_ENV = "production"
```

Verify:

```bash
curl https://<your-app>.fly.dev/health
# {"ok":true,"games":[...],"googleEnabled":false}
```

## 3. Point the games at it

Each game needs the API URL at build time. For a Vite game on Vercel, add an
environment variable:

```
VITE_PLAYKIT_URL = https://<your-app>.fly.dev
```

And add that game's exact origin to `ALLOWED_ORIGINS` on the server. **Both
sides must match** — the API sends cookies, so a wildcard is not an option.

```bash
fly secrets set ALLOWED_ORIGINS="https://game-one.vercel.app,https://game-two.vercel.app"
```

### HTTPS is mandatory in production

Cross-site cookies require `SameSite=None; Secure`, which browsers only accept
over HTTPS. playkit sets this automatically when `NODE_ENV=production`. If you
serve the API over plain HTTP in production, sign-in will appear to work and then
silently fail to persist.

## 4. Register each game id

Saves and scores are rejected for unknown game ids, so a typo can't quietly
create junk rows:

```bash
fly secrets set GAME_IDS="investment-time-machine,webcam-pose-runner,dance-trainer"
```

## 5. Back up the database

One file, so backups are simple:

```bash
fly ssh console -C "sqlite3 /data/playkit.db '.backup /data/backup.db'"
fly sftp get /data/backup.db ./playkit-backup.db
```

Worth doing before any schema change. There is no migration framework yet — the
schema is created with `CREATE TABLE IF NOT EXISTS`, so additive changes are
safe and destructive ones need a manual plan.

---

## Adding Google sign-in

playkit verifies Google **ID tokens** against Google's public keys, so you only
need a client ID. There is no client secret to store, and no OAuth redirect flow
to get wrong.

### 5a. Create the client ID (you must do this)

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create a project if you don't have one.
3. **Create credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Under **Authorised JavaScript origins**, add every origin a game is served
   from — e.g. `https://your-game.vercel.app` and `http://localhost:5173` for
   development. (Leave "Authorised redirect URIs" empty; this flow doesn't use
   redirects.)
6. Copy the **Client ID**. It looks like
   `1234567890-abc123.apps.googleusercontent.com`. It is not a secret — it ships
   in your frontend.

Then tell the server about it:

```bash
fly secrets set GOOGLE_CLIENT_ID="1234...apps.googleusercontent.com"
```

`GET /health` will now report `"googleEnabled": true`.

### 5b. Add the button to a game

Load Google Identity Services and hand the resulting credential to playkit:

```html
<script src="https://accounts.google.com/gsi/client" async></script>
<div id="google-btn"></div>
```

```js
import { playkit } from './playkitClient.js';

const CLIENT_ID = '1234...apps.googleusercontent.com';

window.google.accounts.id.initialize({
  client_id: CLIENT_ID,
  callback: async ({ credential }) => {
    // `credential` is the Google ID token. playkit verifies it server-side.
    const user = await playkit.loginWithGoogle(credential);
    console.log('signed in as', user.displayName);
  },
});

window.google.accounts.id.renderButton(document.getElementById('google-btn'), {
  theme: 'outline',
  size: 'large',
});
```

playkit links the Google identity to an existing password account when the
verified email matches, so signing in "the other way" doesn't create a duplicate
player.

**Only verified Google emails are accepted.** An unverified address would let
someone claim an email they don't control and take over a password account.

---

## Operational notes

- **Rate limits** default to 8 login attempts per IP+email per 15 minutes and 5
  sign-ups per IP per hour. Behind a proxy, make sure the real client IP reaches
  Fastify or every player shares one bucket.
- **Sessions**: access tokens last 15 minutes; refresh tokens 30 days and rotate
  on every use. `POST /auth/logout-everywhere` revokes all of a user's sessions.
- **What's missing**: email verification and password reset. Both need an email
  provider (Resend, SendGrid); the token plumbing is straightforward, the
  delivery is the part that needs an account.
