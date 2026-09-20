import Ajv2020 from 'ajv/dist/2020.js';

// Compile trusted catalog schemas once, not once per tool invocation. Never
// coerce arguments or insert defaults: the desktop must receive what was approved.
const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true, ownProperties: true, validateFormats: false, verbose: true });
const validators = new WeakMap();

export function validateSchema(schema, value, path = 'arguments', errors = []) {
  if (schema === undefined) return errors;
  let validate = typeof schema === 'object' && schema !== null ? validators.get(schema) : null;
  if (!validate) {
    validate = ajv.compile(schema);
    if (typeof schema === 'object' && schema !== null) validators.set(schema, validate);
  }
  if (!validate(value)) {
    for (const error of (validate.errors || []).slice(0, 40)) {
      const property = error.params.missingProperty || error.params.additionalProperty;
      let detail = `${path}${error.instancePath}${property ? `.${property}` : ''} ${error.message}.`;
      if (error.keyword === 'enum' && Array.isArray(error.params.allowedValues)) {
        detail += ` Allowed values: ${error.params.allowedValues.map(value => JSON.stringify(value)).join(', ')}.`;
      }
      if (error.keyword === 'additionalProperties' && error.parentSchema?.properties) {
        detail += ` Allowed properties: ${Object.keys(error.parentSchema.properties).join(', ')}.`;
      }
      errors.push(detail);
    }
  }
  return errors;
}
