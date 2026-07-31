import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { config, passwordResetEnabled } from './config.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerGameRoutes } from './games/routes.ts';
import { registerResetPage } from './reset-page.ts';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? !config.isProd });

  await app.register(cors, {
    // Explicit allowlist, not a wildcard: we send credentials, and `*` is both
    // insecure and rejected by browsers for credentialed requests.
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / same-origin / server-side
      cb(null, config.allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  app.get('/health', async () => ({
    ok: true,
    games: config.games,
    googleEnabled: Boolean(config.googleClientId),
    passwordResetEnabled,
  }));

  registerAuthRoutes(app);
  registerGameRoutes(app);
  registerResetPage(app);

  return app;
}
