import { config as qpConfig } from '../../config/config.js';

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const localHost = qpConfig.host === '0.0.0.0' ? '127.0.0.1' : qpConfig.host;
const baseUrl = String(
  qpConfig.mcp.publicBaseUrl || `http://${localHost}:${qpConfig.port}`
).replace(/\/+$/, '');
const parsed = new URL(baseUrl);

function allowedHosts() {
  const configured = String(process.env.QP_IDE_MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return configured.length
    ? configured
    : [...new Set([parsed.host, `127.0.0.1:${qpConfig.port}`, `localhost:${qpConfig.port}`, `[::1]:${qpConfig.port}`])];
}

const clientRequestBudgetMs = intEnv('QP_IDE_MCP_CLIENT_BUDGET_MS', 60_000);
const responseHeadroomMs = 12_000;

export const config = Object.freeze({
  baseUrl,
  publicUrl: parsed,
  // Prompts use this generic resource. Bootstrap and the bridge advertise the
  // account-specific resource containing the authenticated QP user id.
  mcpUrl: `${baseUrl}/ide/mcp`,
  mcpAllowedHosts: allowedHosts(),
  maxReadBytes: intEnv('QP_IDE_MCP_MAX_READ_BYTES', 1024 * 1024),
  maxFileBytes: intEnv('QP_IDE_MCP_MAX_FILE_BYTES', 5 * 1024 * 1024),
  bridgeRpcTimeoutMs: intEnv('QP_IDE_MCP_BRIDGE_RPC_TIMEOUT_MS', Math.max(5_000, clientRequestBudgetMs - responseHeadroomMs)),
  bridgePingTimeoutMs: intEnv('QP_IDE_MCP_BRIDGE_PING_TIMEOUT_MS', 8_000),
  bridgeWriteTimeoutMs: intEnv('QP_IDE_MCP_BRIDGE_WRITE_TIMEOUT_MS', Math.max(5_000, clientRequestBudgetMs - responseHeadroomMs)),
  clientRequestBudgetMs,
  responseHeadroomMs,
  logLevel: process.env.QP_LOG_LEVEL || 'info',
  scopes: ['mcp:read', 'mcp:write', 'offline_access'],
  isLoopback: ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
});

export default config;
