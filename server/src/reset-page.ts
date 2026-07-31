import type { FastifyInstance } from 'fastify';

/**
 * The page a reset link opens.
 *
 * Hosted by playkit rather than by a game: the link has to work no matter which
 * game the player came from, and every game would otherwise need its own copy
 * of this form. It is one self-contained document — no build step, no assets.
 *
 * The token is *never* interpolated into this HTML. It is read from the URL by
 * the page itself, so there is no injection surface at all: escaping would have
 * had to be exactly right forever, and `JSON.stringify` alone is not — it
 * leaves `</script>` intact, which is enough to break out of the block.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Choose a new password</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
    background: #0b0d12; color: #e7ecf3;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: 100%; max-width: 340px; padding: 26px 24px;
    background: #151922; border: 1px solid #2a3040; border-radius: 18px;
  }
  h1 { margin: 0 0 6px; font-size: 18px; }
  p.sub { margin: 0 0 18px; font-size: 13px; color: #98a2b3; }
  label { display: block; margin-bottom: 6px; font-size: 12px; color: #98a2b3; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 12px; font: inherit; font-size: 14px;
    color: #e7ecf3; background: #0b0d12; border: 1px solid #2a3040; border-radius: 10px;
  }
  input:focus { outline: none; border-color: #5b8cff; }
  button {
    width: 100%; padding: 11px; font: inherit; font-size: 14px; font-weight: 600;
    color: #fff; background: #5b8cff; border: none; border-radius: 10px; cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin: 12px 0 0; font-size: 13px; }
  .err { color: #ff5c5c; }
  .ok { color: #2ecc71; }
</style>
</head>
<body>
  <form class="card" id="f">
    <h1>Choose a new password</h1>
    <p class="sub">At least 8 characters. Signing in again afterwards will use this password.</p>
    <label for="p">New password</label>
    <input id="p" type="password" autocomplete="new-password" required minlength="8">
    <label for="p2">Repeat it</label>
    <input id="p2" type="password" autocomplete="new-password" required minlength="8">
    <button id="b" type="submit">Update password</button>
    <p class="msg" id="m"></p>
  </form>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const f = document.getElementById('f'), m = document.getElementById('m'), b = document.getElementById('b');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = document.getElementById('p').value, p2 = document.getElementById('p2').value;
    m.className = 'msg';
    if (p !== p2) { m.classList.add('err'); m.textContent = "Those two don't match."; return; }
    b.disabled = true; m.textContent = 'Updating…';
    try {
      const res = await fetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: p }),
      });
      const body = await res.json();
      if (res.ok) {
        m.classList.add('ok');
        m.textContent = body.message || 'Password updated. You can sign in now.';
        f.querySelectorAll('input').forEach((i) => (i.disabled = true));
        b.textContent = 'Done';
      } else {
        m.classList.add('err');
        m.textContent = body.message || 'That did not work.';
        b.disabled = false;
      }
    } catch {
      m.classList.add('err');
      m.textContent = 'Could not reach the server. Try again.';
      b.disabled = false;
    }
  });
</script>
</body>
</html>`;

export function registerResetPage(app: FastifyInstance) {
  app.get('/reset', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    // Static document: nothing from the query string reaches the markup.
    return reply.send(PAGE);
  });
}
