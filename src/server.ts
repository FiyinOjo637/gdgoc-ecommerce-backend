import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startBackgroundJobs } from './jobs/backgroundJobs';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT} [${env.NODE_ENV}]`);
  // eslint-disable-next-line no-console
  console.log(`🚀 GDGoC E-Commerce API running at http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`📖 API docs at http://localhost:${env.PORT}/docs`);
  startBackgroundJobs();
});

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default server;
