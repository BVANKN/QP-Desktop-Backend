// Mail dispatch with pluggable transports.
//   outbox — writes RFC-822 .eml files to data/outbox (default; zero config,
//            perfect for local dev: open the file to read the code).
//   smtp   — built-in minimal SMTP client (see smtp-client.js).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config/config.js';
import { logger } from '../../core/logger.js';
import { sendSmtpMail } from './smtp-client.js';

const outboxDir = path.join(config.dataDir, 'outbox');

async function sendToOutbox({ to, subject, text }) {
  await fsp.mkdir(outboxDir, { recursive: true, mode: 0o700 });
  const fileName = `${Date.now()}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`;
  const message = [
    `From: ${config.mail.from}`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    text
  ].join('\r\n');
  await fsp.writeFile(path.join(outboxDir, fileName), message, { encoding: 'utf8', mode: 0o600 });
  logger.info('Mail written to outbox', { to, subject, file: fileName });
}

export async function sendMail({ to, subject, text }) {
  if (config.mail.transport === 'smtp') {
    if (!config.mail.smtp.host) throw new Error('QP_SMTP_HOST is required when QP_MAIL_TRANSPORT=smtp.');
    await sendSmtpMail(config.mail.smtp, { from: config.mail.from, to, subject, text });
    logger.info('Mail sent via SMTP', { to, subject });
    return;
  }
  await sendToOutbox({ to, subject, text });
}

export function verificationEmail({ name, code, ttlMinutes }) {
  return {
    subject: `${code} is your Quicker Portal verification code`,
    text: [
      `Hi ${name},`,
      '',
      `Your Quicker Portal verification code is: ${code}`,
      '',
      `This code expires in ${ttlMinutes} minutes. If you did not request it, ignore this email —`,
      'no account will be created without the code.',
      '',
      '— Quicker Portal'
    ].join('\n')
  };
}
