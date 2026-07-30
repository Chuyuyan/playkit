import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config, isKnownGame } from '../config.ts';
import { getDb, nowIso } from '../db/index.ts';
import { requireAuth } from '../auth/routes.ts';

interface GameParams {
  gameId: string;
}

export function registerGameRoutes(app: FastifyInstance) {
  /** Cloud save: read this player's blob for one game. */
  app.get<{ Params: GameParams }>('/games/:gameId/save', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;

    const { gameId } = req.params;
    if (!isKnownGame(gameId)) {
      return reply.code(404).send({ error: 'unknown_game', message: `Unknown game: ${gameId}` });
    }

    const row = getDb()
      .prepare('SELECT data, version, updated_at FROM saves WHERE user_id = ? AND game_id = ?')
      .get(claims.sub, gameId) as { data: string; version: number; updated_at: string } | undefined;

    if (!row) return reply.send({ save: null });

    return reply.send({
      save: { data: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at },
    });
  });

  /**
   * Cloud save: write this player's blob.
   *
   * `version` implements optimistic concurrency — a client that has fallen
   * behind (say the same account playing on a phone) gets a 409 instead of
   * silently clobbering newer progress.
   */
  app.put<{ Params: GameParams }>('/games/:gameId/save', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;

    const { gameId } = req.params;
    if (!isKnownGame(gameId)) {
      return reply.code(404).send({ error: 'unknown_game', message: `Unknown game: ${gameId}` });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.data === undefined) {
      return reply.code(400).send({ error: 'invalid_request', message: 'data is required.' });
    }

    const serialized = JSON.stringify(body.data);
    if (serialized.length > config.maxSaveBytes) {
      return reply.code(413).send({
        error: 'save_too_large',
        message: `Save exceeds ${config.maxSaveBytes} bytes.`,
      });
    }

    const db = getDb();
    const existing = db
      .prepare('SELECT version FROM saves WHERE user_id = ? AND game_id = ?')
      .get(claims.sub, gameId) as { version: number } | undefined;

    const expected = body.version;
    if (existing && typeof expected === 'number' && expected !== existing.version) {
      return reply.code(409).send({
        error: 'version_conflict',
        message: 'This game was saved elsewhere more recently.',
        currentVersion: existing.version,
      });
    }

    const nextVersion = (existing?.version ?? 0) + 1;
    const ts = nowIso();

    db.prepare(
      `INSERT INTO saves (user_id, game_id, data, version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game_id)
       DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
    ).run(claims.sub, gameId, serialized, nextVersion, ts);

    return reply.send({ save: { version: nextVersion, updatedAt: ts } });
  });

  app.delete<{ Params: GameParams }>('/games/:gameId/save', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;
    getDb()
      .prepare('DELETE FROM saves WHERE user_id = ? AND game_id = ?')
      .run(claims.sub, req.params.gameId);
    return reply.send({ ok: true });
  });

  /** Submit a score to a leaderboard. */
  app.post<{ Params: GameParams }>('/games/:gameId/scores', async (req, reply) => {
    const claims = await requireAuth(req, reply);
    if (!claims) return;

    const { gameId } = req.params;
    if (!isKnownGame(gameId)) {
      return reply.code(404).send({ error: 'unknown_game', message: `Unknown game: ${gameId}` });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const score = Number(body.score);
    if (!Number.isFinite(score)) {
      return reply.code(400).send({ error: 'invalid_score', message: 'score must be a finite number.' });
    }

    const board = typeof body.board === 'string' && body.board.trim() ? body.board.trim().slice(0, 40) : 'default';
    const meta = body.meta === undefined ? null : JSON.stringify(body.meta).slice(0, 2000);

    getDb()
      .prepare(
        `INSERT INTO scores (id, user_id, game_id, board, score, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), claims.sub, gameId, board, score, meta, nowIso());

    return reply.code(201).send({ ok: true, score, board });
  });

  /**
   * Leaderboard: each player's best score on a board, ranked.
   * Public on purpose — a leaderboard nobody can read is not a leaderboard.
   */
  app.get<{ Params: GameParams; Querystring: { board?: string; limit?: string } }>(
    '/games/:gameId/leaderboard',
    async (req, reply) => {
      const { gameId } = req.params;
      if (!isKnownGame(gameId)) {
        return reply.code(404).send({ error: 'unknown_game', message: `Unknown game: ${gameId}` });
      }

      const board = req.query.board?.trim() || 'default';
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);

      const rows = getDb()
        .prepare(
          `SELECT u.display_name AS displayName, MAX(s.score) AS score, MIN(s.created_at) AS firstSet
             FROM scores s
             JOIN users u ON u.id = s.user_id
            WHERE s.game_id = ? AND s.board = ?
            GROUP BY s.user_id
            ORDER BY score DESC, firstSet ASC
            LIMIT ?`,
        )
        .all(gameId, board, limit) as { displayName: string; score: number; firstSet: string }[];

      return reply.send({
        board,
        entries: rows.map((r, i) => ({ rank: i + 1, displayName: r.displayName, score: r.score })),
      });
    },
  );

  /** Where the signed-in player sits on a board. */
  app.get<{ Params: GameParams; Querystring: { board?: string } }>(
    '/games/:gameId/my-rank',
    async (req, reply) => {
      const claims = await requireAuth(req, reply);
      if (!claims) return;

      const board = req.query.board?.trim() || 'default';
      const db = getDb();

      const mine = db
        .prepare('SELECT MAX(score) AS best FROM scores WHERE user_id = ? AND game_id = ? AND board = ?')
        .get(claims.sub, req.params.gameId, board) as { best: number | null };

      if (mine.best === null) return reply.send({ rank: null, best: null });

      const ahead = db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT user_id, MAX(score) AS best FROM scores
              WHERE game_id = ? AND board = ? GROUP BY user_id
           ) WHERE best > ?`,
        )
        .get(req.params.gameId, board, mine.best) as { n: number };

      return reply.send({ rank: ahead.n + 1, best: mine.best });
    },
  );
}
