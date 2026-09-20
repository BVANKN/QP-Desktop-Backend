export const EXECUTION_MODES = Object.freeze(['simple', 'verified', 'autonomous']);

const MODE_SET = new Set(EXECUTION_MODES);

export function defaultExecutionMode(tool) {
  return tool?.risk === 'read' ? 'simple' : 'verified';
}

export function normalizeExecutionMode(value, tool) {
  const mode = String(value || defaultExecutionMode(tool)).trim().toLowerCase();
  return MODE_SET.has(mode) ? mode : '';
}

// A mode selected in Quicker Portal belongs to the connection, not to an AI
// generated tool payload. Verified is the migration default for connections
// created before this setting existed: it preserves the existing write policy
// and only adds evidence to reads, which are already non-mutating.
export function configuredExecutionMode(value) {
  const mode = String(value || 'verified').trim().toLowerCase();
  return MODE_SET.has(mode) ? mode : 'verified';
}

export function executionModeSchema(schema) {
  if (!schema || schema.type !== 'object') return schema;
  const resumable = Array.isArray(schema?.if?.required) && schema.if.required.includes('resumeOperationId');
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      executionMode: {
        type: 'string',
        enum: EXECUTION_MODES,
        description: 'Connection mode wins. simple runs once; verified proves results; autonomous repairs until verified or blocked. Uncertain writes are reconciled, never replayed.'
      }
    },
    ...(resumable ? {
      then: {
        ...(schema.then || {}),
        maxProperties: 2,
        propertyNames: { enum: ['resumeOperationId', 'executionMode'] }
      }
    } : {})
  };
}

export function splitExecutionArguments(args = {}, tool, connectionMode) {
  const requestedMode = normalizeExecutionMode(args?.executionMode, tool);
  const mode = connectionMode === undefined ? requestedMode : configuredExecutionMode(connectionMode);
  if (!mode) return { mode: '', arguments: args };
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'executionMode')) {
    return { mode, arguments: args || {} };
  }
  const clean = { ...args };
  delete clean.executionMode;
  return { mode, arguments: clean };
}

export function executionPolicyMetadata(tool) {
  return {
    supportedModes: EXECUTION_MODES,
    defaultMode: defaultExecutionMode(tool),
    uncertainMutationRule: 'reconcile-before-retry'
  };
}
