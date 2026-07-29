// Append-only security audit trail (JSON lines). Every security-relevant
// event lands here with actor, IP, and outcome — never with secrets.
import { AppendOnlyLog } from '../../lib/json-store.js';
import { logger } from '../../core/logger.js';

const auditLog = new AppendOnlyLog('audit/security-events.jsonl');

export async function audit(event, fields = {}) {
  try {
    await auditLog.append({ event, ...fields });
  } catch (error) {
    // Auditing must never take the request down, but a failing audit trail
    // is an operational incident — log loudly.
    logger.error('Audit write failed', { event, error: error.message });
  }
}
