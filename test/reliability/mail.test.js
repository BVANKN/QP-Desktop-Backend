import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'qp-mail-regression-'));
process.env.QP_BACKEND_DATA_DIR = directory;
process.env.QP_MAIL_TRANSPORT = 'outbox';
after(() => fsp.rm(directory, { force: true, recursive: true }));
function smtp(deps = {}) {
  const source = fs.readFileSync(new URL('../../src/modules/mail/smtp-client.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
  const api = vm.createContext({ Buffer, AbortController, StringDecoder, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)), clearTimeout, ...deps });
  vm.runInContext(source, api); return api;
}
function socket() { return Object.assign(new EventEmitter(), { destroyed: false, setTimeout() {}, destroy() { this.destroyed = true; }, write() {} }); }
test('SMTP replies wait for a complete final line across arbitrary TCP chunks', async () => {
  const api = smtp(); const stream = socket(); let completed = false;
  const pending = api.readReply(stream).then(reply => { completed = true; return reply; });
  stream.emit('data', Buffer.from('250-mail.example\r\n250 O'));
  await Promise.resolve(); assert.equal(completed, false);
  stream.emit('data', Buffer.from('K\r')); await Promise.resolve(); assert.equal(completed, false);
  stream.emit('data', Buffer.from('\n'));
  assert.equal((await pending).code, 250);
  assert.equal(stream.listenerCount('data'), 0);
});
test('SMTP disconnects reject promptly and remove listeners', async () => {
  const api = smtp(); const stream = socket(); const pending = api.readReply(stream);
  stream.emit('end');
  await assert.rejects(pending, /closed|ended|disconnect/i);
  assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('error'), 0);
});
test('SMTP command installs its response listener before writing', async () => {
  const api = smtp(); const stream = socket();
  stream.write = () => stream.emit('data', Buffer.from('250 OK\r\n'));
  assert.equal((await api.command(stream, 'NOOP', [250])).code, 250);
});
test('SMTP rejects overlong replies instead of retaining unbounded response text', async () => {
  const api = smtp(); const stream = socket(); const pending = api.readReply(stream);
  stream.emit('data', Buffer.from(`250 ${'x'.repeat(70000)}\r\n`));
  await assert.rejects(pending, /large|limit/i);
});
test('failed SMTP connections are destroyed even before the greeting', async () => {
  const stream = socket();
  const api = smtp({ net: { connect() { queueMicrotask(() => stream.emit('error', new Error('connection failed'))); return stream; } } });
  await assert.rejects(api.sendSmtpMail({ host: 'example.invalid', port: 25, secure: false }, { from: 'from@example.invalid', to: 'to@example.invalid', subject: 'Test', text: 'Test' }), /connection failed/);
  assert.equal(stream.destroyed, true);
});
test('concurrent outbox messages for one recipient never overwrite each other', async () => {
  const { sendMail } = await import('../../src/modules/mail/mailer.js');
  const clock = Date.now; Date.now = () => 123456789;
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => sendMail({ to: 'user@example.invalid', subject: `Message ${index}`, text: `Unique ${index}` })));
  } finally { Date.now = clock; }
  const files = await fsp.readdir(path.join(directory, 'outbox'));
  assert.equal(files.length, 12);
  const contents = await Promise.all(files.map(file => fsp.readFile(path.join(directory, 'outbox', file), 'utf8')));
  for (let index = 0; index < 12; index++) assert.ok(contents.some(text => text.includes(`Subject: Message ${index}\r\n`)));
});
