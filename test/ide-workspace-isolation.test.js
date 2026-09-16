import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WorkspaceRegistry } from '../src/modules/ide-codewriter/workspace/registry.js';
import { ContentCache } from '../src/modules/ide-codewriter/workspace/content-cache.js';
import { fetchFiles, resolveTarget } from '../src/modules/ide-codewriter/mcp/tools/shared.js';
import { AgentHub } from '../src/modules/ide-codewriter/bridge/hub.js';

function fixture() {
  const contentCache = new ContentCache();
  const registry = new WorkspaceRegistry({ contentCache });
  const register = patch => registry.register({ userId:'user', agentId:'desktop', rootPath:'/project', kind:'folder', name:'project', ...patch });
  return { contentCache, registry, register };
}

test('folder and two files in the same directory have separate IDs, indexes and caches', () => {
  for (const useLocalId of [true,false]) {
    const { contentCache, registry, register } = fixture();
    const identities = [
      { kind:'folder',name:'project' }, { kind:'file',name:'a.txt',singleFile:'a.txt' }, { kind:'file',name:'b.txt',singleFile:'b.txt' }
    ].map((entry,index) => ({ ...entry,...(useLocalId ? { localId:String(index) } : {}) }));
    const workspaces = identities.map(register);
    assert.equal(new Set(workspaces.map(w => w.id)).size,3);
    for (const [index,w] of workspaces.entries()) {
      w.ingestManifest([{ path:'same.txt',revision:'v1' }]); contentCache.set(w.id,'same.txt','v1',String(index));
    }
    assert.equal(contentCache.get(workspaces[1].id,'same.txt','v1'),'1');
    assert.equal(register(identities[1]).id,workspaces[1].id);
    assert.equal(contentCache.get(workspaces[1].id,'same.txt','v1'),null,'re-registration invalidates previous contents');
    assert.equal(contentCache.get(workspaces[0].id,'same.txt','v1'),'0');
    workspaces[0].selected = true;
    assert.throws(() => registry.resolve('user'), /more than one|several|workspaceId|multiple/i, 'selection must not silently retarget MCP');
    if (useLocalId) assert.throws(() => register({ ...identities[1],rootPath:'/other' }), /cannot be rebound/);
  }
});

test('ownership and disconnect cleanup leave other desktops and users untouched', () => {
  const { registry, contentCache, register } = fixture();
  const a = register({ localId:'A' });
  const b = register({ localId:'A',agentId:'second-desktop' });
  const c = register({ localId:'A',agentId:'third-desktop',userId:'other' });
  assert.throws(() => registry.get(a.id,'other'));
  for (const w of [a,b,c]) contentCache.set(w.id,'file','v1',w.id);
  assert.deepEqual(registry.closeForAgent('desktop'),[a.id]);
  assert.equal(a.closed,true); assert.equal(a.connected,false);
  assert.equal(contentCache.get(a.id,'file','v1'),null);
  assert.equal(contentCache.get(b.id,'file','v1'),b.id);
  assert.equal(registry.workspaces.size,2);
});

test('manifest reset cannot leave a completed/stale index or lose pending dirty buffers', () => {
  const { register } = fixture(); const w = register();
  w.indexComplete = true; w.dirtyPaths.add('edited.txt');
  w.ingestManifest([{ path:'edited.txt',revision:'disk-v1',dirty:false }], { reset:true });
  assert.equal(w.indexComplete,false); assert.equal(w.getFile('edited.txt').dirty,true);
});

test('late reads cannot repopulate closed-project caches', async () => {
  const { register, registry, contentCache } = fixture(); const workspace = register();
  let completeRead; const read = new Promise(resolve => { completeRead = resolve; });
  const pending = fetchFiles({ contentCache }, { workspace,agent:{ request:() => read },paths:['file.txt'] });
  registry.close(workspace.id); completeRead({ files:[{ path:'file.txt',content:'old project content',revision:'r1',dirty:false }] });
  await assert.rejects(pending, { code:'WORKSPACE_GONE' }); assert.equal(contentCache.stats().entries,0);
});

test('a target closed while checking agent liveness is not mutated or replaced by selection', async () => {
  const { register, registry } = fixture(); const workspace = register();
  const ctx = { registry, sessions:{ get:() => ({ countCall() {} }) },hub:{ agentForWorkspace:() => ({ ensureAlive:async () => { registry.close(workspace.id); return 1; } }) } };
  await assert.rejects(resolveTarget(ctx,{ sessionId:'s',authInfo:{ extra:{ userId:'user' } } },workspace.id,{ requireLiveAgent:true }),{ code:'WORKSPACE_GONE' });
});

function nextFrame(socket, predicate) {
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => { socket.off('message',listener); reject(new Error('frame timeout')); },3000);
    const listener = raw => { const frame = JSON.parse(raw); if (predicate(frame)) { clearTimeout(timeout); socket.off('message',listener); resolve(frame); } };
    socket.on('message',listener);
  });
}

test('real bridge ignores another desktop closing or selecting a workspace', async t => {
  const { registry } = fixture();
  const hub = new AgentHub({ registry,users:{ verifyAppToken:async () => ({ user:{ id:'user' } }) } });
  const server = http.createServer(); hub.attach(server);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); clearInterval(hub.heartbeat); hub.wss.close(); await new Promise(resolve => server.close(resolve)); });
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ide/bridge`,{ headers:{ Authorization:'Bearer fixture' } }); sockets.push(socket);
    await nextFrame(socket,frame => frame.t === 'welcome'); return socket;
  }
  const a = await connect(), b = await connect();
  const registration = nextFrame(a,frame => frame.event === 'workspace-registered');
  a.send(JSON.stringify({ t:'event',event:'workspace-opened',localId:'a',rootPath:'/a',kind:'folder',name:'A' }));
  const { workspaceId } = await registration;
  for (const event of ['workspace-closed','workspace-selected']) b.send(JSON.stringify({ t:'event',event,workspaceId }));
  // A subsequent registration acknowledgment is an ordered barrier for B's frames.
  const barrier = nextFrame(b,frame => frame.event === 'workspace-registered');
  b.send(JSON.stringify({ t:'event',event:'workspace-opened',localId:'b',rootPath:'/b',kind:'folder',name:'B' }));
  await barrier; assert.ok(registry.workspaces.has(workspaceId)); assert.equal(Boolean(registry.workspaces.get(workspaceId).selected),false);
  const closing = once(a,'close'); a.close(); await closing;
  // Both ends of the socket close asynchronously.
  for (let i=0;i<20 && registry.workspaces.has(workspaceId);i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(registry.workspaces.has(workspaceId),false); assert.equal(registry.workspaces.size,1);
});
