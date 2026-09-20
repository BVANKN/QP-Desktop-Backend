import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';
import { validateSchema } from '../src/modules/mcp/schema-validator.js';

function errors(name, args) {
  const tool = MCP_TOOL_BY_NAME.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return validateSchema(tool.inputSchema, args);
}

function openObjects(schema, path = '$', rows = []) {
  if (!schema || typeof schema !== 'object') return rows;
  if (schema.type === 'object' && schema.additionalProperties === true) rows.push({ path, schema });
  if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) openObjects(value, `${path}.${key}`, rows);
  if (schema.items) openObjects(schema.items, `${path}[]`, rows);
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[key])) schema[key].forEach((value, index) => openObjects(value, `${path}.${key}[${index}]`, rows));
  if (schema.if) openObjects(schema.if, `${path}.if`, rows);
  if (schema.then) openObjects(schema.then, `${path}.then`, rows);
  if (schema.else) openObjects(schema.else, `${path}.else`, rows);
  return rows;
}

test('all MCP tools advertise a closed top-level argument object', () => {
  assert.ok(MCP_TOOLS.length >= 329, `unexpected tool count ${MCP_TOOLS.length}`);
  for (const tool of MCP_TOOLS) {
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} input must be an object schema`);
    assert.notEqual(tool.inputSchema?.additionalProperties, true, `${tool.name} must not accept arbitrary top-level properties`);
  }
});

test('every intentionally open nested payload explains and marks its dynamic keys', () => {
  for (const tool of MCP_TOOLS) {
    for (const { path, schema } of openObjects(tool.inputSchema)) {
      assert.ok(String(schema.description || '').length >= 24, `${tool.name} ${path} has undocumented dynamic keys`);
      assert.equal(schema['x-quickerportal-dynamic-keys'], true, `${tool.name} ${path} must explicitly mark dynamic keys`);
    }
  }
});

test('create_table exactly matches the Electron desktop createTable contract', () => {
  assert.deepEqual(errors('create_table', { definition: {
    schemaName: 'new_Project',
    displayName: 'Project',
    pluralName: 'Projects',
    description: 'Projects',
    ownershipType: 'UserOwned',
    primaryNameSchemaName: 'new_ProjectName',
    primaryNameDisplayName: 'Project Name',
    primaryNameMaxLength: 200,
    hasActivities: true,
    hasNotes: true,
    isAvailableOffline: false,
    isAuditEnabled: true
  }}), []);
  assert.ok(errors('create_table', { definition: { SchemaName: 'new_Project' } }).length, 'raw Dataverse metadata casing must be rejected');
  assert.ok(errors('create_table', { definition: { schemaName: 'new_Project', displayCollectionName: 'Projects' } }).length, 'unsupported displayCollectionName alias must be rejected');
  assert.ok(errors('create_table', { definition: { schemaName: 'new_Project', primaryColumn: { schemaName: 'new_Name' } } }).length, 'invented primaryColumn wrapper must be rejected');
});

test('update_table accepts every and only desktop-supported mutable property', () => {
  const valid = ['displayName','pluralName','description','isAuditEnabled','isDuplicateDetectionEnabled','isValidForAdvancedFind','isQuickCreateEnabled','changeTrackingEnabled','isAvailableOffline'];
  for (const key of valid) {
    const value = key === 'displayName' || key === 'pluralName' || key === 'description' ? 'Updated' : true;
    assert.deepEqual(errors('update_table', { logicalName: 'new_project', changes: { [key]: value } }), [], key);
  }
  assert.ok(errors('update_table', { logicalName: 'new_project', changes: {} }).length);
  assert.ok(errors('update_table', { logicalName: 'new_project', changes: { ownershipType: 'OrganizationOwned' } }).length);
});

test('create_column exposes the exact desktop type vocabulary and rejects guessed aliases', () => {
  const exactTypes = ['Text','MultilineText','WholeNumber','Decimal','Money','DateTime','Boolean'];
  for (const type of exactTypes) {
    assert.deepEqual(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: `new_${type}`, displayName: type, type } }), [], type);
  }
  for (const type of ['Choice','Picklist','OptionSet']) {
    assert.deepEqual(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: `new_${type}`, displayName: type, type, optionSetOptions: [{ label: 'Active' }, { label: 'Inactive', value: 100000001 }] } }), [], type);
  }
  for (const guessed of ['String','string','text','SingleLineText','StringAttributeMetadata','Single Line of Text','Whole Number','Currency','Lookup']) {
    assert.ok(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: 'new_Test', type: guessed } }).length, guessed);
  }
  assert.ok(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: 'new_Status', type: 'Choice' } }).length, 'choice requires options');
  assert.ok(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: 'new_Code', type: 'Text', required: true } }).length, 'ignored required alias must be rejected');
  assert.deepEqual(errors('create_column', { tableLogicalName: 'new_project', definition: { schemaName: 'new_Code', type: 'Text', requiredLevel: 'ApplicationRequired', maxLength: 100 } }), []);
});

test('update_column exactly exposes mutable desktop fields', () => {
  assert.deepEqual(errors('update_column', { tableLogicalName: 'new_project', columnLogicalName: 'new_code', changes: {
    displayName: 'Code', description: 'Code field', requiredLevel: 'Recommended', maxLength: 200, precision: 2,
    isAuditEnabled: true, isValidForAdvancedFind: true, isSecured: false
  }}), []);
  for (const invalid of [{ type: 'Money' }, { schemaName: 'new_Other' }, { required: true }]) {
    assert.ok(errors('update_column', { tableLogicalName: 'new_project', columnLogicalName: 'new_code', changes: invalid }).length);
  }
});

test('model app and connection reference update payloads are closed and correctly enveloped', () => {
  assert.deepEqual(errors('update_model_app', { appModuleId: '00000000-0000-0000-0000-000000000001', changes: { name: 'App', description: 'D', navigationType: 0, isFeatured: false, webResourceId: '00000000-0000-0000-0000-000000000002' } }), []);
  assert.ok(errors('update_model_app', { appModuleId: 'x', changes: { madeUp: true } }).length);
  assert.deepEqual(errors('update_connection_reference', { connectionReferenceId: '00000000-0000-0000-0000-000000000001', changes: { displayName: 'Ref', connectionId: 'conn', connectorId: '/providers/Microsoft.PowerApps/apis/shared_x', description: 'D', promptingBehavior: 0 } }), []);
  assert.ok(errors('update_connection_reference', { connectionReferenceId: 'x', changes: { promptingBehavior: 9 } }).length);
  assert.equal(MCP_TOOL_BY_NAME.get('update_connection_reference')?.argumentEnvelope, 'changes');
});

test('command-bar preview shapes are closed and unambiguous', () => {
  const base = { logicalName: 'account', solutionUniqueName: 'MySolution' };
  assert.deepEqual(errors('preview_command_bar_change', { ...base, operation: 'hide', mutation: { controlId: 'Mscrm.HomepageGrid.account.Delete' } }), []);
  assert.deepEqual(errors('preview_command_bar_change', { ...base, operation: 'rules', mutation: { controlId: 'new.account.Command.Button', displayRules: [] } }), []);
  assert.ok(errors('preview_command_bar_change', { ...base, operation: 'rules', mutation: { controlId: 'new.account.Command.Button', guessedRule: true } }).length);
  assert.ok(errors('create_command_bar_control', { ...base, command: { name: 'Open', label: 'Open', surface: 'mainGrid', action: { type: 'url', url: 'https://example.com' }, unsupported: true }, confirm: true }).length);
});

test('schema validation errors state allowed enums and allowed fixed properties', () => {
  const schema = { type: 'object', properties: { type: { type: 'string', enum: ['Text','Choice'] } }, required: ['type'], additionalProperties: false };
  assert.ok(validateSchema(schema, { type: 'String' }).some(error => error.includes('Allowed values: "Text", "Choice"')));
  assert.ok(validateSchema(schema, { type: 'Text', bogus: true }).some(error => error.includes('Allowed properties: type')));
});
