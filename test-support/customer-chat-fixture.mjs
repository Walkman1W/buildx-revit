import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export const CUSTOMER_MODULES=Object.freeze(['codex-client-core.mjs','local-runtimes.mjs','panel-server-core.mjs','chat-session.mjs',
  'chat-context.mjs','cad-document-path.mjs','workbench-contracts.mjs','panel-accounts.mjs','codex-confirmation.mjs','customer-chat-profile.mjs',
  'customer-chat.mjs','buildx-runtime-config.mjs','buildx-auth.mjs']);
export const CUSTOMER_ASSETS=Object.freeze(['index.html','style.css','app.js','chat-view.mjs','account.js','codex-account.js']);
export const CUSTOMER_COMPONENT_MODULE_PATHS=Object.freeze([...CUSTOMER_MODULES.map(name=>'lib/'+name),'lib/panel-audit.mjs','customer-server.mjs']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ownedChildren=new Map();
const guard=String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks,isBuiltin} from 'node:module';
const root=path.resolve(process.argv[2]),harnessRoot=path.dirname(fileURLToPath(import.meta.url)),names=JSON.parse(process.argv[3]),required=JSON.parse(process.argv[4]);
const workerStart=process.hrtime.bigint(),workerCpuStart=process.cpuUsage();
const workerMetrics=()=>{const cpu=process.cpuUsage(workerCpuStart),usage=process.resourceUsage();return {wallMs:Number(process.hrtime.bigint()-workerStart)/1e6,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimePeakRssBytes:Number.isSafeInteger(usage.maxRSS)&&usage.maxRSS>0?usage.maxRSS*1024:null,scope:'worker only; CPU/wall since bootstrap imports; lifetime RSS observed after completed flow/cleanup',processFamilyCpu:null,processFamilyPeakMemory:null,tokens:null};};
const allowed=new Set(names.map(name=>pathToFileURL(path.join(root,name)).href));
const requiredUrls=new Set(required.map(name=>pathToFileURL(path.join(root,name)).href)); const importComponent=relative=>import(pathToFileURL(path.join(root,...relative.split('/'))).href);
const resolved=[],denied=[];
registerHooks({resolve(specifier,context,nextResolve){
  const result=nextResolve(specifier,context);
  if(isBuiltin(result.url)||result.url.startsWith('node:')){resolved.push(result.url);return result;}
  if(!allowed.has(result.url)){denied.push(result.url);const error=new Error('Module is outside the isolated customer component');error.code='CUSTOMER_IMPORT_SCOPE';throw error;}
  resolved.push(result.url);return result;
}});
const loaded=()=>[...new Set(resolved.filter(url=>url.startsWith('file:')))];
const saveTrace=()=>fs.writeFile(path.join(harnessRoot,'import-trace.json'),JSON.stringify({resolved,denied},null,2)+'\n');
`;

const workflowSetup=String.raw`
const {EventEmitter}=await import('node:events');
const childProcess=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');
let realSpawnAttempts=0,foreignFetchAttempts=0,allowedOrigin=null;
childProcess.default.spawn=()=>{realSpawnAttempts++;throw new Error('Real native processes are forbidden in this fixture');};
childProcess.default.spawnSync=()=>{realSpawnAttempts++;throw new Error('Real native processes are forbidden in this fixture');};syncBuiltinESMExports();
const localFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const address=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowedOrigin||address.origin!==allowedOrigin){foreignFetchAttempts++;throw new Error('Only the isolated owned HTTP origin may be fetched');}return localFetch(input,options);};
const {CodexClientCore}=await importComponent('lib/codex-client-core.mjs');
const {createCustomerChatProfile}=await importComponent('lib/customer-chat-profile.mjs');
const {createCustomerChatServer}=await importComponent('lib/customer-chat.mjs');
const {createBuildxAuth}=await importComponent('lib/buildx-auth.mjs');
await assert.rejects(import(pathToFileURL(path.join(harnessRoot,'forbidden.mjs')).href),{code:'CUSTOMER_IMPORT_SCOPE'});
await assert.rejects(fs.stat(path.join(harnessRoot,'forbidden-ran')),{code:'ENOENT'});
for(const name of ['codex-client.mjs','panel-server.mjs','codex-profile.mjs','panel-profile.mjs','panel-tools.mjs','source-tools.mjs'])await assert.rejects(fs.stat(path.join(root,'lib',name)),{code:'ENOENT'});

const recoveryScenario=process.argv[5]==='recovery';
const nativeEmail='native-fixture@example.invalid',nativeMessages=[],nativeChildren=[],launches=[],nativeTimeline=[];
const nativeEvent=(event,child,details={})=>nativeTimeline.push({sequence:nativeTimeline.length+1,event,child:child.index,...details});
const nativeSpawn=(executable,args,options)=>{
  launches.push({executable,args,options:{cwd:options.cwd,windowsHide:options.windowsHide,stdio:options.stdio}});
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.closeEvents=0;child.endCalls=0;child.killCalls=0;
  child.index=nativeChildren.length+1;child.threadId='isolated-customer-thread'+(child.index===1?'':'-'+child.index);child.baseTurnId='isolated-customer-turn'+(child.index===1?'':'-'+child.index);child.turnId=child.baseTurnId;child.turnCount=0;child.holdClose=false;child.deferTurnAck=false;child.pendingTurnAck=null;
  nativeEvent('spawn',child);
  child.send=message=>{nativeEvent(message.id===undefined?'notification':'response',child,{method:message.method??null});child.stdout.emit('data',Buffer.from(JSON.stringify(message)+'\n'));};
  child.eof=()=>{nativeEvent('stdout_eof',child);child.stdout.emit('end');};
  child.on('close',()=>nativeEvent('close',child));
  child.confirmClose=()=>{if(child.closeEvents)return;child.closeEvents++;nativeEvent('exit',child);child.emit('exit',0,null);child.emit('close',0,null);};
  child.releaseTurnAck=()=>{assert.ok(child.pendingTurnAck);const response=child.pendingTurnAck;child.pendingTurnAck=null;child.deferTurnAck=false;nativeEvent('turn_ack_released',child);child.send(response);};
  child.stdin.write=(line,callback)=>{
    const message=JSON.parse(line);if(message.method==='turn/start'){child.turnCount++;child.turnId=child.baseTurnId+(child.turnCount===1?'':'-'+child.turnCount);}nativeMessages.push(message);
    nativeEvent('rpc',child,{method:message.method??null,threadId:message.params?.threadId??null,turnId:message.method==='turn/start'?child.turnId:message.params?.turnId??null,...(message.method==='turn/start'?{text:message.params.input[0].text}:{})});
    queueMicrotask(()=>{
      callback?.();if(message.id===undefined||!message.method)return;
      let result={};
      if(message.method==='account/read'){assert.deepEqual(message.params,{refreshToken:false});result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:nativeEmail,planType:'free'}};}
      else if(message.method==='thread/start'){assert.equal(message.params.sandbox,'read-only');assert.equal(message.params.approvalPolicy,'never');assert.equal(message.params.ephemeral,true);assert.ok(message.params.developerInstructions.includes('0 项工具'));result={thread:{id:child.threadId}};}
      else if(message.method==='mcpServerStatus/list'){assert.deepEqual(message.params,{threadId:child.threadId,detail:'toolsAndAuthOnly',limit:100});result={data:[],nextCursor:null};}
      else if(message.method==='turn/start'){result={turn:{id:child.turnId}};if(child.deferTurnAck){child.pendingTurnAck={id:message.id,result};nativeEvent('turn_ack_held',child);return;}}
      else assert.equal(message.method,'initialize');
      child.send({id:message.id,result});
    });return true;
  };
  child.stdin.end=()=>{child.endCalls++;nativeEvent('end_requested',child);if(!child.holdClose)queueMicrotask(()=>child.confirmClose());};
  child.kill=()=>{child.killCalls++;throw new Error('Completed fixture must close without kill');};nativeChildren.push(child);return child;
};
const composition=createCustomerChatProfile();
const codex=new CodexClientCore(root,composition.codex,{spawn:nativeSpawn,resolveRuntimes:()=>({codex:'fixture-native',python:'fixture-python'}),readConfiguredNames:()=>['revit_local','buildx_source','foreign'],closeTimeoutMs:recoveryScenario?1000:50,killTimeoutMs:50});
const user={id:'11111111-1111-1111-1111-111111111111',email:'buildx-fixture@example.invalid'},otherUser={id:'22222222-2222-2222-2222-222222222222',email:'other-buildx-fixture@example.invalid'},authCalls=[];
const auth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',fetchImpl:async(url,options)=>{
  authCalls.push({path:new URL(url).pathname,method:options.method});
  if(url.includes('/token?grant_type=password')){const isOther=JSON.parse(options.body).email===otherUser.email;return Response.json({access_token:'fake-access-fixture'+(isOther?'-b':''),refresh_token:'fake-refresh-fixture'+(isOther?'-b':''),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600});}
  if(url.endsWith('/user'))return Response.json(options.headers.Authorization.endsWith('-b')?otherUser:user);
  if(url.includes('/logout?scope=local'))return new Response(null,{status:204});
  throw new Error('Unexpected isolated auth route');
}});
const app=createCustomerChatServer({root,codex,accountAuth:auth,port:0});
`;

const workflow=guard+workflowSetup+String.raw`
let reader,streamEnded=false,closeResult=null,buffer='',sseBytes=0,sseFrames=0,watchdog;
const decoder=new TextDecoder('utf-8',{fatal:true});
const controller=new AbortController();
const trace={steps:[],actualCodexProcesses:0,cloudRequests:0,modelOperations:0,uiOperations:0};
try{
  const {origin}=await app.listen();allowedOrigin=origin;await app.connect();
  const initial=await(await fetch(origin+'/api/status',{signal:AbortSignal.timeout(5000)})).json();
  assert.equal(initial.service,'buildx-customer-chat');assert.equal(initial.workspace.kind,'customer-chat');assert.equal(initial.workspace.supportsModelContext,false);assert.deepEqual(initial.toolCatalog,[]);assert.equal(initial.toolCount,0);assert.equal(initial.account.required,true);assert.equal(initial.ready,false);
  const post=async(route,input={},cookie)=>{
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'customer-isolation',...input}),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],cookieHeader:response.headers.get('set-cookie')};
  };
  assert.equal((await post('turn',{message:'unauthenticated'})).status,401);
  const deniedSse=await fetch(origin+'/api/events?client=customer-isolation',{signal:AbortSignal.timeout(5000)});assert.equal(deniedSse.status,401);await deniedSse.body.cancel();
  trace.steps.push('unauthenticated_http_sse_401');
  const signed=await post('account/sign-in',{email:user.email,password:'fixture-password'});assert.equal(signed.status,200);assert.match(signed.cookie,/^buildx_customer_chat_session=/);assert.doesNotMatch(signed.cookie,/^buildx_model_session=/);assert.match(signed.cookieHeader,/HttpOnly/);assert.match(signed.cookieHeader,/SameSite=Strict/);assert.doesNotMatch(JSON.stringify(signed.body),/fake-access|fake-refresh|fixture-password/);
  assert.equal((await post('turn',{message:'unconfirmed'},signed.cookie)).status,403);assert.equal(nativeMessages.filter(value=>value.method==='turn/start').length,0);trace.steps.push('dedicated_cookie_and_confirmation_required');
  const inspected=await post('codex-account/inspect',{},signed.cookie);assert.equal(inspected.status,200);assert.equal(inspected.body.display.email,nativeEmail);assert.equal(inspected.body.confirmation.stableAccountId,null);assert.equal(inspected.body.confirmation.workspaceId,null);
  const confirmed=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie);assert.equal(confirmed.status,200);assert.equal(confirmed.body.confirmation.localConnectionConfirmed,true);assert.equal(confirmed.body.confirmation.stableAccountId,null);assert.equal(confirmed.body.confirmation.workspaceId,null);
  const status=await(await fetch(origin+'/api/status',{headers:{Cookie:signed.cookie},signal:AbortSignal.timeout(5000)})).json();assert.equal(status.ready,true);assert.equal(status.codexAccount.stableAccountId,null);assert.equal(status.codexAccount.workspaceId,null);assert.doesNotMatch(JSON.stringify(status),/native-fixture|fake-access|fake-refresh|planType|challengeId/);trace.steps.push('fresh_inspect_and_explicit_confirm');
  for(const asset of ['index.html','style.css','app.js','chat-view.mjs','account.js','codex-account.js']){const response=await fetch(origin+'/'+(asset==='index.html'?'':asset),{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);}
  watchdog=setTimeout(()=>controller.abort(),8000);
  const stream=await fetch(origin+'/api/events?client=customer-isolation',{headers:{Cookie:signed.cookie},signal:controller.signal});assert.equal(stream.status,200);reader=stream.body.getReader();
  const nextEvent=async()=>{
    for(;;){
      const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith('event: '))continue;sseFrames++;assert.ok(sseFrames<=96);return {event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};}
      const value=await reader.read();if(value.done){decoder.decode();streamEnded=true;throw new Error('SSE ended before terminal reply');}sseBytes+=value.value.byteLength;assert.ok(sseBytes<=512*1024);buffer+=decoder.decode(value.value,{stream:true});
    }
  };
  const snapshot=await nextEvent();assert.equal(snapshot.event,'snapshot');assert.equal(snapshot.data.state.ready,true);assert.deepEqual(snapshot.data.session.messages,[]);
  const accepted=await post('turn',{message:'customer isolation dialogue'},signed.cookie);assert.equal(accepted.status,202);
  const turn=nativeMessages.find(value=>value.method==='turn/start');assert.ok(turn);assert.equal(turn.params.threadId,'isolated-customer-thread');assert.equal(turn.params.input[0].text,'customer isolation dialogue');
  const child=nativeChildren[0],identity={threadId:'isolated-customer-thread',turnId:'isolated-customer-turn'};
  child.send({method:'item/agentMessage/delta',params:{...identity,itemId:'isolated-answer',delta:'isolated customer reply'}});
  child.send({method:'item/completed',params:{...identity,item:{id:'isolated-answer',type:'agentMessage',text:'isolated customer reply'}}});
  child.send({method:'turn/completed',params:{...identity,turn:{id:'isolated-customer-turn',status:'completed'}}});
  let conversation,terminal;while(!terminal){const event=await nextEvent();if(event.event==='conversation')conversation=event.data;if(event.event==='done')terminal=event.data;}
  assert.equal(terminal.status,'completed');assert.equal(conversation.busy,false);assert.deepEqual(conversation.session.messages.map(message=>message.text),['customer isolation dialogue','isolated customer reply']);assert.ok(conversation.session.messages.every(message=>message.tools.length===0));assert.equal(conversation.session.context.document,null);assert.equal(conversation.session.context.selection,null);trace.steps.push('production_core_native_fake_sse_completed');
  const nativeCount=nativeMessages.length,canonical=app.snapshot('customer-isolation').session.messages;
  for(const input of [{includeDocument:true},{includeSelection:true}])assert.equal((await post('context',input,signed.cookie)).status,403);
  for(const context of [{includeDocument:true},{includeSelection:true}])assert.equal((await post('turn',{message:'forbidden context',context},signed.cookie)).status,403);
  assert.equal(nativeMessages.length,nativeCount);assert.equal(nativeMessages.filter(value=>value.method==='turn/start').length,1);assert.deepEqual(app.snapshot('customer-isolation').session.messages,canonical);trace.steps.push('model_and_selection_403_without_extra_native_turn');
  const argv=launches[0].args,overrides=[];for(let index=0;index<argv.length;index++)if(argv[index]==='-c')overrides.push(argv[++index]);
  for(const name of ['revit_local','buildx_source','foreign'])assert.ok(overrides.includes('mcp_servers.'+name+'.enabled=false'));
  assert.ok(overrides.includes('features.code_mode_host=false'));assert.ok(overrides.includes('web_search="disabled"'));assert.equal(overrides.some(value=>value.endsWith('=true')),false);
  const stopping=await post('stop-service',{},signed.cookie);assert.equal(stopping.status,202);closeResult=await app.close();assert.deepEqual(closeResult,{closed:true});assert.equal(child.endCalls,1);assert.equal(child.closeEvents,1);assert.equal(child.killCalls,0);assert.equal(app.server.listening,false);
  while(!streamEnded){const value=await reader.read();if(value.done){decoder.decode();streamEnded=true;}else{sseBytes+=value.value.byteLength;assert.ok(sseBytes<=512*1024);decoder.decode(value.value,{stream:true});}}
  await assert.rejects(fetch(origin+'/api/status',{signal:AbortSignal.timeout(1000)}));trace.steps.push('closed_true_native_close_and_sse_eof');
  assert.deepEqual(loaded().sort(),[...requiredUrls].sort());assert.equal(denied.length,1);assert.equal(realSpawnAttempts,0);assert.equal(foreignFetchAttempts,0);
  await saveTrace();
  await fs.writeFile(path.join(harnessRoot,'workflow-trace.json'),JSON.stringify({...trace,nativeRpcMethods:nativeMessages.filter(value=>value.method).map(value=>value.method),authPaths:authCalls,launchArguments:launches[0].args},null,2)+'\n');
  console.log(JSON.stringify({ok:true,productionModules:loaded().length,actualCodexProcesses:0,realSpawnAttempts,cloudRequests:0,foreignFetchAttempts,modelOperations:0,uiOperations:0,fakeNativeChildren:nativeChildren.length,nativeCloseEvents:child.closeEvents,closeResult,sseEnded:streamEnded,sseBytes,sseFrames,canonicalMessages:2,modelContextDenied:true,explicitConfirmation:true,dedicatedCookie:true,servedAssets:6}));
}finally{
  clearTimeout(watchdog);
  if(reader){if(!streamEnded)controller.abort();try{await reader.cancel();}catch{}reader.releaseLock();}
  if(!closeResult)await app.close();
  await saveTrace();
}
`;

const recovery=guard+workflowSetup+String.raw`
const observations={steps:[],nativeTimeline,httpNoticeReads:[],actualCodexProcesses:0,cloudRequests:0,modelOperations:0,uiOperations:0};
const noticeContract={code:'turn_result_unknown',message:'上一轮对话的结果未知；请核对后再明确发起新消息。'};
const streams=[];let closeResult=null,flowPassed=false,finalResult=null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async(condition,label)=>{const deadline=Date.now()+2000;while(!condition()){if(Date.now()>=deadline)throw new Error('Timed out waiting for '+label);await delay(5);}};
const openStream=async(origin,cookie)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  const response=await fetch(origin+'/api/events?client=customer-isolation',{headers:{Cookie:cookie},signal:controller.signal});assert.equal(response.status,200);
  const owner={controller,timer,reader:response.body.getReader(),decoder:new TextDecoder('utf-8',{fatal:true}),buffer:'',bytes:0,frames:0,ended:false,events:[]};streams.push(owner);
  owner.next=async()=>{for(;;){const end=owner.buffer.indexOf('\n\n');if(end>=0){const block=owner.buffer.slice(0,end);owner.buffer=owner.buffer.slice(end+2);if(!block.startsWith('event: '))continue;assert.ok(++owner.frames<=128);const value={event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};owner.events.push(value);return value;}
    const value=await owner.reader.read();if(value.done){owner.decoder.decode();owner.ended=true;return null;}owner.bytes+=value.value.byteLength;assert.ok(owner.bytes<=512*1024);owner.buffer+=owner.decoder.decode(value.value,{stream:true});}};
  owner.drain=async()=>{while(!owner.ended)await owner.next();};return owner;
};
const oldMessage='old-message-must-not-replay',newMessage='explicit-new-message-after-reconnect',privacyMessage='account-a-private-third-message',lateText='late-old-reply-must-not-appear';
try{
  const {origin}=await app.listen();allowedOrigin=origin;await app.connect();
  const initial=await(await fetch(origin+'/api/status',{signal:AbortSignal.timeout(5000)})).json();
  const post=async(route,input={},cookie)=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'customer-isolation',...input}),signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const signed=await post('account/sign-in',{email:user.email,password:'fixture-password'});assert.equal(signed.status,200);
  const status=async(cookie=signed.cookie)=>{const value=await(await fetch(origin+'/api/status',{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(5000)})).json();observations.httpNoticeReads.push({hasCookie:Boolean(cookie),initialCookie:cookie===signed.cookie,ready:value.ready,busy:value.busy,accountId:value.account?.user?.id??null,interruptionNotice:value.interruptionNotice});assert.doesNotMatch(JSON.stringify(value),/native-fixture|fake-access|fake-refresh|planType|challengeId/);return value;};
  const confirm=async()=>{const inspected=await post('codex-account/inspect',{},signed.cookie);assert.equal(inspected.status,200);const result=await post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie);assert.equal(result.status,200);assert.equal(result.body.confirmation.localConnectionConfirmed,true);return inspected.body.challengeId;};
  await confirm();assert.equal((await status()).ready,true);observations.steps.push('login_and_explicit_confirmation');
  const firstStream=await openStream(origin,signed.cookie);assert.equal((await firstStream.next()).event,'snapshot');
  assert.equal((await post('turn',{message:oldMessage},signed.cookie)).status,202);
  const old=nativeChildren[0];old.holdClose=true;old.send({method:'item/agentMessage/delta',params:{threadId:old.threadId,turnId:old.turnId,itemId:'old-answer',delta:'old partial reply'}});
  for(;;){const event=await firstStream.next();assert.ok(event);if(event.event==='conversation'&&event.data.session.messages.some(message=>message.role==='assistant'&&message.text==='old partial reply'))break;}
  assert.equal(app.snapshot('customer-isolation').busy,true);observations.steps.push('old_turn_accepted_and_incomplete');
  old.eof();await firstStream.drain();await delay(20);
  const failedStatus=await status(),failedSnapshot=app.snapshot('customer-isolation');
  observations.afterFault={http:{ready:failedStatus.ready,busy:failedStatus.busy,error:failedStatus.error,connectionStatus:failedStatus.connectionStatus,cleanupPending:failedStatus.cleanupPending,confirmed:failedStatus.codexConfirmation.localConnectionConfirmed,interruptionNotice:failedStatus.interruptionNotice},core:{ready:codex.state.ready,cleanupPending:codex.state.cleanupPending,connectionStatus:codex.state.connectionStatus},sseEnded:firstStream.ended,oldEndCallsBeforeManualReconnect:old.endCalls,spawnsBeforeManualReconnect:nativeChildren.length,oldContentVisible:failedSnapshot.session.messages.some(message=>message.text.includes(oldMessage)),unknownMessageVisible:failedSnapshot.session.messages.some(message=>message.status==='unknown'),messageCount:failedSnapshot.session.messages.length,unknownFailureEventVisible:firstStream.events.some(event=>event.event==='failure'&&event.data.status==='unknown')};
  assert.equal(failedStatus.ready,false);assert.equal(failedStatus.busy,false);assert.equal(failedStatus.codexConfirmation.localConnectionConfirmed,false);assert.equal(codex.state.cleanupPending,true);assert.equal(codex.child,old);assert.equal(old.closeEvents,0);assert.equal(nativeChildren.length,1);assert.equal(old.endCalls,0,'Fault must not initiate an automatic reconnect before the user request');
  assert.ok(observations.afterFault.unknownMessageVisible||!observations.afterFault.oldContentVisible,'An old visible turn must not remain falsely in progress');
  assert.deepEqual(failedStatus.interruptionNotice,noticeContract);
  const noticeStream=await openStream(origin,signed.cookie),noticeSnapshot=await noticeStream.next();assert.equal(noticeSnapshot.event,'snapshot');observations.noticeAfterFaultSnapshot=noticeSnapshot.data.state.interruptionNotice;assert.deepEqual(noticeSnapshot.data.state.interruptionNotice,noticeContract);
  const wrongCookie='buildx_customer_chat_session=unrelated-fixture-cookie';
  for(const cookie of [null,wrongCookie]){assert.equal((await status(cookie)).interruptionNotice,null);const rejected=await fetch(origin+'/api/events?client=customer-isolation',{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(5000)});const code=rejected.status;await rejected.body.cancel();assert.equal(code,401);}
  assert.equal((await post('turn',{message:'blocked-before-reconnect'},signed.cookie)).status,403);assert.equal((await post('codex-account/inspect',{},signed.cookie)).status,503);
  assert.equal(nativeMessages.filter(message=>message.method==='turn/start').length,1);assert.deepEqual((await status()).interruptionNotice,noticeContract);observations.steps.push('cookie_scoped_notice_in_status_and_real_snapshot_after_eof');
  const reconnect=await post('reconnect',{},signed.cookie);assert.equal(reconnect.status,202);await waitUntil(()=>old.endCalls===1,'old stdin.end');
  assert.equal(old.closeEvents,0);assert.equal(codex.child,old);assert.equal(nativeChildren.length,1);observations.steps.push('reconnect_waits_for_exact_old_close');
  old.confirmClose();await waitUntil(()=>nativeChildren.length===2&&codex.state.ready,'new connected child');
  const current=nativeChildren[1];assert.notEqual(current.threadId,old.threadId);assert.equal(old.closeEvents,1);assert.equal(old.killCalls,0);
  const oldClosed=nativeTimeline.find(item=>item.event==='close'&&item.child===1),newSpawn=nativeTimeline.find(item=>item.event==='spawn'&&item.child===2);assert.ok(oldClosed.sequence<newSpawn.sequence);
  const reconnected=await status();assert.equal(reconnected.ready,false);assert.equal(reconnected.codexConfirmation.localConnectionConfirmed,false);assert.deepEqual(reconnected.interruptionNotice,noticeContract);
  assert.equal((await post('turn',{message:'blocked-until-reconfirmed'},signed.cookie)).status,403);assert.equal(nativeMessages.filter(message=>message.method==='turn/start').length,1);
  await confirm();const afterConfirmation=await status();assert.equal(afterConfirmation.ready,true);assert.deepEqual(afterConfirmation.interruptionNotice,noticeContract);observations.steps.push('notice_survives_reconnect_and_explicit_reconfirmation');
  const secondStream=await openStream(origin,signed.cookie),reconfirmedSnapshot=await secondStream.next();assert.equal(reconfirmedSnapshot.event,'snapshot');assert.deepEqual(reconfirmedSnapshot.data.state.interruptionNotice,noticeContract);
  current.deferTurnAck=true;const submission=post('turn',{message:newMessage},signed.cookie);submission.catch(()=>{});await waitUntil(()=>current.pendingTurnAck!==null,'held native turn ack');
  const beforeAck=await status();observations.noticeBeforeLegalAck=beforeAck.interruptionNotice;assert.deepEqual(beforeAck.interruptionNotice,noticeContract);
  current.releaseTurnAck();assert.equal((await submission).status,202);assert.equal((await status()).interruptionNotice,null);
  for(;;){const event=await secondStream.next();assert.ok(event);const view=event.event==='state'?event.data:event.event==='conversation'?event.data.state:null;if(view?.interruptionNotice===null)break;}
  observations.steps.push('notice_retained_until_legal_new_turn_ack_then_cleared_in_http_sse');
  old.send({method:'item/agentMessage/delta',params:{threadId:old.threadId,turnId:old.turnId,itemId:'late-old-answer',delta:lateText}});
  old.send({method:'turn/completed',params:{threadId:old.threadId,turnId:old.turnId,turn:{id:old.turnId,status:'completed'}}});
  const beforeReply=app.snapshot('customer-isolation');assert.equal(beforeReply.busy,true);assert.equal(beforeReply.session.messages.some(message=>message.text.includes(lateText)),false);
  current.send({method:'item/agentMessage/delta',params:{threadId:current.threadId,turnId:current.turnId,itemId:'recovered-answer',delta:'recovered reply'}});
  current.send({method:'item/completed',params:{threadId:current.threadId,turnId:current.turnId,item:{id:'recovered-answer',type:'agentMessage',text:'recovered reply'}}});
  current.send({method:'turn/completed',params:{threadId:current.threadId,turnId:current.turnId,turn:{id:current.turnId,status:'completed'}}});
  let finalConversation,terminal;for(;;){const event=await secondStream.next();assert.ok(event);if(event.event==='conversation')finalConversation=event.data;if(event.event==='done'){terminal=event.data;break;}}
  assert.equal(terminal.status,'completed');assert.equal(finalConversation.busy,false);assert.equal(finalConversation.session.messages.filter(message=>message.role==='assistant').at(-1).text,'recovered reply');assert.equal(JSON.stringify(finalConversation).includes(lateText),false);
  let sent=nativeTimeline.filter(item=>item.event==='rpc'&&item.method==='turn/start');assert.deepEqual(sent.map(item=>item.text),[oldMessage,newMessage]);assert.deepEqual(sent.map(item=>item.child),[1,2]);assert.notEqual(sent[0].threadId,sent[1].threadId);observations.steps.push('explicit_new_turn_only_and_late_old_notifications_ignored');
  assert.equal((await post('turn',{message:privacyMessage},signed.cookie)).status,202);current.send({method:'item/agentMessage/delta',params:{threadId:current.threadId,turnId:current.turnId,itemId:'private-answer',delta:'private account-a partial reply'}});current.eof();await secondStream.drain();await delay(20);
  const beforeSwitch=await status();observations.privacyFault={nativeChildren:nativeChildren.length,endCalls:current.endCalls,closeEvents:current.closeEvents,interruptionNotice:beforeSwitch.interruptionNotice};assert.equal(beforeSwitch.busy,false);assert.deepEqual(beforeSwitch.interruptionNotice,noticeContract);assert.equal(nativeChildren.length,2);assert.equal(current.endCalls,0);assert.equal(current.closeEvents,0);assert.equal(codex.child,current);const privateStream=await openStream(origin,signed.cookie),privateSnapshot=await privateStream.next();assert.deepEqual(privateSnapshot.data.state.interruptionNotice,noticeContract);
  assert.equal((await post('account/sign-out',{},signed.cookie)).status,200);assert.equal((await status(signed.cookie)).interruptionNotice,null);
  const signedB=await post('account/sign-in',{email:otherUser.email,password:'fixture-password'});assert.equal(signedB.status,200);assert.notEqual(signedB.cookie,signed.cookie);
  const statusB=await status(signedB.cookie);assert.equal(statusB.account.user.id,otherUser.id);assert.equal(statusB.interruptionNotice,null);assert.equal((await status(signed.cookie)).interruptionNotice,null);
  const otherStream=await openStream(origin,signedB.cookie),otherSnapshot=await otherStream.next();assert.equal(otherSnapshot.event,'snapshot');assert.equal(otherSnapshot.data.state.interruptionNotice,null);
  for(const content of [oldMessage,newMessage,privacyMessage,lateText,'private account-a partial reply'])assert.equal(JSON.stringify(otherSnapshot.data).includes(content),false);
  const staleSse=await fetch(origin+'/api/events?client=customer-isolation',{headers:{Cookie:signed.cookie},signal:AbortSignal.timeout(5000)});const staleCode=staleSse.status;await staleSse.body.cancel();assert.equal(staleCode,401);
  sent=nativeTimeline.filter(item=>item.event==='rpc'&&item.method==='turn/start');assert.deepEqual(sent.map(item=>item.text),[oldMessage,newMessage,privacyMessage]);assert.deepEqual(sent.map(item=>item.child),[1,2,2]);assert.notEqual(sent[1].turnId,sent[2].turnId);
  observations.accountChangePrivacy={noticePresentBeforeLogout:true,oldCookieNoticeAfterLogout:null,otherAccountNotice:null,oldCookieSseStatus:staleCode,oldContentAbsentInOtherSnapshot:true};observations.steps.push('second_notice_cleared_on_logout_and_isolated_from_other_account');
  const stopping=await post('stop-service',{},signedB.cookie);assert.equal(stopping.status,202);closeResult=await app.close();assert.deepEqual(closeResult,{closed:true});for(const owner of streams)if(!owner.ended)await owner.drain();
  assert.ok(nativeChildren.every(child=>child.closeEvents===1&&child.killCalls===0));assert.equal(app.server.listening,false);assert.deepEqual(loaded().sort(),[...requiredUrls].sort());assert.equal(realSpawnAttempts,0);assert.equal(foreignFetchAttempts,0);
  observations.steps.push('confirmed_final_close_and_sse_eof');observations.oldCloseBeforeNewSpawn=true;observations.nativeTurnStarts=sent;observations.streams=streams.map(owner=>({ended:owner.ended,frames:owner.frames,bytes:owner.bytes}));flowPassed=true;
  finalResult={ok:true,scenario:'recovery-notice',productionModules:loaded().length,actualCodexProcesses:0,cloudRequests:0,modelOperations:0,uiOperations:0,fakeNativeChildren:nativeChildren.length,nativeCloseEvents:nativeChildren.reduce((n,child)=>n+child.closeEvents,0),nativeTurnStarts:sent.length,oldCloseBeforeNewSpawn:true,oldConversationVisibleAfterFault:observations.afterFault.oldContentVisible,unknownMessageVisibleAfterFault:observations.afterFault.unknownMessageVisible,noticeVisibleInHttpAndSnapshot:true,noticeClearedOnlyAfterLegalAck:true,accountNoticeIsolated:true,closeResult,sseEnded:streams.every(owner=>owner.ended)};
}finally{
  for(const child of nativeChildren)if(child.holdClose&&!child.closeEvents){nativeEvent('fixture_cleanup_close',child);child.holdClose=false;child.confirmClose();}
  for(const owner of streams){clearTimeout(owner.timer);if(!owner.ended)owner.controller.abort();try{await owner.reader.cancel();}catch{}owner.reader.releaseLock();}
  if(!closeResult)await app.close();await saveTrace();
  observations.streams=streams.map(owner=>({ended:owner.ended,frames:owner.frames,bytes:owner.bytes,events:owner.events.map(event=>({event:event.event,...(['snapshot','conversation'].includes(event.event)?{interruptionNotice:event.data.state?.interruptionNotice,ready:event.data.state?.ready,busy:event.data.busy}:event.event==='state'?{interruptionNotice:event.data.interruptionNotice,ready:event.data.ready,busy:event.data.busy}:{status:event.data.status??null})}))}));
  observations.workerMetrics=workerMetrics();
  await fs.writeFile(path.join(harnessRoot,'workflow-trace.json'),JSON.stringify({...observations,flowPassed,nativeRpcMethods:nativeMessages.filter(value=>value.method).map(value=>value.method),fakeNativeChildren:nativeChildren.map(child=>({index:child.index,threadId:child.threadId,turnId:child.turnId,closeEvents:child.closeEvents,endCalls:child.endCalls,killCalls:child.killCalls}))},null,2)+'\n');
}
if(flowPassed)console.log(JSON.stringify({...finalResult,workerMetrics:observations.workerMetrics}));
`;

const missingConfiguration=guard+String.raw`
const childProcess=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');
let spawnCalls=0;
childProcess.default.spawn=()=>{spawnCalls++;throw new Error('Unexpected real process start');};
childProcess.default.spawnSync=()=>{spawnCalls++;throw new Error('Unexpected real process start');};
syncBuiltinESMExports();
globalThis.fetch=()=>{throw new Error('Network is forbidden in the missing-configuration fixture');};
for(const name of ['BUILDX_MODE','BUILDX_SUPABASE_URL','BUILDX_SUPABASE_PUBLISHABLE_KEY'])assert.equal(Object.hasOwn(process.env,name),false);
await importComponent('customer-server.mjs');
assert.equal(process.exitCode,1);assert.equal(spawnCalls,0);assert.deepEqual(loaded().sort(),[...requiredUrls].sort());
await assert.rejects(fs.stat(path.join(root,'runtime')),{code:'ENOENT'});await saveTrace();
console.log(JSON.stringify({ok:true,productionModules:loaded().length,missingConfigExitCode:process.exitCode,realSpawnCalls:spawnCalls,runtimeCreated:false,serviceStarted:false,cloudRequests:0}));
`;

async function runChild({componentRoot,harnessRoot,names,required,scenario}){
  const env={...process.env};for(const name of ['BUILDX_MODE','BUILDX_SUPABASE_URL','BUILDX_SUPABASE_PUBLISHABLE_KEY','NODE_OPTIONS'])delete env[name];
  const started=process.hrtime.bigint(),child=spawn(process.execPath,[path.join(harnessRoot,'runner.mjs'),componentRoot,JSON.stringify(names),JSON.stringify(required),scenario],{cwd:harnessRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const record={pid:child.pid??null,closeObserved:false,exitCode:null,signal:null,terminationRequested:false,spawnError:null};ownedChildren.set(child,record);
  const stdout=[],stderr=[];let stdoutBytes=0,stderrBytes=0,problem=null,settle;
  const closePromise=new Promise(resolve=>{settle=resolve;});
  const stop=reason=>{problem??=reason;if(!record.closeObserved){record.terminationRequested=true;try{child.kill();}catch{problem??='OWNED_KILL_FAILED';}}};
  child.on('error',error=>{record.spawnError=error.code??error.name;problem??='SPAWN_ERROR';});
  child.stdout.on('data',chunk=>{stdoutBytes+=chunk.byteLength;if(stdoutBytes>256*1024)stop('STDOUT_LIMIT');else stdout.push(chunk);});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.byteLength;if(stderrBytes>32*1024)stop('STDERR_LIMIT');else stderr.push(chunk);});
  child.once('close',(code,signal)=>{record.closeObserved=true;record.exitCode=code;record.signal=signal;record.elapsedMs=Number(process.hrtime.bigint()-started)/1e6;ownedChildren.delete(child);settle();});
  let timer;try{await Promise.race([closePromise,new Promise(resolve=>{timer=setTimeout(()=>{stop('DEADLINE');resolve();},15000);})]);}finally{clearTimeout(timer);}
  if(!record.closeObserved){let cleanup;try{await Promise.race([closePromise,new Promise(resolve=>{cleanup=setTimeout(resolve,3000);})]);}finally{clearTimeout(cleanup);}}
  return {record,problem,stdout:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)),stderr:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stderr))};
}

function outsideComponent(componentRoot,directory){
  assert.equal(typeof componentRoot,'string');assert.equal(path.isAbsolute(componentRoot),true);
  assert.equal(typeof directory,'string');assert.equal(path.isAbsolute(directory),true);
  const relative=path.relative(componentRoot,directory);
  assert.ok(relative!==''&&(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)),'Test harness and evidence must be outside the component');
}

export async function stageCustomerChatSources({sourceRoot,componentRoot,entry=false}){
  assert.equal(path.isAbsolute(sourceRoot),true);assert.equal(path.isAbsolute(componentRoot),true);
  await fs.mkdir(componentRoot,{recursive:true});for(const name of ['lib','prompts','public'])await fs.mkdir(path.join(componentRoot,name));
  const selected=entry?[...CUSTOMER_MODULES,'panel-audit.mjs']:CUSTOMER_MODULES;
  const names=[...selected.map(name=>'lib/'+name),'prompts/buildx-customer-chat.zh-CN.md',...CUSTOMER_ASSETS.map(name=>'public/'+name),...(entry?['customer-server.mjs']:[])],records=[];
  for(const name of names){const bytes=await fs.readFile(path.join(sourceRoot,...name.split('/')));await fs.writeFile(path.join(componentRoot,...name.split('/')),bytes,{flag:'wx'});records.push({path:name,sha256:hash(bytes),byteLength:bytes.byteLength});}
  return records;
}

// Independent full-tree digest, including directories. Unexpected runtime,
// trace, fixture and even empty directories therefore change this observation.
export async function snapshotCustomerComponent(componentRoot){
  assert.equal(path.isAbsolute(componentRoot),true);const records=[];let entries=0,totalBytes=0;
  const walk=async relative=>{
    const absolute=path.join(componentRoot,...relative.split('/').filter(Boolean)),metadata=await fs.lstat(absolute);
    assert.equal(metadata.isSymbolicLink(),false);assert.equal(metadata.isDirectory(),true);assert.equal(path.resolve(await fs.realpath(absolute)),path.resolve(absolute));
    records.push({path:relative,kind:'directory'});const directory=await fs.opendir(absolute,{bufferSize:1});
    try{for(;;){const item=await directory.read();if(item===null)break;assert.ok(++entries<=128,'Component tree budget exceeded');const name=relative?relative+'/'+item.name:item.name;
      if(item.isDirectory()){await walk(name);continue;}
      const file=path.join(componentRoot,...name.split('/')),before=await fs.lstat(file,{bigint:true});assert.equal(before.isSymbolicLink(),false);assert.equal(before.isFile(),true);assert.equal(before.nlink,1n);assert.ok(before.size<=2n*1024n*1024n);
      const bytes=await fs.readFile(file),after=await fs.lstat(file,{bigint:true});assert.equal(BigInt(bytes.byteLength),before.size);for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(after[key],before[key]);
      totalBytes+=bytes.byteLength;assert.ok(totalBytes<=8*1024*1024);records.push({path:name,kind:'file',byteLength:bytes.byteLength,sha256:hash(bytes)});
    }}finally{await directory.close();}
  };
  await walk('');return records.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
}

// A runner lives beside (never within) the component. Its resolver permits only
// the fourteen production modules; a chat loads twelve and the entry loads all.
export async function runCustomerChatFixture({componentRoot,harnessRoot,evidenceRoot,entry=false,scenario='happy'}){
  assert.ok(['happy','recovery'].includes(scenario));assert.ok(!entry||scenario==='happy');
  componentRoot=path.resolve(componentRoot);outsideComponent(componentRoot,harnessRoot);outsideComponent(componentRoot,evidenceRoot);
  await fs.mkdir(harnessRoot,{recursive:true});await fs.mkdir(evidenceRoot,{recursive:true});
  const required=entry?CUSTOMER_COMPONENT_MODULE_PATHS:CUSTOMER_MODULES.map(name=>'lib/'+name);let execution=null,result=null,passed=false;
  try{
    await fs.writeFile(path.join(harnessRoot,'runner.mjs'),entry?missingConfiguration:scenario==='recovery'?recovery:workflow,{flag:'wx'});
    if(!entry)await fs.writeFile(path.join(harnessRoot,'forbidden.mjs'),"import fs from 'node:fs/promises'; await fs.writeFile(new URL('./forbidden-ran',import.meta.url),'unexpected');",{flag:'wx'});
    execution=await runChild({componentRoot,harnessRoot,names:CUSTOMER_COMPONENT_MODULE_PATHS,required,scenario});
    await fs.writeFile(path.join(evidenceRoot,'child-stdout.json'),execution.stdout);await fs.writeFile(path.join(evidenceRoot,'child-stderr.txt'),execution.stderr);
    assert.equal(execution.record.closeObserved,true);assert.equal(execution.problem,null);assert.equal(execution.record.terminationRequested,false);assert.equal(execution.record.signal,null);assert.equal(execution.record.exitCode,entry?1:0,execution.stderr);
    result=JSON.parse(execution.stdout.trim());assert.equal(result.ok,true);assert.equal(result.productionModules,entry?CUSTOMER_COMPONENT_MODULE_PATHS.length:CUSTOMER_MODULES.length);
    if(entry){assert.equal(result.realSpawnCalls,0);assert.equal(result.runtimeCreated,false);assert.equal(result.serviceStarted,false);}
    else{assert.deepEqual(result.closeResult,{closed:true});assert.equal(result.sseEnded,true);assert.equal(result.nativeCloseEvents,scenario==='recovery'?2:1);}
    await fs.copyFile(path.join(harnessRoot,'import-trace.json'),path.join(evidenceRoot,'import-trace.json'));passed=true;
    return {record:execution.record,result};
  }finally{
    const traceCopyIssues=[];for(const name of ['workflow-trace.json','import-trace.json'])try{await fs.copyFile(path.join(harnessRoot,name),path.join(evidenceRoot,name));}catch(error){if(error.code!=='ENOENT')traceCopyIssues.push({file:name,code:error.code??error.name});}
    await fs.writeFile(path.join(evidenceRoot,'fixture-summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),entry,scenario,passed,componentRoot,harnessRoot,child:execution?.record??null,problem:execution?.problem??null,result,retainedOwnedChildren:ownedChildren.size,traceCopyIssues,actualCodexOrCloudOrRevitOrUI:false},null,2)+'\n');
  }
}

