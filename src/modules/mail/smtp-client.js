// Minimal SMTP client on node:net / node:tls — no dependencies.
// Supports STARTTLS upgrade, implicit TLS, and AUTH LOGIN. Intended for
// production use behind a trusted relay (Postfix, SES SMTP, SendGrid SMTP).
import net from 'node:net';
import tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';

function readReply(socket, timeoutMs = 15_000, signal) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let text = '';
    let bytes = 0;
    let expectedCode = null;
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => fail(new Error('SMTP reply timeout.')), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', fail);
      socket.off('end', onClose);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    }
    function fail(error) { cleanup(); reject(error); }
    function onClose() { fail(new Error('SMTP connection closed before a complete reply.')); }
    function onAbort() { fail(signal.reason || new Error('SMTP command cancelled.')); }
    function onData(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return fail(new Error('SMTP reply exceeds the 64 KB response limit.'));
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const match = /^(\d{3})(?:([- ])(.*))?$/.exec(line);
        if (!match) return fail(new Error('SMTP server returned a malformed reply.'));
        const code = Number(match[1]);
        if (expectedCode !== null && code !== expectedCode) return fail(new Error('SMTP multiline reply changed its status code.'));
        expectedCode = code;
        text += `${line}\r\n`;
        // A numeric prefix in a partial chunk is NOT a complete reply. Only
        // the terminating line delimiter releases the next protocol command.
        if (match[2] !== '-') { cleanup(); resolve({ code, text }); return; }
      }
    }
    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('end', onClose);
    socket.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (socket.destroyed) onClose();
  });
}

async function command(socket, line, expectedCodes) {
  const controller = new AbortController();
  const pending = readReply(socket, 15_000, controller.signal);
  try { socket.write(`${line}\r\n`); } catch (error) { controller.abort(error); }
  const reply = await pending;
  if (!expectedCodes.includes(reply.code)) {
    throw new Error(`SMTP command failed (${reply.code}): ${reply.text.split('\n')[0]}`);
  }
  return reply;
}

function waitForSmtpConnection(socket, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off(event, connected); socket.off('error', failed); socket.off('close', closed); };
    const connected = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const closed = () => failed(new Error('SMTP connection closed during setup.'));
    socket.once(event, connected);
    socket.once('error', failed);
    socket.once('close', closed);
  });
}

// Dot-stuffing per RFC 5321 §4.5.2.
function encodeBody(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendSmtpMail({ host, port, secure, user, pass }, { from, to, subject, text }) {
  for (const [name, value] of Object.entries({ from, to, subject })) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error(`SMTP ${name} must be a single-line string.`);
  }
  const socket = secure
    ? tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' })
    : net.connect({ host, port });
  socket.setTimeout(30_000, () => socket.destroy(new Error('SMTP socket timeout.')));

  let channel = socket;
  try {
    await waitForSmtpConnection(socket, secure ? 'secureConnect' : 'connect');
    const greeting = await readReply(socket);
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.text}`);
    await command(socket, `EHLO quicker-portal.local`, [250]);

    if (!secure) {
      await command(socket, 'STARTTLS', [220]);
      channel = tls.connect({ socket, servername: host, minVersion: 'TLSv1.2' });
      channel.setTimeout(30_000, () => channel.destroy(new Error('SMTP socket timeout.')));
      await waitForSmtpConnection(channel, 'secureConnect');
      await command(channel, `EHLO quicker-portal.local`, [250]);
    }

    if (user) {
      await command(channel, 'AUTH LOGIN', [334]);
      await command(channel, Buffer.from(user, 'utf8').toString('base64'), [334]);
      await command(channel, Buffer.from(pass, 'utf8').toString('base64'), [235]);
    }

    const fromAddress = from.match(/<([^>]+)>/)?.[1] || from;
    await command(channel, `MAIL FROM:<${fromAddress}>`, [250]);
    await command(channel, `RCPT TO:<${to}>`, [250, 251]);
    await command(channel, 'DATA', [354]);
    const message = [
      `From: ${from}`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      encodeBody(text)
    ].join('\r\n');
    await command(channel, `${message}\r\n.`, [250]);
    await command(channel, 'QUIT', [221]).catch(() => {});
  } finally {
    if (channel !== socket) channel.destroy();
    socket.destroy();
  }
}
