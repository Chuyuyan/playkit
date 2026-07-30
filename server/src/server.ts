import { buildApp } from './app.ts';
import { config } from './config.ts';
import { getDb } from './db/index.ts';

const app = await buildApp();

// Touch the database at boot so a broken path fails loudly here rather than on
// the first player's request.
getDb();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`playkit listening on http://${config.host}:${config.port}`);
  app.log.info(`allowed origins: ${config.allowedOrigins.join(', ')}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
