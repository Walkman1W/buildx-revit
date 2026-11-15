import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClientCore} from '../lib/codex-client-core.mjs';

function profile(enabled=true){
  const toolNames=Object.freeze(['fixture_read']),group=Object.freeze({name:'fixture_group',toolNames,statusTimeout:1000,failFast:true});
  const schema=Object.freeze({type:'object',properties:Object.freeze({value:Object.freeze({type:'string'})}),additionalProperties:false});
  const dynamicTools=Object.freeze([Object.freeze({type:'function',name:'buildx_test',description:'Isolated test only',inputSchema:schema})]);
  return Object.freeze({id:'fixture',service:'fixture-codex',mode:'fixture',toolNames,groups:Object.freeze([group]),
    clientInfo:Object.freeze({name:'fixture',version:'1'}),buildLaunchArgs:()=>[],buildInstructions:()=>'fixture',
    connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',verifiedDiagnostic:'verified',denialMessage:'denied',...(enabled?{dynamicTools}:{})});
}
function fixture(enabled=true){
  const trusted=profile(enabled),messages=[];let early=false;
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;
    child.stdin.write=(line,callback)=>{const request=JSON.parse(line);messages.push(request);queueMicrotask(()=>{
      callback?.();if(!request.method||request.id===undefined)return;
      if(request.method==='turn/start'&&early)child.stdout.emit('data',Buffer.from(JSON.stringify({id:600,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'early',tool:'buildx_test',arguments:{value:'early'}}})+'\n'));
      const result=request.method==='turn/start'?{turn:{id:'turn'}}:request.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}}:
        request.method==='thread/start'?{thread:{id:'thread'}}:request.method==='mcpServerStatus/list'?{data:[{name:'fixture_group',runtimeStatus:'connected',tools:{fixture_read:{}}}]}:{};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
    });return true;};
    child.stdin.end=()=>queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});child.kill=()=>true;return child;
  };
  const client=new CodexClientCore(process.cwd(),trusted,{spawn,resolveRuntimes:()=>({codex:'fake',python:'fake'}),readConfiguredNames:()=>[],closeTimeoutMs:20,killTimeoutMs:20});
  const call=(id=55,params={})=>client.dispatch({id,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call',tool:'buildx_test',arguments:{value:'one'},...params}});
  return {client,messages,call,enableEarly:()=>{early=true;}};
}
const response={contentItems:[{type:'inputText',text:'test result'}],success:true};

test('dynamic protocol is disabled by default and existing requests are rejected',async t=>{
  const f=fixture(false);t.after(()=>f.client.close());await f.client.start();f.call();
  assert.equal(f.messages.find(x=>x.method==='thread/start').params.dynamicTools,undefined);
  assert.equal(f.messages.at(-1).error.code,-32601);
});
test('trusted experimental profile without request owner fails closed before thread creation',async t=>{
  const f=fixture();t.after(()=>f.client.close());await assert.rejects(f.client.start(),/trusted request owner/);
  assert.equal(f.messages.some(x=>x.method==='thread/start'),false);
});
test('registered calls are immutable, bounded, scoped, and produce at most one response',async t=>{
  const f=fixture();t.after(()=>f.client.close());let observed;f.client.on('dynamic-tool-request',value=>{observed=value;});await f.client.start();
  assert.equal(f.messages.find(x=>x.method==='initialize').params.capabilities.experimentalApi,true);
  assert.deepEqual(f.messages.find(x=>x.method==='thread/start').params.dynamicTools,f.client.profile.dynamicTools);
  const args={value:'one',nested:{x:'original'}};f.call(55,{arguments:args});args.nested.x='changed';
  assert.equal(observed.params.arguments.nested.x,'original');assert.ok(Object.isFrozen(observed.params.arguments.nested));
  assert.equal(observed.params.threadId,'thread');assert.equal(observed.params.turnId,'turn');assert.equal(observed.params.callId,'call');
  assert.equal(observed.respond({contentItems:[],success:'yes'}),false);assert.equal(observed.respond(response),true);assert.equal(observed.respond(response),false);
  assert.deepEqual(f.messages.at(-1),{id:55,result:response});f.call(56);assert.equal(f.messages.at(-1).error.code,-32600);
});
test('unknown tools, foreign thread, oversized arguments, duplicate pending and account changes reject or revoke',async t=>{
  const f=fixture();t.after(()=>f.client.close());const calls=[];f.client.on('dynamic-tool-request',v=>calls.push(v));await f.client.start();
  f.call(1,{tool:'other'});f.call(2,{threadId:'other'});f.call(3,{arguments:{value:'x'.repeat(70000)}});assert.equal(calls.length,0);
  f.call(4);assert.equal(calls.length,1);f.call(5);assert.equal(calls[0].respond(response),false);assert.equal(f.messages.at(-1).error.code,-32600);
  f.call(6,{callId:'new'});f.client.dispatch({method:'account/updated',params:{}});assert.equal(calls[1].respond(response),false);
});
test('resolved or completed native request invalidates later response',async t=>{
  const f=fixture();t.after(()=>f.client.close());const calls=[];f.client.on('dynamic-tool-request',v=>calls.push(v));await f.client.start();
  f.call(1);f.client.dispatch({method:'serverRequest/resolved',params:{threadId:'thread',requestId:1}});assert.equal(calls[0].respond(response),false);
  f.call(2,{callId:'two'});f.client.dispatch({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn'}}});assert.equal(calls[1].respond(response),false);
});
test('a repeated RPC id revokes its earlier pending call even when the second call is invalid',async t=>{
  const f=fixture();t.after(()=>f.client.close());let pending;f.client.on('dynamic-tool-request',v=>{pending=v;});await f.client.start();
  f.call(7);f.call(7,{callId:'different',tool:'unknown'});assert.equal(pending.respond(response),false);assert.equal(f.messages.at(-1).error.code,-32600);
});
test('an early tool request reaches the owner before turn/start acknowledgement for later turn matching',async t=>{
  const f=fixture();t.after(()=>f.client.close());let early,acknowledged=false;f.client.on('dynamic-tool-request',v=>{assert.equal(acknowledged,false);early=v;});await f.client.start();f.enableEarly();
  const result=await f.client.turn('thread','test');acknowledged=true;
  assert.equal(early.params.turnId,result.turn.id);assert.equal(early.params.callId,'early');
  assert.equal(early.respond(response),true);assert.deepEqual(f.messages.at(-1),{id:600,result:response});
});
