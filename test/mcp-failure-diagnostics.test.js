import test from 'node:test';
import assert from 'node:assert/strict';
import { failureDiagnostics } from '../src/modules/mcp/failure-diagnostics.js';

test('classifies service failures and retains correlation without payloads', () => {
  for (const status of [400,401,403,404,409,412,429,500,503]) {
    const d = failureDiagnostics({ status, message: 'password=secret', details: { token: 'secret' } },
      { dataverseCode: '0x80040220', requestId: 'service-123', retryAfterSeconds: 30, logs: ['secret'] });
    assert.equal(d.status, status);
    assert.equal(d.serviceCode, '0x80040220');
    assert.equal(d.serviceRequestId, 'service-123');
    assert.ok(d.nextStep);
    assert.ok(!JSON.stringify(d).includes('secret'));
    assert.match(d.outcome, /earlier steps/);
  }
});
test('handles legacy, untrusted and timeout errors without claiming rollback', () => {
  assert.equal(failureDiagnostics(null).code, 'EXECUTION_ERROR');
  assert.equal(failureDiagnostics({ status: 200, code: '<script>secret</script>' }).status, undefined);
  assert.equal(failureDiagnostics({}, { requestId: 'Bearer secret', retryAfterSeconds: -1 }).serviceRequestId, undefined);
  assert.match(failureDiagnostics({ code: 'DESKTOP_TIMEOUT' }).nextStep, /does not prove/);
  assert.match(failureDiagnostics({ code: 'MCP_APPROVAL_EXPIRED' }).summary, /approval/);
});
