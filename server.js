// Entry point. Binds to loopback by default — expose it through a TLS
// terminator (or set QP_BACKEND_HOST) when deploying beyond the local machine.
import { createApp } from './src/app.js';
import { config } from './src/config/config.js';
import { logger } from './src/core/logger.js';

const server = createApp();

server.listen(config.port, config.host, () => {
  logger.info('QP-X-XRM backend listening', {
    host: config.host,
    port: config.port,
    env: config.env,
    dataDir: config.dataDir,
    mailTransport: config.mail.transport
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection', { error: String(reason?.stack || reason) });
});
