export const EXECUTION_MODES = Object.freeze(['simple', 'verified', 'autonomous']);

const MODE_SET = new Set(EXECUTION_MODES);

export function defaultExecutionMode(tool) {
  return tool?.risk === 'read' ? 'simple' : 'verified';
}

export function normalizeExecutionMode(value, tool) {
  const mode = String(value || defaultExecutionMode(tool)).trim().toLowerCase();
  return MODE_SET.has(mode) ? mode : '';
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
        description: 'Policy: simple runs once; verified requires evidence; autonomous safely diagnoses and repairs until verified or blocked. Uncertain writes are reconciled, never replayed.'
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

export function splitExecutionArguments(args = {}, tool) {
  const mode = normalizeExecutionMode(args?.executionMode, tool);
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
