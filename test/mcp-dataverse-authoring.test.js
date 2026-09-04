import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';
import { validateSchema } from '../src/modules/mcp/protocol.js';

const requiredTools = {
  create_model_app: ['createMdaApp', 'write'],
  get_model_app_source: ['mdaAppSource', 'read'],
  patch_model_app_source: ['patchMdaAppSource', 'write'],
  update_model_app_source: ['saveMdaAppSource', 'write'],
  get_model_app_sitemap: ['mdaSitemap', 'read'],
  patch_model_app_sitemap: ['patchMdaSitemap', 'write'],
  update_model_app_sitemap: ['saveMdaSitemapXml', 'write'],
  get_relationship: ['tableRelationshipDetail', 'read'],
  create_relationship: ['createTableRelationship', 'write'],
  update_relationship: ['updateTableRelationship', 'write'],
  delete_relationship: ['deleteTableRelationship', 'destructive'],
  add_solution_component: ['addSolutionComponent', 'write'],
  remove_solution_component: ['removeSolutionComponent', 'destructive'],
  create_form: ['createComponentDesigner', 'write'],
  create_view: ['createComponentDesigner', 'write'],
  create_web_resource: ['createWebResource', 'write'],
  update_web_resource: ['updateWebResource', 'write'],
  list_security_privileges: ['securityPrivileges', 'read'],
  get_role_privileges: ['rolePrivilegeAssignments', 'read'],
  preview_role_privileges: ['previewRolePrivileges', 'read'],
  apply_role_privileges: ['applyRolePrivileges', 'write'],
  rollback_role_privileges: ['rollbackRolePrivileges', 'destructive'],
  rollback_role_table_permissions: ['rollbackRoleTablePermissions', 'destructive']
};

test('complete Dataverse authoring lifecycles are exposed with correct routing and risk', () => {
  for (const [name, [action, risk]] of Object.entries(requiredTools)) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool, `${name} must be advertised`);
    assert.equal(tool.action, action, `${name} must route to ${action}`);
    assert.equal(tool.risk, risk, `${name} has the wrong approval risk`);
    assert.ok(tool.timeoutMs >= (risk === 'read' ? 55_000 : 90_000));
  }
});

test('model-app creation uses a GUID icon input and source changes are revision bound', () => {
  const create = MCP_TOOL_BY_NAME.get('create_model_app');
  assert.ok(create.inputSchema.properties.webResourceId);
  assert.equal(create.argumentEnvelope, undefined, 'app creation arguments must not be hidden in an envelope');
  for (const name of ['patch_model_app_source', 'update_model_app_source', 'patch_model_app_sitemap', 'update_model_app_sitemap']) {
    assert.ok(MCP_TOOL_BY_NAME.get(name).inputSchema.required.includes('expectedRevision'), `${name} must reject stale writes`);
  }
  const patchSource = MCP_TOOL_BY_NAME.get('patch_model_app_source').inputSchema;
  assert.ok(validateSchema(patchSource, { appModuleId: 'id', expectedRevision: 'revision' }).length, 'an empty source patch must be rejected before desktop dispatch');
  assert.deepEqual(validateSchema(patchSource, {
    appModuleId: 'id', expectedRevision: 'revision', appGraphOperations: [{ op: 'set', path: '/nodes', value: [] }]
  }), []);
});

test('relationship schemas enforce type-specific table and lookup inputs', () => {
  const schema = MCP_TOOL_BY_NAME.get('create_relationship').inputSchema;
  assert.ok(validateSchema(schema, { type: 'oneToMany', schemaName: 'new_Account_Project' }).some(error => /referencedEntity/.test(error)));
  assert.deepEqual(validateSchema(schema, {
    type: 'oneToMany', schemaName: 'new_Account_Project', referencedEntity: 'account',
    referencingEntity: 'new_project', lookupSchemaName: 'new_Account'
  }), []);
  assert.ok(validateSchema(schema, { type: 'manyToMany', schemaName: 'new_Project_Team' }).some(error => /entity1LogicalName/.test(error)));
});

test('form and view creation require complete source or a same-table template', () => {
  const form = MCP_TOOL_BY_NAME.get('create_form').inputSchema;
  assert.ok(validateSchema(form, { tableLogicalName: 'account', name: 'Main' }).length);
  assert.deepEqual(validateSchema(form, { tableLogicalName: 'account', name: 'Main', templateFormId: '00000000-0000-0000-0000-000000000001' }), []);
  const view = MCP_TOOL_BY_NAME.get('create_view').inputSchema;
  assert.ok(validateSchema(view, { tableLogicalName: 'account', name: 'Active' }).length);
  assert.deepEqual(validateSchema(view, { tableLogicalName: 'account', name: 'Active', fetchXml: '<fetch/>', layoutXml: '<grid/>' }), []);
  for (const name of ['patch_form', 'update_form', 'patch_view', 'update_view']) {
    assert.ok(MCP_TOOL_BY_NAME.get(name).inputSchema.required.includes('expectedRevision'), `${name} must require a fresh read revision`);
  }
});

test('web-resource replacement and security rollback contracts preserve canonical state', () => {
  const web = MCP_TOOL_BY_NAME.get('update_web_resource');
  assert.deepEqual(web.inputSchema.required, ['webResourceId', 'expectedRevision', 'content']);
  assert.match(web.description, /canonical-content verification/i);
  for (const name of ['patch_web_resource', 'patch_cloud_flow']) {
    assert.ok(MCP_TOOL_BY_NAME.get(name).inputSchema.required.includes('expectedRevision'), `${name} must require a fresh read revision`);
  }
  for (const name of ['apply_role_privileges', 'rollback_role_privileges', 'rollback_role_table_permissions']) {
    assert.ok(MCP_TOOL_BY_NAME.get(name).inputSchema.required.includes('confirm'), `${name} must require explicit confirmation`);
  }
  const rollbackDepth = MCP_TOOL_BY_NAME.get('rollback_role_privileges').inputSchema.properties.rollbackPlan.items.properties.previousDepth;
  assert.deepEqual(validateSchema(rollbackDepth, 8), []);
  assert.deepEqual(validateSchema(rollbackDepth, 'organization'), []);
  assert.ok(validateSchema(rollbackDepth, 3).length, 'unsupported privilege masks must be rejected');
});
