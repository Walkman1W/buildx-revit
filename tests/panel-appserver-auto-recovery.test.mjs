import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createPanelServer} from '../lib/panel-server.mjs';
import {CodexClientCore} from '../lib/codex-client-core.mjs';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class FakeCodex extends EventEmitter {
  constructor(){super();this.profile={id:'model-workspace'};this.generation=0;this.starts=0;this.turns=[];this.state={ready:false,error:false,mode:'document-workbench',connectionStatus:'closed',connectionGeneration:0,cleanupPending:false};}
  async start(){this.starts++;this.generation++;this.state={...this.state,ready:true,error:false,message:'就绪',connectionGeneration:this.generation,connectionStatus:'ready'};this.emit('state',this.state);}
  failed(message){this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);}
  async close(){this.state={...this.state,ready:false,connectionStatus:'closed',cleanupPending:false};return {closed:true};}
  async newThread(){return 'thread-1';}
  async turn(threadId,text){this.turns.push({threadId,text});return {turn:{id:'turn-1'}};}
  async interrupt(){}
  exit({close=true}={}){
    const generation=this.generation;
    this.emit('diagnostic',{code:'codex_exit',generation,exitCode:1,signal:null});
    this.state={...this.state,ready:false,error:true,message:'连接中断',connectionStatus:'failed',cleanupPending:true};this.emit('state',this.state);
    if(close)this.closed(generation);
  }
  closed(generation=this.generation){this.state={...this.state,connectionStatus:'closed',cleanupPending:false};this.emit('diagnostic',{code:'codex_lifecycle',phase:'closed',reason:'codex_close_confirmed',generation});this.emit('state',this.state);}
}
async function setup(t){
  const codex=new FakeCodex();
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async()=>{throw new Error('unexpected workbench');}});
  const {origin}=await app.listen();await app.connect();
  const initial=await (await fetch(origin+'/api/status')).json();
  t.after(async()=>{await app.close();});
  async function post(route,value={}){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':initial.csrf,Origin:origin},body:JSON.stringify({client:'client-a',...value})});return {status:response.status,body:await response.json()};}
  return {app,codex,post};
}
test('unexpected child exit waits for same-generation close and never replays an unknown turn',async t=>{
  const f=await setup(t);assert.equal((await f.post('turn',{message:'只执行一次'})).status,202);
  await delay(10);assert.equal(f.codex.turns.length,1);
  f.codex.exit({close:false});await delay(400);assert.equal(f.codex.starts,1);
  f.codex.closed();await delay(500);assert.equal(f.codex.starts,2);assert.equal(f.codex.turns.length,1);
  const messages=f.app.snapshot('client-a').session.messages;
  assert.ok(messages.some(message=>message.status==='unknown'));
});
test('wrong-generation or unobserved close never starts another child',async t=>{
  const f=await setup(t);f.codex.closed();await delay(400);assert.equal(f.codex.starts,1);
  f.codex.exit({close:false});f.codex.closed(999);await delay(400);assert.equal(f.codex.starts,1);
});
test('unexpected recoveries are bounded and explicit reconnect resets the limit',async t=>{
  const f=await setup(t);
  for(let i=0;i<3;i++){f.codex.exit();await delay(450);assert.equal(f.codex.starts,i+2);}
  f.codex.exit();await delay(450);assert.equal(f.codex.starts,4);
  assert.equal((await f.post('reconnect')).status,202);await delay(50);assert.equal(f.codex.starts,5);
  f.codex.exit();await delay(450);assert.equal(f.codex.starts,6);
});
test('closing service while recovery is scheduled never starts another child',async t=>{
  const f=await setup(t);f.codex.exit();await f.app.close();await delay(400);assert.equal(f.codex.starts,1);
});
for(const when of ['before-close','after-close'])test('account invalidation '+when+' cancels automatic recovery for the old generation',async t=>{
  const f=await setup(t);f.codex.exit({close:when==='after-close'});
  f.codex.emit('account-invalidated',{connectionGeneration:f.codex.generation});
  if(when==='before-close')f.codex.closed();
  await delay(450);assert.equal(f.codex.starts,1);
});
test('account invalidation before child exit prevents recovery of that generation',async t=>{
  const f=await setup(t);
  f.codex.emit('account-invalidated',{connectionGeneration:f.codex.generation});
  f.codex.exit();await delay(450);assert.equal(f.codex.starts,1);
});
test('a failed automatic startup is not silently tried again',async t=>{
  const f=await setup(t);f.codex.start=async()=>{f.codex.starts++;f.codex.failed('fixture startup failed');throw new Error('fixture startup failed');};
  f.codex.exit();await delay(1200);assert.equal(f.codex.starts,2);assert.equal(f.codex.state.ready,false);
});
test('BuildX sign-out cancels a pending old-generation exit before close',async t=>{
  const facts={sessionId:'fixture-session-123456789',user:{id:'fixture-user',email:'fixture@example.invalid'},expiresAt:Date.now()+360000};
  const auth={signIn:async()=>({ok:true,value:facts}),signUp:async()=>({ok:true,value:facts}),verifySession:async()=>({ok:true,value:facts}),refresh:async()=>({ok:true,value:facts}),signOut:async()=>({ok:true,value:{remoteRevoked:true}}),release:()=>{},close:async()=>({ok:true,value:{closed:true}})};
  const codex=new FakeCodex(),app=createPanelServer({root,codex,port:0,accountAuth:auth,requireAccount:true,invokeWorkbench:async()=>{throw new Error('unexpected workbench');}});
  const {origin}=await app.listen();await app.connect();t.after(async()=>{await app.close();});
  const csrf=(await (await fetch(origin+'/api/status')).json()).csrf;
  async function post(route,value={},cookie){return fetch(origin+'/api/account/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf,Origin:origin,...cookie?{Cookie:cookie}:{}},body:JSON.stringify({client:'client-a',...value})});}
  const signed=await post('sign-in',{email:'fixture@example.invalid',password:'fixture'});assert.equal(signed.status,200);const cookie=signed.headers.get('set-cookie').split(';')[0];
  codex.exit({close:false});const signedOut=await post('sign-out',{},cookie);assert.equal(signedOut.status,200);
  codex.closed();await delay(450);assert.equal(codex.starts,1);
});
test('signed-in recovery requires a fresh explicit Codex confirmation',async t=>{
  const facts={sessionId:'fixture-session-123456789',user:{id:'fixture-user',email:'fixture@example.invalid'},expiresAt:Date.now()+360000};
  const auth={signIn:async()=>({ok:true,value:facts}),signUp:async()=>({ok:true,value:facts}),verifySession:async()=>({ok:true,value:facts}),refresh:async()=>({ok:true,value:facts}),signOut:async()=>({ok:true,value:{remoteRevoked:true}}),release:()=>{},close:async()=>({ok:true,value:{closed:true}})};
  class SignedCodex extends FakeCodex {
    async start(){this.starts++;this.generation++;this.sequence=1;this.state={...this.state,ready:true,error:false,message:'就绪',connectionGeneration:this.generation,connectionStatus:'ready',codexAccount:{status:'verified',type:'chatgpt',connectionGeneration:this.generation,accountRevision:0,observationSequence:this.sequence,observedAt:new Date().toISOString()}};this.emit('state',this.state);}
    async refreshAccount(){this.sequence++;this.state.codexAccount={...this.state.codexAccount,observationSequence:this.sequence,observedAt:new Date().toISOString()};return {...this.state.codexAccount,email:'codex@example.invalid',planType:'free'};}
  }
  const codex=new SignedCodex(),app=createPanelServer({root,codex,port:0,accountAuth:auth,requireAccount:true,invokeWorkbench:async()=>{throw new Error('unexpected workbench');}});
  const {origin}=await app.listen();await app.connect();t.after(async()=>{await app.close();});
  const csrf=(await (await fetch(origin+'/api/status')).json()).csrf;
  async function post(route,value={},cookie){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf,Origin:origin,...cookie?{Cookie:cookie}:{}},body:JSON.stringify({client:'client-a',...value})});return {response,body:await response.json()};}
  const signed=await post('account/sign-in',{email:'fixture@example.invalid',password:'fixture'});assert.equal(signed.response.status,200);const cookie=signed.response.headers.get('set-cookie').split(';')[0];
  const inspected=await post('codex-account/inspect',{},cookie);assert.equal(inspected.response.status,200);
  const confirmed=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie);assert.equal(confirmed.body.confirmation.localConnectionConfirmed,true);
  codex.exit();await delay(500);assert.equal(codex.starts,2);
  const status=await (await fetch(origin+'/api/status',{headers:{Cookie:cookie}})).json();assert.equal(status.codexConfirmation.localConnectionConfirmed,false);
  assert.equal((await post('turn',{message:'must not be sent'},cookie)).response.status,403);assert.equal(codex.turns.length,0);
});
test('an unconfirmed command receipt retains its owner and prevents automatic recovery',async t=>{
  let closed=0,starts=0;
  const owner=Object.freeze({inspect:()=>({ok:true,value:{status:'pending',canCheckAgain:true}}),close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=await createModelWorkspaceFixture({profile:'model-workspace',required:false,invokeReadonlyCommand:async()=>({ok:false,error:{code:'COMMAND_READ_UNCONFIRMED',message:'unknown',outcome:'unconfirmed'},receiptOwner:owner})});
  t.after(()=>f.close());await f.codex.start();const realStart=f.codex.start.bind(f.codex);f.codex.start=async()=>{starts++;return realStart();};
  const id=f.app.snapshot('model-test-client').session.conversation.id;
  const started=await f.post('command',{conversationId:id,commandId:'document',parameters:{}});assert.equal(started.status,202);
  for(let i=0;i<100&&f.app.snapshot('model-test-client').busy;i++)await delay(10);
  const before=f.app.snapshot('model-test-client').command;assert.equal(before.status,'unknown');assert.equal(before.canInspectReceipt,true);
  const generation=f.codex.state.connectionGeneration;f.codex.emit('diagnostic',{code:'codex_exit',generation,exitCode:1,signal:null});f.codex.failed('fixture connection interrupted');
  f.codex.state={...f.codex.state,connectionStatus:'closed',cleanupPending:false};f.codex.emit('diagnostic',{code:'codex_lifecycle',phase:'closed',reason:'codex_close_confirmed',generation});
  await delay(650);assert.equal(starts,0);assert.equal(closed,0);assert.equal(f.app.snapshot('model-test-client').command.executionId,before.executionId);assert.equal(f.app.snapshot('model-test-client').command.canInspectReceipt,true);
});
test('production Codex client close events drive one recovery without repeating a turn',async t=>{
  const children=[];let codex;
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.messages=[];
    child.stdin.write=(line,callback)=>{
      const message=JSON.parse(line);child.messages.push(message);if(callback)queueMicrotask(()=>callback());
      if(message.id!==undefined&&message.method){let result;
        if(message.method==='initialize')result={};
        else if(message.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture@example.invalid',planType:'free'}};
        else if(message.method==='thread/start')result={thread:{id:'thread-'+children.length}};
        else if(message.method==='mcpServerStatus/list'){const group=codex.profile.groups.find(value=>value.name===message.params.serverName)??codex.profile.groups[0];result={data:[{name:group.name,runtimeStatus:'connected',tools:Object.fromEntries(group.toolNames.map(name=>[name,{}]))}]};}
        else if(message.method==='turn/start')result={turn:{id:'turn-1'}};
        else result={ok:true};
        queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n')));
      }
      return true;
    };
    child.confirmClose=()=>{if(child.closed)return;child.closed=true;child.emit('exit',1,null);child.emit('close',1,null);};
    child.stdin.end=()=>queueMicrotask(()=>child.confirmClose());child.kill=()=>{queueMicrotask(()=>child.confirmClose());return true;};
    children.push(child);return child;
  };
  const toolNames=Object.freeze(['fixture_read']);
  const group=Object.freeze({name:'fixture',toolNames,statusTimeout:1000,failFast:true});
  const profile=Object.freeze({id:'model-workspace',service:'revit-local-codex',mode:'document-workbench',toolNames,groups:Object.freeze([group]),clientInfo:Object.freeze({name:'fixture',version:'1'}),buildLaunchArgs:()=>['app-server'],buildInstructions:()=>'fixture',connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',verifiedDiagnostic:'verified',denialMessage:'denied',verifyWholeCatalog:value=>({ok:value?.data?.[0]?.name==='fixture'})});
  codex=new CodexClientCore(root,profile,{spawn,resolveRuntimes:()=>({codex:'fixture',python:'fixture'}),readConfiguredNames:()=>[],closeTimeoutMs:10,killTimeoutMs:10});
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async()=>{throw new Error('unexpected workbench');}});
  const {origin}=await app.listen();t.after(async()=>{for(const child of children)child.confirmClose();await app.close();});await app.connect();assert.equal(codex.state.ready,true,codex.state.message+' '+JSON.stringify(children[0]?.messages.map(item=>item.method)));
  const csrf=(await (await fetch(origin+'/api/status')).json()).csrf;
  const response=await fetch(origin+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':csrf,Origin:origin},body:JSON.stringify({client:'client-a',message:'single request'})});
  assert.equal(response.status,202);await delay(20);assert.equal(children[0].messages.filter(m=>m.method==='turn/start').length,1);
  children[0].stdout.emit('end');children[0].emit('exit',1,null);await delay(400);assert.equal(children.length,1);
  children[0].closed=true;children[0].emit('close',1,null);await delay(800);assert.equal(children.length,2);assert.equal(codex.state.ready,true);
  assert.equal(children.flatMap(child=>child.messages).filter(m=>m.method==='turn/start').length,1);
  assert.ok(app.snapshot('client-a').session.messages.some(message=>message.status==='unknown'));
});
