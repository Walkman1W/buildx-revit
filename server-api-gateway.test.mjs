import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {createServerApiGateway} from './lib/server-api-gateway.mjs';
import {CodexClientCore} from './lib/codex-client-core.mjs';
import {createApiProviderLaunch,ISOLATED_API_FIXTURE_KEY} from './lib/api-provider-launch.mjs';

const fakeKey='fixture-upstream-key-very-private';
const auth=Object.freeze({authorize:({authorization})=>({allowed:authorization==='Bearer local-fixture-token'})});

async function fixture(options={}){
  const calls=[];
  const fetchImpl=options.fetchImpl??(async(url,init)=>{calls.push({url,init});return new Response('data: hello\n\ndata: done\n\n',{status:200,headers:{'content-type':'text/event-stream','x-upstream-secret':fakeKey}});});
  const gateway=createServerApiGateway({upstreamBaseUrl:'https://provider.example/v1',apiKey:fakeKey,authorizationOwner:auth,fetchImpl,...options.gateway});
  const server=http.createServer((req,res)=>{void gateway.handle(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');
  return {calls,gateway,url:`http://127.0.0.1:${server.address().port}`,close:async()=>{gateway.close();server.close();await once(server,'close');}};
}
const body=JSON.stringify({model:'fixture',input:'hello',stream:true,max_output_tokens:512});
const request=(url,{authorization='Bearer local-fixture-token',...options}={})=>fetch(url,{method:'POST',headers:{authorization,'content-type':'application/json'},body,...options});

test('authorized response streams and forwards only server-owned upstream credential',async t=>{
  const f=await fixture();t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,200);assert.equal(await response.text(),'data: hello\n\ndata: done\n\n');
  assert.equal(response.headers.get('x-upstream-secret'),null);assert.equal(f.calls.length,1);
  const {url,init}=f.calls[0];assert.equal(url,'https://provider.example/v1/responses');assert.equal(init.redirect,'manual');
  assert.equal(init.headers.authorization,'Bearer '+fakeKey);assert.equal(JSON.stringify(init.headers).includes('local-fixture-token'),false);
  assert.equal(Buffer.from(init.body).toString(),body);
});

test('wrong identity, malformed body and wrong route never invoke upstream',async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await request(f.url+'/v1/responses',{authorization:'Bearer wrong'})).status,403);
  assert.equal((await request(f.url+'/v1/responses?target=other')).status,404);
  assert.equal((await request(f.url+'/v1/responses',{body:'{' })).status,400);
  assert.equal((await request(f.url+'/v1/responses',{body:JSON.stringify({model:''})})).status,400);
  assert.equal((await request(f.url+'/v1/responses',{body:JSON.stringify({model:'fixture',max_output_tokens:4097})})).status,400);
  assert.equal(f.calls.length,0);
});

test('request limits, invalid upstream and mutable or missing auth owner fail closed',async t=>{
  const f=await fixture({gateway:{maxRequestBytes:32}});t.after(f.close);
  assert.equal((await request(f.url+'/v1/responses')).status,413);assert.equal(f.calls.length,0);
  for(const url of ['http://provider.example/v1','https://u:p@provider.example/v1','https://provider.example/v1?key=x','https://provider.example/v1#token'])
    assert.throws(()=>createServerApiGateway({upstreamBaseUrl:url,apiKey:fakeKey,authorizationOwner:auth}));
  assert.throws(()=>createServerApiGateway({upstreamBaseUrl:'https://provider.example/v1',apiKey:fakeKey,authorizationOwner:{authorize:()=>({allowed:true})}}));
});

test('redirects and upstream failures never relay locations or error bodies',async t=>{
  let count=0;
  const f=await fixture({fetchImpl:async()=>{count++;return new Response('upstream says '+fakeKey,{status:302,headers:{location:'https://elsewhere.example/'}});}});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,502);assert.equal(response.headers.get('location'),null);assert.equal((await response.text()).includes(fakeKey),false);assert.equal(count,1);
});

test('response filter prevents credential disclosure even when split across chunks',async t=>{
  const parts=[Buffer.from('prefix-'+fakeKey.slice(0,10)),Buffer.from(fakeKey.slice(10)+'-suffix')];
  const f=await fixture({fetchImpl:async()=>new Response(new ReadableStream({start(c){for(const part of parts)c.enqueue(part);c.close();}}),{headers:{'content-type':'application/json'}})});t.after(f.close);
  let received='';try{const response=await request(f.url+'/v1/responses');received=await response.text();}catch{/* truncated response is intentionally not a success */}
  assert.equal(received.includes(fakeKey),false);
});

test('response content type is canonicalized and cannot reflect a secret parameter',async t=>{
  const f=await fixture({fetchImpl:async()=>new Response('{"ok":true}',{headers:{'content-type':'application/json; token='+fakeKey}})});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');assert.equal((await response.text()).includes(fakeKey),false);
});

test('response over byte budget is interrupted without retry',async t=>{
  let calls=0;
  const f=await fixture({gateway:{maxResponseBytes:24},fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(Buffer.alloc(100,65));c.close();}}),{headers:{'content-type':'application/json'}});}});t.after(f.close);
  let body='';try{body=await (await request(f.url+'/v1/responses')).text();}catch{/* an incomplete response is not success */}
  assert.equal(body.length,0);assert.equal(calls,1);
});

test('client disconnect aborts a dispatched upstream call',async t=>{
  let calledResolve,abortedResolve;const called=new Promise(r=>calledResolve=r),aborted=new Promise(r=>abortedResolve=r);
  const f=await fixture({fetchImpl:async(_url,{signal})=>{calledResolve();return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{abortedResolve();reject(new Error('aborted'));},{once:true});});}});t.after(f.close);
  const controller=new AbortController();const pending=request(f.url+'/v1/responses',{signal:controller.signal}).catch(()=>null);
  await called;controller.abort();await pending;
  await Promise.race([aborted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not cancelled')),1000))]);
  for(let i=0;i<100&&f.gateway.close().pending;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.gateway.close().closed,true);
});

test('stream limit and timeout abort the upstream, with no retry',async t=>{
  let calls=0,aborted=false;
  const f=await fixture({gateway:{timeoutMs:40},fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error(fakeKey));},{once:true});});}});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,502);assert.equal((await response.text()).includes(fakeKey),false);assert.equal(calls,1);assert.equal(aborted,true);
});

test('closing during authorization prevents a later allowed decision from dispatching',async t=>{
  let release,called=0;
  const owner=Object.freeze({authorize:()=>new Promise(resolve=>{release=()=>resolve({allowed:true});})});
  const f=await fixture({gateway:{authorizationOwner:owner},fetchImpl:async()=>{called++;throw new Error('should not run');}});t.after(f.close);
  const pending=request(f.url+'/v1/responses').catch(()=>null);
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.equal(typeof release,'function');
  assert.equal(f.gateway.close().closed,false);release();await pending;
  assert.equal(called,0);
  for(let i=0;i<100&&f.gateway.close().pending;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.gateway.close().closed,true);
});

test('authorization receives the model and bounded request budget, never an inferred token count',async t=>{
  let observed;
  const owner=Object.freeze({authorize:value=>{observed=value;return {allowed:true};}});
  const f=await fixture({gateway:{authorizationOwner:owner}});t.after(f.close);
  assert.equal((await request(f.url+'/v1/responses')).status,200);
  assert.equal(observed.model,'fixture');assert.equal(observed.maxOutputTokens,512);assert.equal(observed.inputBytes,Buffer.byteLength(body));
});

test('missing output budget receives server default; explicit values remain unchanged',async t=>{
  let observed;
  const owner=Object.freeze({authorize:value=>{observed=value;return {allowed:true};}});
  const f=await fixture({gateway:{authorizationOwner:owner,maxOutputTokens:900}});t.after(f.close);
  assert.equal((await request(f.url+'/v1/responses',{body:JSON.stringify({model:'fixture',input:'x'})})).status,200);
  assert.equal(JSON.parse(f.calls[0].init.body).max_output_tokens,900);assert.equal(observed.maxOutputTokens,900);
  assert.equal((await request(f.url+'/v1/responses',{body:JSON.stringify({model:'fixture',max_output_tokens:321})})).status,200);
  assert.equal(JSON.parse(f.calls[1].init.body).max_output_tokens,321);assert.equal(observed.maxOutputTokens,321);
});

test('unsettled authentication retains ownership and limits new requests until it resolves',async t=>{
  let release,called=0;
  const owner=Object.freeze({authorize:()=>{called++;return new Promise(resolve=>{release=resolve;});}});
  const f=await fixture({gateway:{authorizationOwner:owner,timeoutMs:40,maxInflight:2}});t.after(f.close);
  const first=request(f.url+'/v1/responses');
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.equal(typeof release,'function');
  assert.equal((await request(f.url+'/v1/responses')).status,503);assert.equal(called,1);
  await first;assert.equal(f.gateway.close().closed,false);
  release({allowed:false});
  for(let i=0;i<100&&f.gateway.close().pending;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.gateway.close().closed,true);assert.equal(f.calls.length,0);
});

test('a transport that ignores abort remains owned until it settles and its late body is cancelled',async t=>{
  let resolveUpstream,wasCancelled=false;
  const f=await fixture({gateway:{timeoutMs:40},fetchImpl:()=>new Promise(resolve=>{resolveUpstream=resolve;})});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,502);
  assert.equal(f.gateway.close().closed,false);
  const stream=new ReadableStream({cancel(){wasCancelled=true;}});
  resolveUpstream(new Response(stream,{headers:{'content-type':'application/json'}}));
  for(let i=0;i<100&&f.gateway.close().pending;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(wasCancelled,true);assert.equal(f.gateway.close().closed,true);
});

test('failed upstream body cleanup remains pending and close retries its owned handle',async t=>{
  let attempts=0;
  const f=await fixture({fetchImpl:async()=>({status:302,ok:false,body:{cancel(){attempts++;if(attempts===1)return Promise.reject(new Error('retry'));return Promise.resolve();}}})});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(response.status,502);
  for(let i=0;i<100&&attempts<1;i++)await new Promise(r=>setTimeout(r,5));assert.equal(attempts,1);
  // Calling close explicitly retries the same retained body after its first
  // cancellation failure rather than claiming it was already released.
  assert.equal(f.gateway.close().closed,false);
  for(let i=0;i<100&&f.gateway.close().pending;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.gateway.close().closed,true);assert.equal(attempts,2);
});

function simulatedResponses(call){
  const events=[];const emit=(type,payload)=>events.push(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  const item=call?{id:'fc_probe',type:'function_call',status:'completed',call_id:'call_probe',name:'fixture_echo',namespace:'mcp__fixture',arguments:'{}'}:
    {id:'msg_probe',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'probe complete',annotations:[]}]};
  const response={id:call?'resp_tool':'resp_answer',object:'response',created_at:1730000000,status:'completed',model:'gpt-5.1',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  emit('response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}});
  emit('response.output_item.added',{type:'response.output_item.added',output_index:0,item:call?{...item,status:'in_progress',arguments:''}:{...item,status:'in_progress',content:[]}});
  if(call){
    emit('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:'{}'});
    emit('response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:'{}'});
  }else{
    emit('response.content_part.added',{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
    emit('response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'probe complete'});
    emit('response.output_text.done',{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'probe complete'});
    emit('response.content_part.done',{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  }
  emit('response.output_item.done',{type:'response.output_item.done',output_index:0,item});
  emit('response.completed',{type:'response.completed',response});
  return events.join('');
}

const codexExecutable=process.env.BUILDX_TEST_CODEX_EXE;
test('real isolated BuildX Codex client uses gateway default budget, model stream and fixture MCP tool',
  {skip:!codexExecutable,timeout:60000},async()=>{
    assert.ok(path.isAbsolute(codexExecutable));
    const tempRoot=await realpath(os.tmpdir()),dir=await realpath(await mkdtemp(path.join(tempRoot,'buildx-gateway-e2e-')));
    assert.equal(path.dirname(dir),tempRoot);assert.match(path.basename(dir),/^buildx-gateway-e2e-/);
    await mkdir(path.join(dir,'codex-home'));
    const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT;
    const isolatedEnv={CODEX_HOME:path.join(dir,'codex-home'),HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir,
      ...(systemRoot?{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:path.join(systemRoot,'System32')}:{}),...(process.env.COMSPEC?{COMSPEC:process.env.COMSPEC}:{})};
    let requests=0,correctAuth=true,correctBudget=true,verified=false,toolInvoked=false,exitConfirmed=false,child,client;
    const authOwner=Object.freeze({authorize:({authorization})=>({allowed:authorization==='Bearer '+ISOLATED_API_FIXTURE_KEY})});
    const gateway=createServerApiGateway({upstreamBaseUrl:'https://provider.example/v1',apiKey:fakeKey,authorizationOwner:authOwner,maxOutputTokens:1024,
      fetchImpl:async(_url,init)=>{
        requests++;correctAuth&&=init.headers.authorization==='Bearer '+fakeKey;
        const data=JSON.parse(Buffer.from(init.body).toString('utf8'));correctBudget&&=data.max_output_tokens===1024;
        return new Response(simulatedResponses(requests===1),{headers:{'content-type':'text/event-stream'}});
      }});
    const server=http.createServer((req,res)=>{void gateway.handle(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const fixture=fileURLToPath(new URL('./workbench/experiments/api-provider/real-codex-probe-fixture.mjs',import.meta.url));
      const names=Object.freeze(['fixture_echo']),group=Object.freeze({name:'fixture',toolNames:names,statusTimeout:10000,failFast:true});
      const profile=Object.freeze({id:'model-workspace',service:'fixture-codex',mode:'document-workbench',toolNames:names,
        groups:Object.freeze([group]),clientInfo:Object.freeze({name:'buildx_gateway_fixture',version:'0.1'}),
        buildLaunchArgs:()=>['app-server','--listen','stdio://','--strict-config','-c','features.shell_tool=false','-c','web_search="disabled"',
          '-c','mcp_servers.fixture.enabled=true','-c',`mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
          '-c',`mcp_servers.fixture.args=${JSON.stringify([fixture])}`,'-c','mcp_servers.fixture.startup_timeout_sec=10'],
        buildInstructions:()=>'Use fixture_echo when appropriate.',connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',
        verifiedDiagnostic:'verified',denialMessage:'denied',verifyWholeCatalog:catalog=>{
          const entries=catalog?.data,entry=entries?.[0];
          verified=Array.isArray(entries)&&entries.length===1&&(catalog.nextCursor===null||catalog.nextCursor===undefined)&&entry?.name==='fixture'&&entry.runtimeStatus==='connected'&&!entry.toolsError&&
            Object.keys(entry.tools||{}).length===1&&entry.tools?.fixture_echo?.name==='fixture_echo'&&Array.isArray(entry.resources)&&entry.resources.length===0&&Array.isArray(entry.resourceTemplates)&&entry.resourceTemplates.length===0;
          return {ok:verified};
        }});
      const launcher=createApiProviderLaunch({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'gpt-5.1',apiKey:ISOLATED_API_FIXTURE_KEY,allowLoopbackHttp:true});
      const providerId=launcher.describe().identity.providerId;
      const isolatedSpawn=(command,args,options)=>{
        const entry=args.find(value=>value.startsWith(`model_providers.${providerId}.env_key=`));assert.ok(entry);
        const envName=JSON.parse(entry.slice(entry.indexOf('=')+1));assert.equal(options.env[envName],ISOLATED_API_FIXTURE_KEY);
        child=spawn(command,args,{...options,env:{...isolatedEnv,[envName]:ISOLATED_API_FIXTURE_KEY}});child.on('close',()=>{exitConfirmed=true;});return child;
      };
      client=new CodexClientCore(dir,profile,{apiProvider:launcher,spawn:isolatedSpawn,resolveRuntimes:()=>({codex:codexExecutable,python:'unused'}),readConfiguredNames:()=>[],closeTimeoutMs:2500,killTimeoutMs:1000});
      let finish,rejectTurn;const finished=new Promise((resolve,reject)=>{finish=resolve;rejectTurn=reject;});
      client.on('notification',(method,params)=>{
        if(method==='item/completed'&&params?.item?.type==='mcpToolCall'&&params.item.tool==='fixture_echo')toolInvoked=true;
        if(method==='turn/completed')params?.turn?.status==='completed'?finish():rejectTurn(new Error('turn incomplete'));
      });
      await client.start();assert.equal(client.state.ready,true);assert.equal(verified,true);
      const thread=await client.newThread();const turn=await client.turn(thread,'Reply briefly.');assert.ok(turn.turn?.id);
      let timer;try{await Promise.race([finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture turn timeout')),20000);})]);}finally{clearTimeout(timer);}
      assert.equal(toolInvoked,true);assert.equal(requests,2);assert.equal(correctAuth,true);assert.equal(correctBudget,true);
      assert.equal((await client.close()).closed,true);assert.equal(exitConfirmed,true);
    }finally{
      if(client&&!exitConfirmed)await client.close().catch(()=>{});
      gateway.close();await new Promise(resolve=>server.close(resolve));
      if(!child||exitConfirmed)await rm(dir,{recursive:true,force:true});
    }
  });

test('accounting observes complete split SSE without changing bytes',async t=>{
  let done;const finished=new Promise(resolve=>{done=resolve;});let started;
  const owner=Object.freeze({begin:async x=>{started=x;return 'reservation';},finish:async x=>done(x)});
  const payload='data: '+JSON.stringify({type:'response.completed',response:{id:'resp_fixture',usage:{input_tokens:12,output_tokens:4,total_tokens:16}}})+'\n\ndata: [DONE]\n\n';
  const f=await fixture({gateway:{accountingOwner:owner},fetchImpl:async()=>new Response(new ReadableStream({start(c){for(const part of [payload.slice(0,17),payload.slice(17)])c.enqueue(new TextEncoder().encode(part));c.close();}}),{headers:{'content-type':'text/event-stream'}})});t.after(f.close);
  const response=await request(f.url+'/v1/responses');assert.equal(await response.text(),payload);
  const result=await finished;assert.equal(result.state,'settled');assert.equal(result.requestId,started.requestId);assert.equal(result.context,'reservation');assert.equal(result.responseId,'resp_fixture');assert.deepEqual(result.usage,{inputTokens:12,outputTokens:4,totalTokens:16});
});

test('accounting marks missing or interrupted usage for reconciliation',async t=>{
  for(const payload of ['data: {"type":"response.completed"','data: [DONE]\n\n']){
    let done;const finished=new Promise(resolve=>{done=resolve;});
    const owner=Object.freeze({begin:()=>({}),finish:x=>done(x)});
    const f=await fixture({gateway:{accountingOwner:owner},fetchImpl:async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}})});
    const response=await request(f.url+'/v1/responses');assert.equal(await response.text(),payload);
    assert.equal((await finished).state,'pending_reconciliation');await f.close();
  }
});

test('accounting captures JSON usage and rejects untrusted owner',async t=>{
  let done;const finished=new Promise(resolve=>{done=resolve;});
  const owner=Object.freeze({begin:()=>null,finish:x=>done(x)});
  const payload=JSON.stringify({id:'resp_json',usage:{input_tokens:3,output_tokens:2,total_tokens:5}});
  const f=await fixture({gateway:{accountingOwner:owner},fetchImpl:async()=>new Response(payload,{headers:{'content-type':'application/json'}})});t.after(f.close);
  assert.equal(await (await request(f.url+'/v1/responses')).text(),payload);assert.equal((await finished).state,'settled');
  assert.throws(()=>createServerApiGateway({upstreamBaseUrl:'https://provider.example/v1',apiKey:fakeKey,authorizationOwner:auth,accountingOwner:{begin(){},finish(){}}}));
});

test('an exhausted reservation is rejected before dispatch',async t=>{
  let requests=0;
  const owner=Object.freeze({
    begin(){throw Object.assign(new Error('test quota'),{code:'MANAGED_INFERENCE_DENIED'});},
    finish(){assert.fail('no reservation was made');}
  });
  const f=await fixture({gateway:{accountingOwner:owner},fetchImpl:async()=>{requests++;return new Response();}});t.after(f.close);
  const response=await request(f.url+'/v1/responses');
  assert.equal(response.status,429);
  assert.equal(requests,0);
});
