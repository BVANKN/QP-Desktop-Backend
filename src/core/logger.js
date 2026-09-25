// Structured JSON logging to stdout with secret redaction. No transports,
// no dependencies — ship stdout to your log collector of choice.
import { config } from '../config/config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel = LEVELS[config.logging.level] ?? LEVELS.info;

// Field names whose values must never be logged.
const REDACT_KEY = /(?:password|passphrase|token|authorization|cookie|secret|apikey|api_key|connectionstring|privatekey|codeverifier|clientsecret|leasehash|refreshtoken|verificationcode|^code$|^pass$)/i;

function redact(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    clean[key] = REDACT_KEY.test(key) ? '[REDACTED]' : redact(entry, depth + 1);
  }
  return clean;
}

function write(level, message, fields) {
  if (LEVELS[level] < activeLevel) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(fields ? redact(fields) : {})
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields)
};
