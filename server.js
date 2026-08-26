// Entry point. Binds to loopback by default — expose it through a TLS
// terminator (or set QP_BACKEND_HOST) when deploying beyond the local machine.
import { createApp } from './src/app.js';
import { config } from './src/config/config.js';
import { logger } from './src/core/logger.js';
import { closeMongo, initializeMongo, mongoEnabled } from './src/lib/mongo.js';
import { initializeSigningKeys } from './src/lib/key-store.js';
import { ensureSampleUser } from './src/modules/users/sample-user.js';

if (mongoEnabled()) await initializeMongo();
await initializeSigningKeys();
const sampleUser = await ensureSampleUser();
if (sampleUser.created) logger.warn('Default sample account provisioned. Disable or replace it before exposing a production service.', { email: '123@gmail.com' });
const server = createApp();

// Said once, loudly, at boot. Losing every account on the next restart is not
// something an operator should have to discover from a user who cannot sign in.
if (!config.storage.persistent) {
  logger.error('Account storage is EPHEMERAL — every account, session, signing key, and MCP connection will be lost on the next restart or deploy.', {
    dataDir: config.dataDir,
    fix: 'Configure MONGODB_URI for Atlas persistence, or mount a persistent disk and set QP_BACKEND_DATA_DIR.'
  });
}

server.listen(config.port, config.host, () => {
  logger.info('QP-X-XRM backend listening', {
    host: config.host,
    port: config.port,
    env: config.env,
    storageMode: config.storage.mode,
    database: config.storage.mode === 'mongodb' ? config.mongo.database : undefined,
    dataDir: config.storage.mode === 'filesystem' ? config.dataDir : undefined,
    mailTransport: config.mail.transport,
    storagePersistent: config.storage.persistent
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => {
      void closeMongo().finally(() => process.exit(0));
    });
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection', { error: String(reason?.stack || reason) });
});
