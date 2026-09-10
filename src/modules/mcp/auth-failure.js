// Only credential/permission failures should start an OAuth authorization flow.
// Storage and network outages during token lookup are recoverable service errors.
export function mcpAuthFailure(error) {
  if ([401, 403].includes(error?.status)) {
    return { status: error.status, code: error.status === 401 ? -32001 : -32003, message: error.message, challenge: error.status === 401 };
  }
  return { status: 503, code: -32603, message: 'The MCP authentication service is temporarily unavailable. Retry the request; your connection has not been revoked.', challenge: false };
}
