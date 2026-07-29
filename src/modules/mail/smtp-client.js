// Minimal SMTP client on node:net / node:tls — no dependencies.
// Supports STARTTLS upgrade, implicit TLS, and AUTH LOGIN. Intended for
// production use behind a trusted relay (Postfix, SES SMTP, SendGrid SMTP).
import net from 'node:net';
import tls from 'node:tls';

function readReply(socket, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP reply timeout.'));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      // Reply complete when the last line is "NNN " (space, not dash).
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number.parseInt(last.slice(0, 3), 10), text: buffer });
      }
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket, line, expectedCodes) {
  socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (!expectedCodes.includes(reply.code)) {
    throw new Error(`SMTP command failed (${reply.code}): ${reply.text.split('\n')[0]}`);
  }
  return reply;
}

// Dot-stuffing per RFC 5321 §4.5.2.
function encodeBody(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendSmtpMail({ host, port, secure, user, pass }, { from, to, subject, text }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' })
    : net.connect({ host, port });
  socket.setTimeout(30_000, () => socket.destroy(new Error('SMTP socket timeout.')));

  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  try {
    const greeting = await readReply(socket);
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.text}`);
    await command(socket, `EHLO quicker-portal.local`, [250]);

    let channel = socket;
    if (!secure) {
      await command(socket, 'STARTTLS', [220]);
      channel = tls.connect({ socket, servername: host, minVersion: 'TLSv1.2' });
      await new Promise((resolve, reject) => {
        channel.once('secureConnect', resolve);
        channel.once('error', reject);
      });
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
    channel.write(`${message}\r\n.\r\n`);
    const accepted = await readReply(channel);
    if (accepted.code !== 250) throw new Error(`SMTP DATA rejected: ${accepted.text}`);
    await command(channel, 'QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}
