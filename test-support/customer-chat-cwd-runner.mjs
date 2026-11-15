// Executed only by tests/customer-chat-cwd.test.mjs in its own Node process. Native
// executables, Auth and upstream responses are fixtures; no actual Codex runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports,registerHooks,isBuiltin} from 'node:module';

const [componentRoot,base,evidence,scenario,allowedModuleNames]=process.argv.slice(2);
assert.ok(['routing','invalid-code-home'].includes(scenario));
const started=process.hrtime.bigint(),cpuStarted=process.cpuUsage();
const resourceRoot=componentRoot,workspace=path.join(base,'workspace');
const codexExe=path.join(base,'tools','codex.exe'),pythonExe=path.join(base,'tools','python.exe');
const codeHome=path.join(base,'codex-home'),trace={scenario,pythonReads:[],nativeLaunches:[],nativeRpc:[],closeEvents:0,endCalls:0,killCalls:0,authCalls:[],realNativeProcesses:0,externalNetworkCalls:0};
let ownedOrigin=null,app=null,nativeChild=null,passed=false;
const permitted=new Set(JSON.parse(allowedModuleNames).map(name=>pathToFileURL(path.join(componentRoot,'lib',name)).href)),resolved=[];
registerHooks({resolve(specifier,context,nextResolve){
  const value=nextResolve(specifier,context);
  if(isBuiltin(value.url)||value.url.startsWith('node:'))return value;
  if(!permitted.has(value.url)){const error=new Error('Module is outside the selected customer component');error.code='CUSTOMER_IMPORT_SCOPE';throw error;}
  resolved.push(value.url);return value;
}});
const nativeSpawn=(executable,args,options)=>{
  assert.equal(executable,codexExe);assert.equal(options.cwd,workspace);
  assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
  trace.nativeLaunches.push({executable,args,cwd:options.cwd,windowsHide:options.windowsHide,stdio:options.stdio});
  const child=new EventEmitter();nativeChild=child;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;
  child.send=value=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
  child.finish=()=>{if(child.closed)return;child.closed=true;trace.closeEvents++;child.emit('exit',0,null);child.emit('close',0,null);};
  child.stdin.write=(line,callback)=>{
    const request=JSON.parse(line);trace.nativeRpc.push(request);
    queueMicrotask(()=>{
      callback?.();if(request.id===undefined)return;
      let result;
      if(request.method==='initialize')result={};
      else if(request.method==='account/read'){assert.deepEqual(request.params,{refreshToken:false});result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}};}
      else if(request.method==='thread/start'){
        assert.equal(request.params.cwd,workspace);assert.equal(request.params.approvalPolicy,'never');assert.equal(request.params.sandbox,'read-only');assert.equal(request.params.ephemeral,true);
        result={thread:{id:'layout-thread'}};
      }else if(request.method==='mcpServerStatus/list'){
        assert.deepEqual(request.params,{threadId:'layout-thread',detail:'toolsAndAuthOnly',limit:100});result={data:[],nextCursor:null};
      }else if(request.method==='turn/start')result={turn:{id:'layout-turn'}};
      else assert.fail('Unexpected native fixture method: '+request.method);
      child.send({id:request.id,result});
    });return true;
  };
  child.stdin.end=()=>{trace.endCalls++;queueMicrotask(child.finish);};
  child.kill=()=>{trace.killCalls++;throw new Error('Native fixture must finish through exact close');};
  return child;
};
childProcess.spawn=nativeSpawn;
childProcess.spawnSync=(executable,args,options)=>{
  assert.equal(executable,pythonExe);assert.equal(args[0],'-c');assert.equal(args[2],path.join(codeHome,'config.toml'));
  assert.equal(options.windowsHide,true);assert.equal(options.timeout,10000);
  trace.pythonReads.push({executable,configPath:args[2]});
  return {status:0,stdout:JSON.stringify(['revit_local','buildx_source','other']),stderr:''};
};
syncBuiltinESMExports();
const realFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const address=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!ownedOrigin||address.origin!==ownedOrigin){trace.externalNetworkCalls++;throw new Error('Only the owned loopback fixture origin is allowed');}
  return realFetch(input,options);
};
const user={id:'layout-buildx-user',email:'layout@example.invalid'},sessionId='layout-fixture-session-00000001';
const session=()=>({sessionId,user,expiresAt:Date.now()+3600000});
const auth={
  async signIn(){trace.authCalls.push('signIn');return {ok:true,value:session()};},
  async signUp(){assert.fail('No signup in this fixture');},
  async verifySession(id){assert.equal(id,sessionId);trace.authCalls.push('verifySession');return {ok:true,value:session()};},
  async refresh(){assert.fail('No refresh in this fixture');},
  async signOut(){assert.fail('No signout in this fixture');},
  release(id){assert.equal(id,sessionId);trace.authCalls.push('release');},
  async close(){trace.authCalls.push('close');return {ok:true,value:{closed:true}};},
};

try{
  const {createCustomerChatServer}=await import(pathToFileURL(path.join(componentRoot,'lib/customer-chat.mjs')).href);
  if(scenario==='invalid-code-home'){
    for(const value of ['relative-codex-home','','\\config','/config']){
      process.env.CODEX_HOME=value;let unexpected=null;
      try{
        assert.throws(()=>{unexpected=createCustomerChatServer({root:resourceRoot,codexCwd:workspace,accountAuth:auth,port:0});},/CODEX_HOME/);
      }finally{if(unexpected)assert.deepEqual(await unexpected.close(),{closed:true});}
    }
    assert.equal(trace.pythonReads.length,0);assert.equal(trace.nativeLaunches.length,0);
    trace.rejectedCodeHomes=['relative','empty','drive-root-relative-backslash','drive-root-relative-slash'];passed=true;
  }else{
    assert.equal(process.env.CODEX_HOME,codeHome);
    // Deliberately no injected Codex: this covers the default factory routing.
    app=createCustomerChatServer({root:resourceRoot,codexCwd:workspace,accountAuth:auth,port:0});
    const address=await app.listen();ownedOrigin=address.origin;
    const html=await fetch(ownedOrigin+'/',{signal:AbortSignal.timeout(5000)});
    assert.equal(html.status,200);assert.equal(await html.text(),await fs.readFile(path.join(resourceRoot,'public/index.html'),'utf8'));
    await app.connect();
    const status=async cookie=>{
      const response=await fetch(ownedOrigin+'/api/status',{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);return response.json();
    };
    const first=await status();assert.equal(first.codexConnectionReady,true);assert.equal(first.ready,false);assert.equal(first.toolCount,0);assert.deepEqual(first.toolCatalog,[]);
    const post=async(route,input,cookie)=>{
      const response=await fetch(ownedOrigin+'/api/'+route,{method:'POST',headers:{Origin:ownedOrigin,'Content-Type':'application/json','X-Local-Chat':first.csrf,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({client:'layout-browser',...input}),signal:AbortSignal.timeout(5000)});
      return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    };
    assert.equal((await post('turn',{message:'blocked without login'})).status,401);
    const signed=await post('account/sign-in',{email:user.email,password:'layout-fixture-password'});assert.equal(signed.status,200);assert.ok(signed.cookie);
    assert.equal((await status(signed.cookie)).ready,false);
    assert.equal((await post('turn',{message:'blocked before confirmation'},signed.cookie)).status,403);
    assert.equal(trace.nativeRpc.filter(item=>item.method==='turn/start').length,0);
    const inspected=await post('codex-account/inspect',{},signed.cookie);assert.equal(inspected.status,200);
    assert.equal((await post('codex-account/confirm',{challengeId:inspected.body.challengeId},signed.cookie)).status,200);
    assert.equal((await status(signed.cookie)).ready,true);
    const submitted=await post('turn',{message:'layout explicit message'},signed.cookie);assert.equal(submitted.status,202);
    const thread=trace.nativeRpc.find(item=>item.method==='thread/start');assert.ok(thread);
    const sourcePrompt=await fs.readFile(path.join(componentRoot,'prompts/buildx-customer-chat.zh-CN.md'),'utf8');
    assert.equal(thread.params.developerInstructions,sourcePrompt);assert.equal(sourcePrompt.includes('workspace-fake-prompt'),false);
    assert.equal(trace.nativeLaunches.length,1);assert.equal(trace.pythonReads.length,1);
    const argumentsList=trace.nativeLaunches[0].args,overrides=[];for(let i=0;i<argumentsList.length;i++)if(argumentsList[i]==='-c')overrides.push(argumentsList[++i]);
    for(const service of ['revit_local','buildx_source','other'])assert.ok(overrides.includes('mcp_servers.'+service+'.enabled=false'));
    assert.ok(overrides.includes('features.shell_tool=false'));assert.ok(overrides.includes('features.code_mode_host=false'));
    nativeChild.send({method:'item/agentMessage/delta',params:{threadId:'layout-thread',turnId:'layout-turn',itemId:'layout-answer',delta:'layout routed reply'}});
    nativeChild.send({method:'item/completed',params:{threadId:'layout-thread',turnId:'layout-turn',item:{id:'layout-answer',type:'agentMessage',text:'layout routed reply'}}});
    nativeChild.send({method:'turn/completed',params:{threadId:'layout-thread',turnId:'layout-turn',turn:{id:'layout-turn',status:'completed'}}});
    const completed=app.snapshot('layout-browser');assert.equal(completed.busy,false);assert.equal(completed.session.messages.at(-1).text,'layout routed reply');
    trace.defaultFactoryRouting={resourceRoot,nativeCwd:trace.nativeLaunches[0].cwd,threadCwd:thread.params.cwd,promptFromModuleUrl:true,oneExplicitTurn:true};
    assert.deepEqual(await app.close(),{closed:true});assert.equal(app.server.listening,false);app=null;
    assert.equal(trace.closeEvents,1);assert.equal(trace.endCalls,1);assert.equal(trace.killCalls,0);passed=true;
  }
  assert.deepEqual([...new Set(resolved)].sort(),[...permitted].sort());
}catch(error){
  passed=false;trace.problem={code:error.code??error.name,message:String(error.message??'Fixture failed').slice(0,2048)};throw error;
}finally{
  if(app){assert.deepEqual(await app.close(),{closed:true});app=null;}
  const cpu=process.cpuUsage(cpuStarted),usage=process.resourceUsage();
  trace.productionModules=[...new Set(resolved)];
  trace.passed=passed;trace.workerMetrics={wallMs:Number(process.hrtime.bigint()-started)/1e6,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimePeakRssKiB:usage.maxRSS,scope:'worker-only; wall/CPU after builtin imports through cleanup, lifetime RSS high water',processFamilyPeakMemory:null,tokens:null};
  await fs.writeFile(path.join(evidence,'workflow-trace.json'),JSON.stringify(trace,null,2)+'\n');
}
console.log(JSON.stringify({ok:passed,scenario,...(scenario==='routing'?{defaultFactoryRouting:trace.defaultFactoryRouting}:{rejectedCodeHomes:trace.rejectedCodeHomes}),productionModules:trace.productionModules,nativeLaunches:trace.nativeLaunches.length,pythonReads:trace.pythonReads.length,closeEvents:trace.closeEvents,realNativeProcesses:0,externalNetworkCalls:trace.externalNetworkCalls,workerMetrics:trace.workerMetrics}));
