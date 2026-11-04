// Test-only: execute the actual customer entry. All upstream Auth/native calls
// are controlled fixtures; the sole real listener is remapped to owned port 0.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import http from 'node:http';
import {syncBuiltinESMExports,registerHooks,isBuiltin} from 'node:module';

const [componentRoot,base,evidence,scenario,allowedJson]=process.argv.slice(2);
assert.ok(['happy','missing-data-root','overlap','missing-workspace','junction','invalid-home','snapshot-swap'].includes(scenario));
const started=process.hrtime.bigint(),cpuStart=process.cpuUsage();
const expectedWorkspace=path.join(base,'data','workspace'),codeHome=path.join(base,'codex-home');
const expectedRuntime=path.join(base,'data','runtime','customer-chat');
const allowed=new Set(JSON.parse(allowedJson).map(name=>pathToFileURL(path.join(componentRoot,...name.split('/'))).href)),resolved=[];
registerHooks({resolve(specifier,context,nextResolve){
  const value=nextResolve(specifier,context);
  if(isBuiltin(value.url)||value.url.startsWith('node:'))return value;
  assert.ok(allowed.has(value.url),'Production import outside staged component');resolved.push(value.url);return value;
}});
const trace={scenario,listenCalls:0,nativeLaunches:[],pythonReads:0,nativeMethods:[],nativeCloseEvents:0,nativeEndCalls:0,nativeKillCalls:0,foreignNetworkCalls:0,authPaths:[],entryOutputs:[],openedAuditFiles:0,confirmedAuditCloses:0,sseEnded:false,sseCompleted:false};
const originalRealpath=fsSync.realpathSync;
if(scenario==='snapshot-swap')fsSync.realpathSync=function(target,...args){
  const answer=originalRealpath.call(fsSync,target,...args);
  if(!trace.snapshotSwapApplied&&path.resolve(String(target))===expectedWorkspace){
    fsSync.renameSync(path.join(base,'data'),path.join(base,'displaced-data'));
    fsSync.mkdirSync(path.join(base,'data'));fsSync.mkdirSync(expectedWorkspace);
    trace.snapshotSwapApplied=true;
  }
  return answer;
};
let server=null,origin=null,child=null,reader=null,streamController=null;
const originalListen=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args){
  trace.listenCalls++;assert.equal(args[0],41875);assert.equal(args[1],'127.0.0.1');server=this;
  if(scenario!=='happy'){queueMicrotask(()=>this.emit('error',Object.assign(new Error('Fixture listener refused'),{code:'EADDRINUSE'})));return this;}
  args[0]=0;return originalListen.apply(this,args);
};
const originalLog=console.log;
console.log=(value,...more)=>{assert.equal(more.length,0);const parsed=JSON.parse(value);trace.entryOutputs.push(parsed);};
childProcess.spawn=(executable,args,options)=>{
  assert.equal(scenario,'happy');assert.equal(options.cwd,expectedWorkspace);assert.equal(executable,path.join(base,'tools','codex.exe'));
  trace.nativeLaunches.push({cwd:options.cwd,args});
  const native=new EventEmitter();child=native;native.stdout=new EventEmitter();native.stderr=new EventEmitter();native.stdin=new EventEmitter();native.stdin.writable=true;
  native.send=value=>native.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
  native.stdin.write=(line,callback)=>{
    const request=JSON.parse(line);if(request.method)trace.nativeMethods.push(request.method);
    queueMicrotask(()=>{
      callback?.();if(request.id===undefined)return;
      let result={};
      if(request.method==='account/read'){assert.deepEqual(request.params,{refreshToken:false});result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}};}
      else if(request.method==='thread/start'){
        assert.equal(request.params.cwd,expectedWorkspace);assert.equal(request.params.sandbox,'read-only');assert.equal(request.params.approvalPolicy,'never');
        trace.threadCwd=request.params.cwd;trace.promptSha256=createHash('sha256').update(request.params.developerInstructions).digest('hex');result={thread:{id:'entry-data-thread'}};
      }else if(request.method==='mcpServerStatus/list')result={data:[],nextCursor:null};
      else if(request.method==='turn/start'){assert.equal(request.params.input[0].text,'entry external data fixture message');result={turn:{id:'entry-data-turn'}};}
      else assert.equal(request.method,'initialize');
      native.send({id:request.id,result});
    });return true;
  };
  native.stdin.end=()=>{trace.nativeEndCalls++;queueMicrotask(()=>{if(native.closed)return;native.closed=true;trace.nativeCloseEvents++;native.emit('exit',0,null);native.emit('close',0,null);});};
  native.kill=()=>{trace.nativeKillCalls++;throw new Error('Test native must close naturally');};return native;
};
childProcess.spawnSync=(executable,args)=>{
  assert.equal(scenario,'happy');assert.equal(executable,path.join(base,'tools','python.exe'));assert.equal(args[2],path.join(codeHome,'config.toml'));trace.pythonReads++;
  return {status:0,stdout:JSON.stringify(['revit_local','buildx_source']),stderr:''};
};
syncBuiltinESMExports();
const fetchLocal=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://abcdefghijklmnopqrst.supabase.co'){
    assert.equal(scenario,'happy');trace.authPaths.push(url.pathname);
    if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='password')return Promise.resolve(Response.json({access_token:'controlled-fixture-access',refresh_token:'controlled-fixture-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600}));
    if(url.pathname==='/auth/v1/user')return Promise.resolve(Response.json({id:'11111111-1111-1111-1111-111111111111',email:'entry-fixture@example.invalid'}));
    if(url.pathname==='/auth/v1/logout')return Promise.resolve(new Response(null,{status:204}));
    throw new Error('Unexpected controlled Auth route');
  }
  if(origin&&url.origin===origin)return fetchLocal(input,options);
  trace.foreignNetworkCalls++;throw new Error('Foreign network forbidden');
};
const originalOpen=fs.open;
fs.open=async function(filename,...args){
  const h=await originalOpen.call(fs,filename,...args),p=path.resolve(String(filename));
  if(p.startsWith(expectedRuntime+path.sep)||p.startsWith(path.join(componentRoot,'runtime')+path.sep)){
    trace.openedAuditFiles++;const close=h.close.bind(h);let done=false;
    h.close=async()=>{const value=await close();if(!done){done=true;trace.confirmedAuditCloses++;}return value;};
  }
  return h;
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label){const deadline=Date.now()+3000;while(!await predicate()){if(Date.now()>=deadline)throw new Error('Timeout: '+label);await pause(5);}}
async function inspectRuntime(){
  const exists=async p=>{try{return (await fs.lstat(p)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;return false;}};
  trace.componentRuntimeCreated=await exists(path.join(componentRoot,'runtime'));
  trace.dataRuntimeCreated=await exists(expectedRuntime);trace.runDirectories=[];trace.lifecycleCodes=[];
  if(trace.dataRuntimeCreated){
    const items=await fs.readdir(expectedRuntime,{withFileTypes:true});assert.ok(items.length<=2);
    for(const item of items)if(item.isDirectory()){assert.match(item.name,/^run-[0-9a-f-]{36}$/);trace.runDirectories.push(item.name);}
    if(trace.runDirectories.length===1){
      const text=await fs.readFile(path.join(expectedRuntime,trace.runDirectories[0],'lifecycle.jsonl'),'utf8');trace.lifecycleCodes=text.trim().split('\n').map(line=>JSON.parse(line).code);
    }
  }
}
let passed=false,imported=false,closeObserved=false,problem=null;
try{
  await import(pathToFileURL(path.join(componentRoot,'customer-server.mjs')).href);imported=true;
  if(scenario==='happy'){
    assert.equal(process.exitCode??0,0);assert.equal(trace.entryOutputs.length,1);origin=trace.entryOutputs[0].origin;assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const first=await(await fetch(origin+'/api/status',{signal:AbortSignal.timeout(3000)})).json();
    const post=async(route,input={},cookie)=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':first.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'entry-data-client',...input}),signal:AbortSignal.timeout(3000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
    const html=await fetch(origin+'/',{signal:AbortSignal.timeout(3000)});assert.equal(await html.text(),await fs.readFile(path.join(componentRoot,'public/index.html'),'utf8'));trace.resourcesFromComponent=true;
    await until(async()=>(await(await fetch(origin+'/api/status',{signal:AbortSignal.timeout(3000)})).json()).codexConnectionReady,'native ready');
    assert.equal((await post('turn',{message:'blocked anonymous'})).status,401);
    const signed=await post('account/sign-in',{email:'entry-fixture@example.invalid',password:'controlled-fixture-password'});assert.equal(signed.status,200);assert.ok(signed.cookie);
    assert.equal((await post('turn',{message:'blocked unconfirmed'},signed.cookie)).status,403);
    const inspected=await post('codex-account/inspect',{},signed.cookie);assert.equal(inspected.status,200);assert.equal((await post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie)).status,200);trace.explicitConfirmation=true;
    streamController=new AbortController();const response=await fetch(origin+'/api/events?client=entry-data-client',{headers:{Cookie:signed.cookie},signal:streamController.signal});assert.equal(response.status,200);reader=response.body.getReader();
    const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
    const next=async()=>{for(;;){const end=text.indexOf('\n\n');if(end>=0){const raw=text.slice(0,end);text=text.slice(end+2);if(!raw.startsWith('event: '))continue;return {event:raw.slice(7,raw.indexOf('\n')),data:JSON.parse(raw.slice(raw.indexOf('data: ')+6))};}const value=await reader.read();if(value.done){decoder.decode();trace.sseEnded=true;return null;}bytes+=value.value.byteLength;assert.ok(bytes<=256*1024);text+=decoder.decode(value.value,{stream:true});}};
    assert.equal((await next()).event,'snapshot');assert.equal((await post('turn',{message:'entry external data fixture message'},signed.cookie)).status,202);
    child.send({method:'item/agentMessage/delta',params:{threadId:'entry-data-thread',turnId:'entry-data-turn',itemId:'entry-data-answer',delta:'entry data routed reply'}});
    child.send({method:'item/completed',params:{threadId:'entry-data-thread',turnId:'entry-data-turn',item:{id:'entry-data-answer',type:'agentMessage',text:'entry data routed reply'}}});
    child.send({method:'turn/completed',params:{threadId:'entry-data-thread',turnId:'entry-data-turn',turn:{id:'entry-data-turn',status:'completed'}}});
    let conversation=null;
    for(;;){const event=await next();assert.ok(event);if(event.event==='conversation')conversation=event.data;if(event.event==='done'){assert.equal(event.data.status,'completed');trace.sseCompleted=true;break;}}
    assert.ok(conversation);assert.equal(conversation.session.messages.length,2);assert.equal(conversation.session.messages.at(-1).text,'entry data routed reply');trace.canonicalMessages=2;
    assert.equal(trace.promptSha256,createHash('sha256').update(await fs.readFile(path.join(componentRoot,'prompts/buildx-customer-chat.zh-CN.md'))).digest('hex'));
    assert.equal((await post('stop-service',{},signed.cookie)).status,202);
    while(!trace.sseEnded)await next();await until(()=>!server.listening&&trace.nativeCloseEvents===1,'server/native closed');
    await assert.rejects(fetch(origin+'/api/status',{signal:AbortSignal.timeout(1000)}));closeObserved=true;
    assert.equal(trace.nativeMethods.filter(x=>x==='turn/start').length,1);assert.equal(trace.nativeKillCalls,0);assert.equal(trace.nativeEndCalls,1);assert.equal(trace.pythonReads,1);assert.equal(trace.nativeLaunches.length,1);
    const overrides=trace.nativeLaunches[0].args.filter((_,i,a)=>a[i-1]==='-c');for(const key of ['revit_local','buildx_source'])assert.ok(overrides.includes('mcp_servers.'+key+'.enabled=false'));
  }else{
    assert.equal(process.exitCode,1);assert.equal(trace.listenCalls,0,'Rejected data-root input must fail before any listener');
    assert.equal(trace.nativeLaunches.length,0);assert.equal(trace.pythonReads,0);assert.equal(trace.authPaths.length,0);assert.equal(trace.openedAuditFiles,0);closeObserved=true;
  }
  await inspectRuntime();
  assert.equal(trace.componentRuntimeCreated,false,'Customer entry must never create runtime inside release');
  if(scenario==='happy'){assert.equal(trace.runDirectories.length,1);assert.ok(trace.lifecycleCodes.includes('service_started'));}
  else assert.equal(trace.runDirectories.length,0);
  assert.equal(trace.openedAuditFiles,trace.confirmedAuditCloses);assert.equal(trace.foreignNetworkCalls,0);
  passed=true;
}catch(error){problem={code:error.code??error.name,message:String(error.message??'Entry fixture failed').slice(0,1200)};throw error;}
finally{
  if(reader){if(!trace.sseEnded)streamController.abort();try{await reader.cancel();}catch{}reader.releaseLock();}
  if(server?.listening){process.emit('SIGTERM');await until(()=>!server.listening,'error-path signal cleanup');}
  fs.open=originalOpen;console.log=originalLog;
  fsSync.realpathSync=originalRealpath;
  if(!passed)try{await inspectRuntime();}catch{}
  trace.entryImported=imported;trace.entryExitCode=process.exitCode??0;trace.productionModules=[...new Set(resolved)].sort();trace.exactModuleGraph=JSON.stringify(trace.productionModules)===JSON.stringify([...allowed].sort());trace.passed=passed;trace.closeObserved=closeObserved;trace.problem=problem;
  const cpu=process.cpuUsage(cpuStart),usage=process.resourceUsage();trace.metrics={wallMs:Number(process.hrtime.bigint()-started)/1e6,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimeMaxRssKiB:usage.maxRSS,scope:'runner Node only, not native/process family or developer task',tokens:null};
  await fs.writeFile(path.join(evidence,'runner-summary.json'),JSON.stringify(trace,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(trace)+'\n');
}
