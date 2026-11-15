import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClientCore} from '../lib/codex-client-core.mjs';
import {createModelWorkspaceSessionProfile,createReadonlyWorkbenchSessionProfile} from '../lib/codex-profile.mjs';
import {MODEL_AI_READ_TOOLS} from '../lib/panel-tools.mjs';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {createPanelServer} from '../lib/panel-server.mjs';

const root=process.cwd();
function createClient(t){
  const profile=createModelWorkspaceSessionProfile(root),children=[];
  let names=['alpha','revit_workbench','unreported'];
  const spawn=(executable,args)=>{
    const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.stdin.writable=true;child.args=args;child.messages=[];
    child.stdin.write=(line,done)=>{const message=JSON.parse(line);child.messages.push(message);queueMicrotask(()=>{
      done?.();if(message.id===undefined)return;
      let result={};
      if(message.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}};
      if(message.method==='thread/start')result={thread:{id:'isolated-thread'}};
      if(message.method==='mcpServerStatus/list')result={data:[
        {name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',tools:Object.fromEntries(MODEL_AI_READ_TOOLS.map(tool=>[tool.name,structuredClone(tool)])),resources:[],resourceTemplates:[],toolsError:null},
        {name:'alpha',runtimeStatus:'disabled',authStatus:'unknown',tools:{},resources:[],resourceTemplates:[],toolsError:null},
      ],nextCursor:null};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n'));
    });return true;};
    child.finish=()=>{if(child.closed)return;child.closed=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.stdin.end=()=>queueMicrotask(child.finish);child.kill=()=>{queueMicrotask(child.finish);return true;};
    children.push(child);return child;
  };
  const client=new CodexClientCore(root,profile,{spawn,resolveRuntimes:()=>({codex:'fixture',python:'fixture'}),readConfiguredNames:()=>names,closeTimeoutMs:20,killTimeoutMs:10});
  client.on('dynamic-tool-request',()=>{});
  t.after(async()=>{for(const child of children)child.finish();await client.close();});
  return {client,children,setNames:value=>{names=value;}};
}

test('MCP candidate names reuse launch owner and only verified disabled entries are labeled',async t=>{
  const f=createClient(t);
  assert.throws(()=>f.client.configuredMcpCandidates(),{code:'MCP_CANDIDATES_UNAVAILABLE'});
  await f.client.start();
  const result=f.client.configuredMcpCandidates();
  assert.deepEqual(result.servers,[{name:'alpha',status:'disabled'},{name:'revit_workbench',status:'reserved'},{name:'unreported',status:'unknown'}]);
  assert.equal(result.source,'launch_snapshot');assert.equal(f.children.length,1);
  assert.ok(f.children[0].args.includes('mcp_servers.alpha.enabled=false'));
  assert.equal(f.children[0].messages.some(item=>item.method==='turn/start'),false);
  result.servers[0].name='MUTATED';assert.equal(f.client.configuredMcpCandidates().servers[0].name,'alpha');
  f.setNames(['later']);assert.equal(f.client.configuredMcpCandidates().servers[0].name,'alpha');
  await f.client.close();assert.throws(()=>f.client.configuredMcpCandidates(),{code:'MCP_CANDIDATES_UNAVAILABLE'});
});

test('only the unbound model workspace can expose MCP configuration names',async t=>{
  const f=createClient(t);await f.client.start();
  const readonly=new CodexClientCore(root,createReadonlyWorkbenchSessionProfile(root));
  assert.throws(()=>readonly.configuredMcpCandidates(),{code:'MCP_CANDIDATES_UNAVAILABLE'});
  const customer=new CodexClientCore(root,createModelWorkspaceSessionProfile(root),{skillCatalogMode:'customer'});
  assert.throws(()=>customer.configuredMcpCandidates(),{code:'MCP_CANDIDATES_UNAVAILABLE'});
});

test('account invalidation revokes the previous connection snapshot immediately',async t=>{
  const f=createClient(t);await f.client.start();assert.equal(f.client.configuredMcpCandidates().servers[0].name,'alpha');
  f.client.dispatch({method:'account/updated',params:{}},f.client._connection);
  assert.throws(()=>f.client.configuredMcpCandidates(),{code:'MCP_CANDIDATES_UNAVAILABLE'});
});

test('skill policy is a frozen trusted owner, never an accessor or mutable browser-style value',()=>{
  const profile=createModelWorkspaceSessionProfile(root);let reads=0;
  const accessor=Object.freeze(Object.defineProperty({},'catalog',{get(){reads++;return ()=>[];},enumerable:true}));
  for(const owner of [null,{},Object.freeze({}),Object.freeze({catalog:'not-callable'}),Object.freeze({catalog:()=>[],extra:true}),accessor])
    assert.throws(()=>new CodexClientCore(root,profile,{skillCatalogMode:'customer',skillCatalogOwner:owner}),/冻结所有者/);
  assert.equal(reads,0);
  assert.doesNotThrow(()=>new CodexClientCore(root,profile,{skillCatalogMode:'customer',skillCatalogOwner:Object.freeze({catalog:()=>[]})}));
});

function fakeCodex(){
  const codex=new EventEmitter();codex.profile=createModelWorkspaceSessionProfile(root);codex.skillCatalogMode='research';
  codex.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};
  codex.configuredMcpCandidates=()=>({source:'launch_snapshot',generation:1,revision:2,servers:[{name:'alpha',status:'disabled',secret:'never-return'},{name:'other',status:'unknown'}],secret:'never-return'});
  codex.close=async()=>({closed:true});return codex;
}

test('MCP candidate HTTP projection is authenticated, rejects extra inputs and strips other facts',async t=>{
  const codex=fakeCodex(),f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,codexClient:codex});t.after(()=>f.close());
  const listed=await f.post('mcp-candidates');assert.equal(listed.status,200);
  assert.deepEqual(listed.body,{source:'launch_snapshot',generation:1,servers:[{name:'alpha',status:'disabled'},{name:'other',status:'unknown'}]});
  assert.equal(JSON.stringify(listed.body).includes('never-return'),false);
  assert.equal((await f.post('mcp-candidates',{path:'arbitrary'})).status,400);
  codex.state={...codex.state,connectionGeneration:2};assert.equal((await f.post('mcp-candidates')).status,503);
});

test('customer and read-only compositions do not gain this configuration surface',async t=>{
  const customer=await createModelWorkspaceFixture({profile:'model-workspace',required:true,codexClient:fakeCodex()});t.after(()=>customer.close());
  assert.equal((await customer.post('mcp-candidates')).status,401);
  const signed=await customer.post('account/sign-in',{email:'fixture@example.invalid',password:'fixture'});
  assert.equal((await customer.post('mcp-candidates',{},signed.cookie)).status,404);
  const readonly=await createModelWorkspaceFixture({profile:'model-readonly',required:false});t.after(()=>readonly.close());
  assert.equal((await readonly.post('mcp-candidates')).status,404);
});

test('an optional but configured account backend does not expose the host user configuration',async t=>{
  const auth=Object.fromEntries(['signIn','signUp','verifySession','refresh','signOut','release','close'].map(name=>[name,async()=>({ok:true,value:{closed:true}})]));
  const app=createPanelServer({root,codex:fakeCodex(),port:0,profile:'model-workspace',accountAuth:auth,requireAccount:false,invokeWorkbench:async()=>{throw new Error('not used');}});
  const {origin}=await app.listen();t.after(()=>app.close());
  const status=await (await fetch(origin+'/api/status')).json();assert.equal(status.mcpCandidatesAvailable,undefined);
  const response=await fetch(origin+'/api/mcp-candidates',{method:'POST',headers:{Origin:origin,'X-Local-Chat':status.csrf,'Content-Type':'application/json'},body:JSON.stringify({client:'fixture'})});
  assert.equal(response.status,404);
});
