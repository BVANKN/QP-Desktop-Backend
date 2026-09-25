import { config } from './config.js';

/** Refuse to expose an account/MCP service with known-unsafe production settings. */
export function assertProductionReadiness(settings = config) {
  if (settings.storage.managedHost && settings.env !== 'production') {
    throw new Error('Managed deployments must set NODE_ENV=production before accepting traffic.');
  }
  if (settings.env !== 'production') return;
  const problems = [];
  if (!settings.storage.persistent) problems.push('durable account storage (MONGODB_URI or a mounted persistent data directory)');
  if (settings.storage.managedHost && settings.storage.mode === 'filesystem' && process.env.QP_BACKEND_PERSISTENT_VOLUME !== '1') {
    problems.push('QP_BACKEND_PERSISTENT_VOLUME=1 after verifying the data directory is mounted on a durable disk');
  }
  if (settings.verification.staticCode) problems.push('an empty QP_VERIFICATION_STATIC_CODE');
  try {
    if (new URL(settings.mcp.publicBaseUrl).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    problems.push('an HTTPS QP_MCP_PUBLIC_BASE_URL');
  }
  if (settings.mail.transport !== 'smtp' || !settings.mail.smtp.host || /@quickerportal\.local\b/i.test(settings.mail.from)) {
    problems.push('working SMTP delivery (QP_MAIL_TRANSPORT=smtp, QP_SMTP_HOST, QP_MAIL_FROM)');
  }
  if (problems.length) {
    throw new Error(`Unsafe production configuration: configure ${problems.join('; ')} before deployment.`);
  }
}
