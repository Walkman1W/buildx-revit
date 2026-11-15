import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClient} from '../lib/codex-client.mjs';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createBuildxAuth} from '../lib/buildx-auth.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const account=(email='fixture@example.invalid',planType='free')=>({requiresOpenaiAuth:true,account:{type:'chatgpt',email,planType}});
function fixture(options={}){
  const children=[],diagnostics=[],invalidated=[],notifications=[],states=[];let client;
  const settings={account:account(),...options};
  const spawn=()=>{
    const child=new EventEmitter();child.pid=101+children.length;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.messages=[];child.pending=[];child.reads=0;
    child.reply=(request,result)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
    child.reject=(request)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,error:{code:-32603,message:'PRIVATE response secret'}})+'\n'));
    child.notice=(method,params={})=>child.stdout.emit('data',Buffer.from(JSON.stringify({method,params})+'\n'));
    child.stdin.writable=true;child.stdin.write=(line,callback)=>{
      const request=JSON.parse(line);child.messages.push(request);if(callback)queueMicrotask(()=>callback());
      if(request.id!==undefined&&request.method){
        let result={};
        if(request.method==='account/read'){child.reads++;result=settings.account;}
        else if(request.method==='thread/start')result={thread:{id:'thread-'+children.length}};
        else if(request.method==='mcpServerStatus/list'){
          const group=client.profile.groups.find(group=>group.name===request.params.serverName);
          result={data:[{name:group.name,runtimeStatus:'connected',tools:Object.fromEntries(group.toolNames.map(name=>[name,{}]))}]};
        }else if(request.method==='turn/start')result={turn:{id:'turn-'+children.length}};
        if(settings.respond?.(request,child,result)===false)child.pending.push({request,result});
        else queueMicrotask(()=>child.reply(request,result));
      }
      return true;
    };
    child.confirmClose=()=>{if(child.closed)return;child.closed=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.stdin.end=()=>queueMicrotask(()=>child.confirmClose());child.kill=()=>{queueMicrotask(()=>child.confirmClose());return true;};children.push(child);return child;
  };
  client=new CodexClient(process.cwd(),{},{spawn,resolveRuntimes:()=>({codex:'fixture-codex',python:'fixture-python'}),readConfiguredNames:()=>['revit_local'],closeTimeoutMs:5,killTimeoutMs:5});
  client.on('diagnostic',value=>diagnostics.push(value));client.on('account-invalidated',value=>invalidated.push(value));client.on('notification',(...value)=>notifications.push(value));client.on('state',value=>states.push(value));
  return {client,settings,children,diagnostics,invalidated,notifications,states,get child(){return children.at(-1);}};
}
async function ready(t,options={}){const f=fixture(options);t.after(async()=>{for(const child of f.children)child.confirmClose();await f.client.close();});await f.client.start();assert.equal(f.client.state.ready,true);return f;}
const count=(f,method)=>f.child.messages.filter(message=>message.method===method).length;

const fixtureModel=(model,extra={})=>({id:'id-'+model,model,displayName:'Model '+model,description:'Fixture',hidden:false,isDefault:false,...extra});
test('steering binds the expected native turn and validates its acknowledgement',async t=>{
  const f=await ready(t),id='12345678-1234-4123-8123-123456789abc';
  f.settings.respond=(request,child)=>{if(request.method!=='turn/steer')return true;queueMicrotask(()=>child.reply(request,{turnId:'turn-1'}));return false;};
  assert.deepEqual(await f.client.steer('thread-1','turn-1','修正方向',id),{turnId:'turn-1'});
  const sent=f.child.messages.find(message=>message.method==='turn/steer');
  assert.deepEqual(sent.params,{threadId:'thread-1',expectedTurnId:'turn-1',clientUserMessageId:id,input:[{type:'text',text:'修正方向'}]});
  await assert.rejects(f.client.steer('thread-1','turn-1','x','bad'),{code:'CODEX_STEER_INVALID',notSent:true});
  f.settings.respond=(request,child)=>{if(request.method!=='turn/steer')return true;queueMicrotask(()=>child.reply(request,{turnId:'other'}));return false;};
  await assert.rejects(f.client.steer('thread-1','turn-1','x',id),{code:'CODEX_STEER_UNCONFIRMED'});
  f.child.notice('account/updated');await assert.rejects(f.client.steer('thread-1','turn-1','x',id),{code:'CODEX_ACCOUNT_NOT_READY',notSent:true});
});
test('model selection uses the complete visible catalog bound to this account and connection',async t=>{
  const f=await ready(t);f.settings.respond=(request,child)=>{
    if(request.method!=='model/list')return true;
    const result=request.params.cursor?{data:[fixtureModel('second')],nextCursor:null}:{data:[fixtureModel('first',{isDefault:true}),fixtureModel('hidden',{hidden:true})],nextCursor:'next'};
    queueMicrotask(()=>child.reply(request,result));return false;
  };
  await assert.rejects(f.client.turn('thread','hello',[],'first'),{code:'CODEX_MODEL_SELECTION_INVALID'});
  const models=await f.client.listModels();assert.deepEqual(models.map(item=>item.model),['first','second']);
  assert.deepEqual(f.child.messages.filter(item=>item.method==='model/list').map(item=>item.params),[{limit:100,includeHidden:false},{limit:100,includeHidden:false,cursor:'next'}]);
  await assert.rejects(f.client.turn('thread','hello',[],'hidden'),{code:'CODEX_MODEL_SELECTION_INVALID'});
  await f.client.turn('thread','hello',[],'second');assert.equal(f.child.messages.at(-1).params.model,'second');
  await f.client.turn('thread','hello');assert.equal(Object.hasOwn(f.child.messages.at(-1).params,'model'),false);
  f.child.notice('account/updated');await assert.rejects(f.client.turn('thread','hello',[],'second'),{code:'CODEX_ACCOUNT_NOT_READY'});
});

test('invalid or superseded model catalogs cannot authorize a selection',async t=>{
  const f=await ready(t);let mode='bad';f.settings.respond=(request,child)=>{
    if(request.method!=='model/list')return true;
    if(mode==='hold')return false;
    queueMicrotask(()=>child.reply(request,mode==='bad'?{data:[fixtureModel('x'),fixtureModel('x')],nextCursor:null}:{data:[fixtureModel('fresh')],nextCursor:null}));return false;
  };
  await assert.rejects(f.client.listModels(),{code:'CODEX_MODEL_LIST_INVALID'});await assert.rejects(f.client.turn('t','hello',[],'x'),{code:'CODEX_MODEL_SELECTION_INVALID'});
  mode='hold';const stale=f.client.listModels();const rejection=assert.rejects(stale,{code:'CODEX_MODEL_LIST_SUPERSEDED'});await tick();const held=f.child.pending.at(-1);
  mode='valid';await f.client.listModels();f.child.reply(held.request,{data:[fixtureModel('stale')],nextCursor:null});await rejection;
  await assert.rejects(f.client.turn('t','hello',[],'stale'),{code:'CODEX_MODEL_SELECTION_INVALID'});await f.client.turn('t','hello',[],'fresh');
});

test('late model list cannot survive an account invalidation',async t=>{
  const f=await ready(t);f.settings.respond=request=>request.method!=='model/list';
  const pending=f.client.listModels(),rejection=assert.rejects(pending,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});await tick();const held=f.child.pending.at(-1);
  f.child.notice('account/updated');f.child.reply(held.request,{data:[fixtureModel('stale')],nextCursor:null});await rejection;
});

test('model image support follows the current catalog and legacy missing modalities default',async t=>{
  const f=await ready(t);f.settings.respond=(request,child)=>{
    if(request.method!=='model/list')return true;
    queueMicrotask(()=>child.reply(request,{data:[fixtureModel('text-only',{inputModalities:['text']}),fixtureModel('legacy'),fixtureModel('vision',{inputModalities:['text','image']})],nextCursor:null}));return false;
  };
  const models=await f.client.listModels();
  assert.deepEqual(models.map(item=>item.inputModalities),[['text'],['text','image'],['text','image']]);
  models[0].inputModalities.push('image'); // A display projection cannot expand the retained capability.
  assert.throws(()=>f.client.assertModelSelection('text-only',{requiresImages:true}),{code:'CODEX_MODEL_IMAGE_UNSUPPORTED',notSent:true});
  assert.doesNotThrow(()=>f.client.assertModelSelection('text-only'));
  assert.doesNotThrow(()=>f.client.assertModelSelection('legacy',{requiresImages:true}));
  assert.doesNotThrow(()=>f.client.assertModelSelection('vision',{requiresImages:true}));
  f.child.notice('account/updated');assert.throws(()=>f.client.assertModelSelection('vision',{requiresImages:true}),{code:'CODEX_ACCOUNT_NOT_READY'});
});

test('reasoning effort is selected only from the current model catalog and never inferred for legacy models',async t=>{
  const f=await ready(t);f.settings.respond=(request,child)=>{
    if(request.method!=='model/list')return true;
    const options=[{reasoningEffort:'low',description:'quick'},{reasoningEffort:'high',description:'deep'}];
    queueMicrotask(()=>child.reply(request,{data:[fixtureModel('reasoning',{supportedReasoningEfforts:options,defaultReasoningEffort:'low'}),fixtureModel('legacy')],nextCursor:null}));return false;
  };
  const models=await f.client.listModels();
  assert.equal(models[0].defaultReasoningEffort,'low');assert.deepEqual(models[0].supportedReasoningEfforts.map(option=>option.reasoningEffort),['low','high']);
  assert.equal(models[1].defaultReasoningEffort,null);assert.deepEqual(models[1].supportedReasoningEfforts,[]);
  models[0].supportedReasoningEfforts.push({reasoningEffort:'invented',description:''});
  await assert.rejects(f.client.turn('thread','hello',[],'reasoning','invented'),{code:'CODEX_EFFORT_SELECTION_INVALID',notSent:true});
  await assert.rejects(f.client.turn('thread','hello',[],'legacy','low'),{code:'CODEX_EFFORT_SELECTION_INVALID',notSent:true});
  await assert.rejects(f.client.turn('thread','hello',[],undefined,'low'),{code:'CODEX_EFFORT_SELECTION_INVALID',notSent:true});
  await f.client.turn('thread','hello',[],'reasoning','high');assert.equal(f.child.messages.at(-1).params.effort,'high');
  await f.client.turn('thread','hello',[],'reasoning');assert.equal(Object.hasOwn(f.child.messages.at(-1).params,'effort'),false);
  f.child.notice('account/updated');await assert.rejects(f.client.turn('thread','hello',[],'reasoning','high'),{code:'CODEX_ACCOUNT_NOT_READY'});
});

test('missing or inconsistent defaults remain unknown and malformed effort options fail closed',async t=>{
  const f=await ready(t);let metadata={supportedReasoningEfforts:[{reasoningEffort:'high',description:''}],defaultReasoningEffort:'missing'};
  f.settings.respond=(request,child)=>{if(request.method!=='model/list')return true;queueMicrotask(()=>child.reply(request,{data:[fixtureModel('x',metadata)],nextCursor:null}));return false;};
  const models=await f.client.listModels();assert.equal(models[0].defaultReasoningEffort,null);
  await assert.rejects(f.client.turn('thread','hello',[],'x','missing'),{code:'CODEX_EFFORT_SELECTION_INVALID',notSent:true});
  metadata={supportedReasoningEfforts:[{reasoningEffort:'high',description:''}],defaultReasoningEffort:null};
  assert.equal((await f.client.listModels())[0].defaultReasoningEffort,null);
  metadata={supportedReasoningEfforts:[{reasoningEffort:'high',description:''},{reasoningEffort:'high',description:''}],defaultReasoningEffort:'high'};
  await assert.rejects(f.client.listModels(),{code:'CODEX_MODEL_LIST_INVALID'});
  await assert.rejects(f.client.turn('thread','hello',[],'x','high'),{code:'CODEX_MODEL_SELECTION_INVALID',notSent:true});
});

test('startup uses schema-supported visible facts; public state and diagnostics retain no email, plan, or credentials',async t=>{
  const source={...account(),token:'PRIVATE credential',accountId:'NOT_A_STABLE_ID',workspaceId:'NOT_A_WORKSPACE'};
  const f=await ready(t,{account:source});
  const state=f.client.state.codexAccount;
  assert.deepEqual(Object.keys(state).sort(),['status','connectionGeneration','accountRevision','observationSequence','observedAt','stableAccountId','workspaceId'].sort());
  assert.equal(state.status,'verified');assert.equal(state.observationSequence,1);assert.equal(state.accountRevision,0);assert.equal(state.stableAccountId,null);assert.equal(state.workspaceId,null);assert.match(state.observedAt,/^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.stringify([f.states,f.diagnostics]).includes('fixture@example.invalid'),false);assert.equal(JSON.stringify([f.states,f.diagnostics]).includes('PRIVATE'),false);assert.equal('email' in state,false);assert.equal('planType' in state,false);
});

test('fresh account inspection is single-flight, suspends ready, preserves prepared catalog and returns only current whitelist',async t=>{
  const f=await ready(t),prepared=f.client.preparedThread,before=count(f,'thread/start');
  f.settings.respond=request=>request.method!=='account/read';
  const first=f.client.refreshAccount(),second=f.client.refreshAccount();assert.equal(first,second);assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.status,'checking');
  await assert.rejects(f.client.turn('t','must not send'),{code:'CODEX_ACCOUNT_NOT_READY'});await tick();assert.equal(f.child.reads,2);
  const held=f.child.pending.at(-1);f.child.reply(held.request,{...held.result,unknown:'PRIVATE token'});
  const observed=await first;
  assert.deepEqual(Object.keys(observed).sort(),['connectionGeneration','accountRevision','observationSequence','observedAt','type','email','planType','stableAccountId','workspaceId'].sort());
  assert.equal(observed.email,'fixture@example.invalid');assert.equal(observed.planType,'free');assert.equal(observed.type,'chatgpt');assert.equal(observed.observationSequence,2);assert.equal(observed.accountRevision,0);assert.equal(observed.stableAccountId,null);assert.equal(observed.workspaceId,null);
  assert.equal(f.client.state.ready,true);assert.equal(f.client.toolsReady,true);assert.equal(f.client.preparedThread,prepared);assert.equal(count(f,'thread/start'),before);assert.equal(count(f,'turn/start'),0);
  assert.deepEqual(f.child.messages.filter(message=>message.method==='account/read').map(message=>message.params),[{refreshToken:false},{refreshToken:false}]);
  observed.email='mutable response';assert.equal((await (async()=>{f.settings.respond=undefined;return f.client.refreshAccount();})()).email,'fixture@example.invalid');
});

test('reentrant state listener sees the same initialized single-flight promise',async t=>{
  const f=await ready(t);let reentrant;
  f.client.on('state',state=>{if(state.codexAccount.status==='checking'&&!reentrant)reentrant=f.client.refreshAccount();});
  const first=f.client.refreshAccount();assert.equal(first,reentrant);await first;assert.equal(f.child.reads,2);
});

for(const method of ['account/updated','account/login/completed']){
  test(method+' is only an invalidation hint and never authenticates, reads, rebuilds, or forwards PII',async t=>{
    const f=await ready(t),before=f.child.messages.length;
    f.child.notice(method,{authMode:'chatgpt',planType:'pro',success:true,email:'PRIVATE@example.invalid',loginId:'PRIVATE login id',error:'PRIVATE text'});
    assert.equal(f.client.state.ready,false);assert.equal(f.client.authReady,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);assert.equal(f.client.state.codexAccount.status,'invalidated');assert.equal(f.client.state.codexAccount.accountRevision,1);
    assert.deepEqual(f.invalidated,[{connectionGeneration:1,accountRevision:1,reason:method==='account/updated'?'account_updated':'account_login_completed'}]);assert.equal(f.notifications.length,0);
    await assert.rejects(f.client.turn('t','do not replay'),{code:'CODEX_ACCOUNT_NOT_READY'});await assert.rejects(f.client.refreshAccount(),{code:'CODEX_ACCOUNT_NOT_READY'});await assert.rejects(f.client.prepareThread(),{code:'CODEX_ACCOUNT_NOT_READY'});
    assert.equal(f.child.messages.length,before);assert.equal(JSON.stringify([f.states,f.diagnostics,f.invalidated]).includes('PRIVATE'),false);
    await f.client.interrupt('old-thread','old-turn');assert.equal(f.child.messages.at(-1).method,'turn/interrupt');assert.equal(f.client.state.ready,false);
  });
}

test('late successful read after account notification cannot restore catalog or publish a new observation',async t=>{
  const f=await ready(t);f.settings.respond=request=>request.method!=='account/read';
  const promise=f.client.refreshAccount(),rejected=assert.rejects(promise,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});await tick();const held=f.child.pending.at(-1);
  f.child.notice('account/updated',{authMode:'chatgpt'});f.child.reply(held.request,held.result);await rejected;
  assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.accountRevision,1);assert.equal(f.client.state.codexAccount.observationSequence,1);assert.equal(f.client.preparedThread,null);assert.equal(f.child.reads,2);
});

test('notification after response within the same input chunk invalidates the await continuation',async t=>{
  const f=await ready(t);f.settings.respond=request=>request.method!=='account/read';const promise=f.client.refreshAccount(),rejected=assert.rejects(promise,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});await tick();const held=f.child.pending.at(-1);
  f.child.stdout.emit('data',Buffer.from(JSON.stringify({id:held.request.id,result:held.result})+'\n'+JSON.stringify({method:'account/login/completed',params:{success:true}})+'\n'));await rejected;
  assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.observationSequence,1);
});

test('account invalidation before the refresh microtask rejects before account/read is enqueued',async t=>{
  const f=await ready(t),before=f.child.reads;const promise=f.client.refreshAccount(),rejected=assert.rejects(promise,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});
  f.child.notice('account/updated',{});await rejected;assert.equal(f.child.reads,before);assert.equal(f.client.state.ready,false);
});

test('public failure after account response but before its continuation cannot restore account or prepare tools',async t=>{
  let client;
  const f=fixture({respond(request,child,result){if(request.method==='account/read'){queueMicrotask(()=>{child.reply(request,result);client.failed('固定连接失败');});return false;}}});client=f.client;t.after(()=>f.client.close());
  let outcome='resolved';try{await f.client.start();}catch{outcome='rejected';}
  assert.deepEqual({outcome,ready:f.client.state.ready,authReady:f.client.authReady,toolsReady:f.client.toolsReady,preparedThread:f.client.preparedThread,threads:count(f,'thread/start')},
    {outcome:'rejected',ready:false,authReady:false,toolsReady:false,preparedThread:null,threads:0});
});

for(const [name,replacement] of [['email',account('other@example.invalid')],['plan',account('fixture@example.invalid','pro')],['provider',{requiresOpenaiAuth:true,account:{type:'apiKey'}}]]){
  test('fresh '+name+' difference revokes confirmation without claiming a stable user switch',async t=>{
    const f=await ready(t);f.settings.account=replacement;const before=count(f,'thread/start');
    await assert.rejects(f.client.refreshAccount(),{code:'CODEX_ACCOUNT_CHANGED'});
    assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.accountRevision,1);assert.equal(f.client.state.codexAccount.observationSequence,1);assert.equal(f.invalidated.at(-1).reason,'account_observation_changed');assert.equal(count(f,'thread/start'),before);
    assert.equal(f.client.state.codexAccount.stableAccountId,null);assert.equal(f.client.state.codexAccount.workspaceId,null);
  });
}

for(const [name,replacement] of [['missing auth flag',{account:{type:'chatgpt',email:null,planType:'free'}}],['missing email',{requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'free'}}],['missing plan',{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null}}],['unknown plan',account(null,'future-unverified-plan')],['missing account',{requiresOpenaiAuth:true}],['null account',{requiresOpenaiAuth:true,account:null}]]){
  test('malformed '+name+' leaves account unknown or invalidated and cannot reuse catalog',async t=>{
    const f=await ready(t);f.settings.account=replacement;
    await assert.rejects(f.client.refreshAccount(),{code:'CODEX_ACCOUNT_INVALID'});assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.accountRevision,1);assert.equal(f.invalidated.at(-1).reason,'account_read_failed');assert.equal(f.client.child,f.child);assert.equal(f.client.state.cleanupPending,false);
  });
}

test('current RPC failure revokes readiness once, discards private error detail, and does not retry',async t=>{
  const f=await ready(t);f.settings.respond=(request,child)=>{if(request.method==='account/read'){queueMicrotask(()=>child.reject(request));return false;}};
  await assert.rejects(f.client.refreshAccount(),error=>error.code==='CODEX_ACCOUNT_READ_FAILED'&&!error.message.includes('PRIVATE'));
  assert.equal(f.invalidated.length,1);assert.equal(f.client.state.ready,false);await tick();assert.equal(f.child.reads,2);assert.equal(f.client.pending.size,0);assert.equal(JSON.stringify(f.states).includes('PRIVATE'),false);
});

test('closing immediately after refresh does not send a delayed account request into a closed connection',async t=>{
  const f=await ready(t),before=f.child.reads;const pending=f.client.refreshAccount(),rejected=assert.rejects(pending,{code:'CODEX_CONNECTION_CHANGED'});
  await f.client.close();await rejected;assert.equal(f.child.reads,before);assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.status,'unknown');assert.equal(f.client.pending.size,0);
});

for(const replacement of [{requiresOpenaiAuth:true,account:{type:'apiKey'}},{requiresOpenaiAuth:false,account:{type:'gcp'}},{requiresOpenaiAuth:true,account:{type:'amazonBedrock'}}]){
  test('startup does not authenticate unsupported provider '+replacement.account.type,async t=>{
    const f=fixture({account:replacement});t.after(()=>f.client.close());
    await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_UNSUPPORTED'});assert.equal(f.client.state.ready,false);assert.equal(f.client.authReady,false);assert.equal(f.client.state.codexAccount.status,'invalidated');assert.equal(count(f,'thread/start'),0);assert.equal(f.invalidated.length,1);
  });
}

test('startup RPC account failure revokes account facts without exposing its private error or replaying',async t=>{
  const f=fixture({respond(request,child){if(request.method==='account/read'){queueMicrotask(()=>child.reject(request));return false;}}});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_READ_FAILED'});assert.equal(f.client.state.ready,false);assert.equal(f.client.state.codexAccount.status,'invalidated');assert.equal(f.invalidated.length,1);assert.equal(count(f,'account/read'),1);assert.equal(count(f,'thread/start'),0);assert.equal(JSON.stringify([f.states,f.invalidated,f.diagnostics]).includes('PRIVATE'),false);
});

test('null email and schema unknown plan are valid visible observations but no stable identity',async t=>{
  const f=await ready(t,{account:account(null,'unknown')});const result=await f.client.refreshAccount();assert.equal(result.email,null);assert.equal(result.planType,'unknown');assert.equal(result.stableAccountId,null);assert.equal(result.workspaceId,null);
});

test('bootstrap account notification after initialize is followed by a fresh account read before readiness',async t=>{
  const f=fixture({respond(request,child,result){if(request.method==='initialize'){queueMicrotask(()=>{child.reply(request,result);child.notice('account/updated',{authMode:'chatgpt'});});return false;}}});
  t.after(()=>f.client.close());await f.client.start();
  assert.equal(count(f,'account/read'),1);assert.equal(f.client.state.ready,true);assert.equal(f.client.state.codexAccount.accountRevision,1);assert.equal(count(f,'turn/start'),0);
});

test('bootstrap single account notification during read discards that response and verifies the newer revision once',async t=>{
  const f=fixture({respond(request,child,result){if(request.method==='account/read'&&child.reads===1){queueMicrotask(()=>{child.reply(request,result);f.settings.account=account('fresh-fixture@example.invalid');child.notice('account/updated',{authMode:'chatgpt'});});return false;}}});
  t.after(()=>f.client.close());await f.client.start();
  assert.equal(count(f,'account/read'),2);assert.equal(f.client.state.ready,true);assert.equal(f.client.state.codexAccount.accountRevision,1);
  assert.equal(f.client._accountObservation.email,'fresh-fixture@example.invalid');assert.equal(count(f,'turn/start'),0);
});

for(const phase of ['initialize','account/read'])test('bootstrap one-shot public failure at '+phase+' cannot be recovered by a fresh account read',async t=>{
  const f=fixture({respond(request,child,result){if(request.method===phase&&(phase!=='account/read'||child.reads===1)){queueMicrotask(()=>{child.reply(request,result);f.client.failed('固定启动失败');});return false;}}});
  t.after(()=>f.client.close());let outcome='resolved';try{await f.client.start();}catch{outcome='rejected';}
  assert.deepEqual({outcome,ready:f.client.state.ready,authReady:f.client.authReady,toolsReady:f.client.toolsReady,preparedThread:f.client.preparedThread,threads:count(f,'thread/start')},
    {outcome:'rejected',ready:false,authReady:false,toolsReady:false,preparedThread:null,threads:0});
});

for(const phase of ['account/read','thread/start','mcpServerStatus/list']){
  test('account invalidation between '+phase+' response and continuation blocks startup publication',async t=>{
    const f=fixture({respond(request,child,result){if(request.method===phase){queueMicrotask(()=>{child.reply(request,result);child.notice('account/updated',{authMode:'chatgpt'});});return false;}}});
    t.after(()=>f.client.close());await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_REVISION_CHANGED'});
    const invalidations=phase==='account/read'?2:1;
    assert.equal(f.client.state.ready,false);assert.equal(f.client.authReady,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);assert.equal(f.client.state.codexAccount.accountRevision,invalidations);assert.equal(f.invalidated.length,invalidations);
    if(phase==='account/read')assert.equal(count(f,'account/read'),2);if(phase==='thread/start')assert.equal(count(f,'mcpServerStatus/list'),0);
  });
}

test('account invalidation during catalog backoff prevents the next query and does not replay preparation',async t=>{
  const f=fixture({respond(request,child,result){if(request.method==='mcpServerStatus/list')result.data[0].runtimeStatus='connecting';}});t.after(()=>f.client.close());
  const started=f.client.start(),rejected=assert.rejects(started,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});await tick();assert.equal(f.client._connection.delays.size,1);
  const before=count(f,'mcpServerStatus/list');f.child.notice('account/updated',{});await rejected;assert.equal(count(f,'mcpServerStatus/list'),before);assert.equal(f.client.state.ready,false);
  assert.equal(f.client._connection.delays.size,0);
});

test('late old generation read and notifications cannot change a newly connected account',async t=>{
  const f=await ready(t);f.settings.respond=request=>request.method!=='account/read';const pending=f.client.refreshAccount(),rejected=assert.rejects(pending);await tick();const old=f.child,held=old.pending.at(-1);
  await f.client.close();await rejected;f.settings.respond=undefined;f.settings.account=account('new@example.invalid','pro');await f.client.start();const before=f.client.state.codexAccount;
  old.reply(held.request,account('old@example.invalid'));old.notice('account/updated',{});old.notice('account/login/completed',{success:true});await tick();assert.deepEqual(f.client.state.codexAccount,before);assert.equal(f.client.state.ready,true);assert.equal(f.children.length,2);
  const observed=await f.client.refreshAccount();assert.equal(observed.email,'new@example.invalid');assert.equal(observed.connectionGeneration,2);
});

test('manual readiness flags cannot authorize turn/start without a verified production account observation',async t=>{
  const f=fixture();t.after(()=>f.client.close());const started=f.client.start();await started;f.child.notice('account/updated',{});f.client.initialized=f.client.authReady=f.client.toolsReady=true;
  await assert.rejects(f.client.turn('t','no account proof'),{code:'CODEX_ACCOUNT_NOT_READY'});assert.equal(count(f,'turn/start'),0);
});

test('production account notification through HTTP revokes explicit confirmation and retires thread/context without private status leakage',async t=>{
  const codexEmail='codex-visible@example.invalid',contextTitle='old-context-sentinel',clientId='producer-consumer-client';
  const f=fixture({account:account(codexEmail,'pro')}),user={id:'11111111-1111-1111-1111-111111111111',email:'buildx-fixture@example.invalid'};
  let workbenchCalls=0;
  const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',fetchImpl:async url=>{
    if(url.includes('/token?grant_type=password'))return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600});
    if(url.endsWith('/user'))return Response.json(user);
    throw new Error('Unexpected isolated auth fixture route');
  }});
  const app=createPanelServer({root:process.cwd(),codex:f.client,port:0,accountAuth:auth,requireAccount:true,invokeWorkbench:async method=>{
    workbenchCalls++;assert.equal(method,'revit_workbench_status');return {hostSession:'isolated-fixture-host',document:{title:contextTitle,path:'D:\\isolated-fixture\\sample.rvt',activeViewId:'12'}};
  }});
  t.after(()=>app.close());const {origin}=await app.listen();await app.connect();
  const publicStatus=await(await fetch(origin+'/api/status')).json();
  async function post(route,input={},cookie){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':publicStatus.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:clientId,...input})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function status(cookie){const value=await(await fetch(origin+'/api/status',{headers:{Cookie:cookie}})).json();assert.equal(JSON.stringify(value).includes(codexEmail),false);assert.equal(JSON.stringify(value).includes('planType'),false);assert.equal(JSON.stringify(value).includes('challengeId'),false);return value;}
  async function confirm(cookie){const inspected=await post('codex-account/inspect',{},cookie);assert.equal(inspected.status,200);assert.equal(inspected.body.display.email,codexEmail);assert.equal(inspected.body.display.planType,'pro');const result=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie);assert.equal(result.status,200);assert.equal(result.body.confirmation.localConnectionConfirmed,true);return inspected.body.challengeId;}
  const signed=await post('account/sign-in',{email:user.email,password:'fixture-password'});assert.equal(signed.status,200);assert.ok(signed.cookie);
  const challengeId=await confirm(signed.cookie);assert.equal((await status(signed.cookie)).ready,true);
  const turn=await post('turn',{message:'old-private-task',context:{includeDocument:true}},signed.cookie);assert.equal(turn.status,202);assert.equal(workbenchCalls,2);
  const oldChild=f.child,oldTurn=oldChild.messages.find(message=>message.method==='turn/start');assert.ok(oldTurn);assert.ok(oldTurn.params.input[0].text.includes(contextTitle));
  assert.equal(app.snapshot(clientId).session.context.document.title,contextTitle);
  oldChild.notice('account/updated',{authMode:'chatgpt',planType:'pro'});
  const immediate=app.snapshot(clientId);assert.equal(immediate.state.ready,false);assert.equal(immediate.state.codexConfirmation.localConnectionConfirmed,false);assert.equal(immediate.session.context.document,null);assert.equal(immediate.session.messages.length,0);
  const invalid=await status(signed.cookie);assert.equal(invalid.ready,false);assert.equal(invalid.codexConfirmation.localConnectionConfirmed,false);
  assert.equal(JSON.stringify(invalid).includes(codexEmail),false);assert.equal(JSON.stringify(invalid).includes('planType'),false);assert.equal(JSON.stringify(invalid).includes('challengeId'),false);assert.equal(JSON.stringify(invalid).includes(challengeId),false);
  oldChild.notice('item/agentMessage/delta',{threadId:oldTurn.params.threadId,turnId:'turn-1',itemId:'old-agent',delta:'late-private-answer'});
  oldChild.notice('turn/completed',{threadId:oldTurn.params.threadId,turn:{id:'turn-1',status:'completed'}});
  await tick();assert.equal((await status(signed.cookie)).ready,false);assert.equal(app.snapshot(clientId).session.context.document,null);assert.equal(app.snapshot(clientId).session.messages.length,0);
  assert.equal((await post('turn',{message:'must stay blocked'},signed.cookie)).status,403);assert.equal((await post('context',{includeDocument:true},signed.cookie)).status,403);assert.equal(count(f,'turn/start'),1);assert.equal(workbenchCalls,2);
  assert.equal((await post('codex-account/confirm',{challengeId},signed.cookie)).status,503);
  assert.equal((await post('reconnect',{},signed.cookie)).status,202);
  for(let attempt=0;attempt<100&&!f.client.state.ready;attempt++)await tick();assert.equal(f.client.state.ready,true);assert.equal(f.client.state.connectionGeneration,2);
  assert.equal((await status(signed.cookie)).codexConfirmation.localConnectionConfirmed,false);await confirm(signed.cookie);
  const replacement=await post('turn',{message:'fresh-task-without-context'},signed.cookie);assert.equal(replacement.status,202);
  const newTurn=f.child.messages.find(message=>message.method==='turn/start');assert.ok(newTurn);assert.notEqual(newTurn.params.threadId,oldTurn.params.threadId);assert.equal(newTurn.params.input[0].text,'fresh-task-without-context');assert.equal(workbenchCalls,2);
  oldChild.notice('account/updated',{authMode:'chatgpt',planType:'pro'});oldChild.notice('turn/completed',{threadId:oldTurn.params.threadId,turn:{id:'turn-1',status:'completed'}});await tick();
  assert.equal((await status(signed.cookie)).ready,true);assert.equal(app.snapshot(clientId).session.context.document,null);assert.equal(JSON.stringify(app.snapshot(clientId)).includes(contextTitle),false);
  f.child.notice('turn/completed',{threadId:newTurn.params.threadId,turn:{id:'turn-2',status:'completed'}});assert.equal(app.snapshot(clientId).busy,false);
});
