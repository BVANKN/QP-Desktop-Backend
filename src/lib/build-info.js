import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Capture deployment identity once at startup. Never run git in a request or
// publish arbitrary environment values: only a complete commit hash is allowed.
export function readBuildInfo(env = process.env, startedAt = new Date().toISOString()) {
  const raw = env.RENDER_GIT_COMMIT || env.QP_BUILD_COMMIT || '';
  const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(raw) ? raw.toLowerCase() : null;
  return Object.freeze({
    version,
    commit,
    commitSource: commit ? (env.RENDER_GIT_COMMIT ? 'render' : 'QP_BUILD_COMMIT') : null,
    startedAt
  });
}

export const buildInfo = readBuildInfo();
