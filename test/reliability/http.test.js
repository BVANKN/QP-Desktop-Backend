import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createContext, readJsonBody, sendJson } from '../../src/core/http/context.js';
import { Router } from '../../src/core/http/router.js';
import { AppError } from '../../src/core/errors.js';
function request(url = '/', host = 'localhost') {
  return { url, headers: { host }, method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
}
test('malformed Host headers become exposed HTTP 400 validation errors', () => {
  for (const host of ['bad host', 'a@b.invalid', 'host.invalid/path', '[broken']) {
    assert.throws(() => createContext(request('/', host), {}), error => error.status === 400 && error.code === 'VALIDATION_ERROR');
  }
});
test('request targets cannot replace the HTTP origin', () => {
  for (const url of ['//other.invalid/path', 'https://other.invalid/path']) {
    assert.throws(() => createContext(request(url), {}), error => error.status === 400);
  }
  assert.equal(createContext(request('/api?name=x', '[::1]:4817'), {}).url.searchParams.get('name'), 'x');
});
test('JSON body parsing accepts parameters but rejects prefix lookalike media types', async () => {
  const body = type => ({ req: Object.assign(Readable.from([Buffer.from('{"value":1}')]), { headers: { 'content-type': type } }) });
  assert.deepEqual(await readJsonBody(body('Application/JSON; charset=utf-8')), { value: 1 });
  await assert.rejects(readJsonBody(body('application/jsonp')), error => error.status === 400);
  await assert.rejects(readJsonBody(body('application/json-evil')), error => error.status === 400);
});
test('malformed JSON and over-limit streams report 400 and 413 respectively', async () => {
  const body = text => ({ req: Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(readJsonBody(body('{broken')), error => error.status === 400);
  await assert.rejects(readJsonBody(body('"0123456789"'), 5), error => error.status === 413);
});
test('route params decode only after matching and malformed encodings produce 400', () => {
  const router = new Router(); router.get('/users/:id/settings', () => {});
  assert.equal(router.match('GET', '/users/%zz/unrelated'), null);
  assert.throws(() => router.match('GET', '/users/%zz/settings'), error => error.status === 400);
  assert.equal(router.match('GET', '/users/a%20b/settings').params.id, 'a b');
  assert.equal(router.match('POST', '/users/a/settings').methodMismatch, true);
});
function appHarness() {
  // The actual HTTP callback with the excluded MCP transport stubbed out.
  // This does not claim to boot the dependency-blocked full backend.
  const source = fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
  const server = Object.assign(new EventEmitter(), { close() { this.emit('close'); return this; } });
  let requestHandler;
  const context = vm.createContext({
    http: { createServer: callback => { requestHandler = callback; return server; } },
    createContext, sendJson, AppError, config: { rateLimit: { global: {} }, requestTimeoutMs: 15000 },
    logger: { info() {}, error() {} }, applySecurityHeaders() {}, applyCors: () => false,
    consumeRateLimit() {}, ensureDataDir() {}, buildRouter: () => new Router(),
    createIdeMcpSubsystem: () => ({ handles: () => false, attach() {}, close: async () => {} }),
    pruneExpiredSessions: async () => {}, setInterval: () => ({ unref() {} }), clearInterval() {}, process
  });
  vm.runInContext(source, context); context.createApp();
  return requestHandler;
}
test('HTTP callback contains context-creation failures instead of rejecting the server request promise', async () => {
  const callback = appHarness();
  const response = { setHeader() {}, writeHead(status) { this.statusCode = status; }, end(text) { this.body = text; this.writableEnded = true; } };
  await assert.doesNotReject(callback(request('/', 'bad host'), response));
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).ok, false);
});
