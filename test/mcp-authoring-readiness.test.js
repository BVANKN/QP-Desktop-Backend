import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir } from './helpers/test-server.js';
useTemporaryDataDir();
const { AgentHub,AgentConnection } = await import('../src/modules/ide-codewriter/bridge/hub.js');
const { WorkspaceRegistry } = await import('../src/modules/ide-codewriter/workspace/registry.js');
const { ContentCache } = await import('../src/modules/ide-codewriter/workspace/content-cache.js');
const { AppError } = await import('../src/modules/ide-codewriter/util/errors.js');
const { registerCommandTools } = await import('../src/modules/ide-codewriter/mcp/tools/command-tools.js');
const { registerWorkspaceTools } = await import('../src/modules/ide-codewriter/mcp/tools/workspace-tools.js');
const { buildServerInstructions } = await import('../src/modules/ide-codewriter/mcp/instructions.js');
const { operationContract } = await import('../src/modules/mcp/operation-contract.js');
const broker=await import('../src/modules/mcp/broker.js');
const extra={sessionId:'session',authInfo:{token:'fixture-token',scopes:['workspace:read','workspace:write'],extra:{userId:'user'}}};

function fixture(t) {
  const registry=new WorkspaceRegistry({contentCache:new ContentCache()});
  const hub=new AgentHub({registry,users:{}});
  t.after(()=>{clearInterval(hub.heartbeat);hub.wss.close();});
  const workspace=registry.register({userId:'user',agentId:'desktop',localId:'local',name:'Project',rootPath:'/project',kind:'folder'});
  const ctx={registry,hub,activeRuns:new Map(),sessions:{get:()=>({countCall(){}})}};
  return {registry,hub,workspace,ctx};
}

test('first workspace call waits for its initial index without substituting another project',async t=>{
  const {hub,workspace}=fixture(t);
  setTimeout(()=>workspace.finishIndex(),20);
  assert.equal(await hub.resolveWorkspace('user',workspace.id,500),workspace);
  await assert.rejects(hub.resolveWorkspace('other',workspace.id),{code:'NOT_FOUND'});
});

test('initialization timeout is explicit and a close cannot retarget queued work',async t=>{
  const {hub,workspace,registry}=fixture(t);
  await assert.rejects(hub.resolveWorkspace('user',workspace.id,1),e=>e.code==='WORKSPACE_INITIALIZING'&&e.details.dispatched===false);
  const waiting=hub.resolveWorkspace('user',workspace.id,500);
  registry.close(workspace.id);
  registry.register({userId:'user',agentId:'desktop',name:'Other',rootPath:'/other',kind:'folder'}).finishIndex();
  await assert.rejects(waiting,{code:'WORKSPACE_GONE'});
});

test('policy refusals do not terminate a healthy desktop socket; timeouts do',async()=>{
  let terminated=0;
  const agent=new AgentConnection({terminate(){terminated++;}},{user:{id:'user'}});
  agent.request=async()=>{throw new AppError('MCP_PAUSED','User paused sharing');};
  await assert.rejects(agent.ensureAlive(),{code:'MCP_PAUSED'}); assert.equal(terminated,0);
  agent.request=async()=>({pong:true,remoteEnabled:false});
  await assert.rejects(agent.ensureAlive(),{code:'MCP_PAUSED'}); assert.equal(terminated,0);
  agent.request=async()=>{throw new AppError('AGENT_TIMEOUT','Timed out');};
  await assert.rejects(agent.ensureAlive(),{code:'UNAVAILABLE'}); assert.equal(terminated,1);
});

test('Power Platform first call can recover when the initial heartbeat arrives',async()=>{
  const scope=['cold-user','cold-tenant','cold-env'];
  const waiting=broker.waitForDesktopReady(...scope,1000);
  setTimeout(()=>broker.heartbeatDesktop({userId:scope[0],tenantId:scope[1],environmentId:scope[2]}),20);
  assert.equal((await waiting).connected,true);
  const mismatch=await broker.waitForDesktopReady(scope[0],scope[1],'other',1000);
  assert.equal(mismatch.connected,false);assert.equal(mismatch.environmentMatches,false);
  assert.equal((await broker.waitForDesktopReady('no-user','tenant','env',1)).connected,false);
});

test('bounded operation waits return the original completion, isolate owners, and never dispatch twice',async()=>{
  const connection={id:'wait-connection',userId:'wait-user',tenantId:'tenant',environmentId:'env'};
  const job=await broker.enqueueDesktopToolCall({connection,tool:{name:'register_plugin_artifact',action:'registerPluginArtifact',risk:'write',timeoutMs:120000},arguments:{artifactToken:'fixture'},requestId:'wait-test'});
  const [claimed]=await broker.claimDesktopJobs({...connection,clientInstanceId:'desktop'});
  const waiting=broker.getDesktopOperation({userId:connection.userId,connectionId:connection.id,operationId:job.id,waitMs:1000});
  await broker.completeDesktopJob({userId:connection.userId,jobId:job.id,leaseToken:claimed.leaseToken,result:{ok:true,result:{id:'assembly-once'}}});
  const completed=await waiting;assert.equal(completed.status,'completed');assert.equal(completed.result.result.id,'assembly-once');
  assert.equal((await broker.claimDesktopJobs({...connection,clientInstanceId:'desktop'})).length,0);
  await assert.rejects(broker.getDesktopOperation({userId:'other',connectionId:connection.id,operationId:job.id,waitMs:1000}));
  const pending=operationContract({operationId:job.id,status:'leased',toolName:'register_plugin_artifact'},'power-platform');
  assert.equal(pending.continuePolling,true);assert.equal(pending.requiresChatReply,false);assert.equal(pending.pollArguments.waitMs,20000);
});

test('IDE advertises real PAC guidance and reindexing, not generic app templates',async t=>{
  const {ctx}=fixture(t), handlers=new Map();
  registerWorkspaceTools({registerTool:(name,_schema,handler)=>handlers.set(name,handler)},ctx);
  const guide=await handlers.get('get_power_platform_project_guide')({},extra);
  assert.equal(guide.isError,undefined);assert.ok(handlers.has('reindex_workspace'));
  for(const fragment of ['pac pcf init','pac plugin init','ControlManifest.Input.xml','PluginBase.cs','net462','net48','PFX','get_command_result']) {
    assert.ok(buildServerInstructions({mcpUrl:'https://example.test'}).includes(fragment),fragment);
  }
  assert.match(guide.content[0].text,/not a standalone\s+React application/);
});

test('completed command polls are replayable without rerunning or crossing workspace ownership',async t=>{
  const {ctx,workspace}=fixture(t),handlers=new Map();
  workspace.finishIndex();
  registerCommandTools({registerTool:(name,_schema,handler)=>handlers.set(name,handler)},ctx);
  ctx.activeRuns.set('run',{runId:'run',workspaceId:workspace.id,argv:['npm','run','build'],startedAt:Date.now()-10,finishedAt:Date.now(),output:{stdout:'built',stderr:''},settled:{ok:true,value:{exitCode:0,stdout:'built'}},detach(){}});
  const first=await handlers.get('get_command_result')({runId:'run'},extra);
  const repeated=await handlers.get('get_command_result')({runId:'run'},extra);
  assert.equal(first.structuredContent.passed,true);assert.deepEqual(repeated,first);assert.equal(ctx.activeRuns.size,0);
  const denied=await handlers.get('get_command_result')({runId:'run'},{...extra,authInfo:{...extra.authInfo,extra:{userId:'other'}}});
  assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error,'NOT_FOUND');
});

test('a task cannot finish while an accepted command is still running, even without required checks',async t=>{
  const {ctx,workspace,hub}=fixture(t),handlers=new Map();workspace.finishIndex();
  hub.agents.set('desktop',{emit(){}});
  registerCommandTools({registerTool:(name,_schema,handler)=>handlers.set(name,handler)},ctx);
  ctx.activeRuns.set('running',{workspaceId:workspace.id});
  const result=await handlers.get('finish_task')({workspaceId:workspace.id,summary:'Not done'},extra);
  assert.equal(result.isError,true);assert.equal(result.structuredContent.error,'COMMANDS_STILL_RUNNING');
  assert.equal(result.structuredContent.runs[0].pollArguments.runId,'running');
});

test('IDE pending polls contain a continuation, and deferred refusals preserve their actual reason',async t=>{
  const {ctx,workspace}=fixture(t),handlers=new Map();workspace.finishIndex();
  ctx.hub.heartbeat.ref(); // A real HTTP server keeps the event loop alive during long polls.
  registerCommandTools({registerTool:(name,_schema,handler)=>handlers.set(name,handler)},ctx);
  const run={runId:'slow',workspaceId:workspace.id,argv:['pac','plugin','init'],startedAt:Date.now(),output:{stdout:'working',stderr:''},promise:new Promise(()=>{}),detach(){}};
  ctx.activeRuns.set('slow',run);
  const running=await handlers.get('get_command_result')({runId:'slow',waitSec:1},extra);
  assert.equal(running.structuredContent.continuePolling,true);assert.equal(running.structuredContent.pollTool,'get_command_result');
  run.settled={ok:true,value:{error:'REJECTED_BY_USER',message:'User declined the install'}};
  const denied=await handlers.get('get_command_result')({runId:'slow'},extra);
  assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error,'REJECTED_BY_USER');assert.match(denied.content[0].text,/User declined/);
});
