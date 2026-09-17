import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readJsonBody, readFormBody, sendJson } from '../../src/core/http/context.js';

async function request(parser, contentType, body, limit, streaming = false) {
  const server = http.createServer(async (req, res) => {
    try { const value = await parser({ req }, limit); sendJson({ res }, 200, { ok: true, value }); }
    catch (error) { sendJson({ res }, error.status || 500, { error: error.message }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    return await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/', headers: { 'Content-Type': contentType, 'Transfer-Encoding': 'chunked' } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', error => resolve({ error: error.code || error.message }));
      req.setTimeout(2000, () => req.destroy(new Error('client timeout')));
      if (streaming) {
        req.write(body.slice(0, -3));
        const tail = setTimeout(() => { if (!req.destroyed) req.end(body.slice(-3)); }, 50);
        req.once('close', () => clearTimeout(tail));
      } else { req.write(body.slice(0, 3)); req.end(body.slice(3)); }
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
for (const [name, parser, contentType, body] of [
  ['JSON', readJsonBody, 'application/json', '{"large":"12345678901234567890"}'],
  ['form', readFormBody, 'application/x-www-form-urlencoded', 'large=1234567890123456789012345']
]) {
  test(`oversized chunked ${name} bodies produce HTTP 413 rather than resetting the client connection`, async () => {
    const result = await request(parser, contentType, body, 8);
    assert.equal(result.status, 413, JSON.stringify(result));
  });
}
for (const [name, parser, contentType, body] of [
  ['JSON', readJsonBody, 'application/json', '{"large":"12345678901234567890"}'],
  ['form', readFormBody, 'application/x-www-form-urlencoded', 'large=1234567890123456789012345']
]) {
  test(`oversized in-progress ${name} uploads receive HTTP 413 without a socket reset`, async () => {
    const result = await request(parser, contentType, body, 8, true);
    assert.equal(result.status, 413, JSON.stringify(result));
  });
}

test('ordinary chunked JSON input still parses and returns a complete response', async () => {
  const result = await request(readJsonBody, 'application/json; charset=utf-8', '{"value":7}', 100);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).value.value, 7);
});
