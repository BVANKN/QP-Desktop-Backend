// Bearer-token authentication middleware. Verifies the HMAC signature and
// standard claims, then confirms the backing session has not been revoked —
// so a stolen access token dies with its session on logout.
import { AuthenticationError } from '../errors.js';
import { verifyAccessToken } from '../../lib/tokens.js';
import { isSessionActive } from '../../modules/auth/session-store.js';

export async function authenticate(ctx) {
  const header = String(ctx.req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    throw new AuthenticationError('Provide a bearer access token.');
  }
  const verdict = verifyAccessToken(header.slice(7).trim());
  if (!verdict.valid) {
    throw new AuthenticationError(
      verdict.reason === 'expired' ? 'Access token expired.' : 'Access token is invalid.',
      verdict.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    );
  }
  if (!(await isSessionActive(verdict.payload.sid, verdict.payload.sub))) {
    throw new AuthenticationError('Session has been revoked. Sign in again.', 'SESSION_REVOKED');
  }
  ctx.auth = verdict.payload;
}
