// Boots the app on an ephemeral port against a throwaway data directory so
// tests never touch real user data. Must be imported before any src module
// reads config (config captures QP_BACKEND_DATA_DIR at import time).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function useTemporaryDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-backend-test-'));
  process.env.QP_BACKEND_DATA_DIR = dir;
  process.env.QP_MAIL_TRANSPORT = 'outbox';
  process.env.QP_LOG_LEVEL = 'error';
  return dir;
}

export async function startTestServer() {
  const { createApp } = await import('../../src/app.js');
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function call(method, endpoint, body, { accessToken } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, body: json, headers: response.headers };
  }

  return {
    baseUrl,
    call,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

// Reads the newest verification code out of the outbox transport.
export function readLatestCode(dataDir) {
  const outbox = path.join(dataDir, 'outbox');
  const files = fs.readdirSync(outbox).sort();
  const latest = fs.readFileSync(path.join(outbox, files[files.length - 1]), 'utf8');
  return latest.match(/verification code is: (\d{6})/)?.[1] || latest.match(/(\d{6}) is your/)?.[1];
}

export const VALID_PASSWORD = 'Corr3ct-Horse-Batt3ry!';
