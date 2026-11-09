import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {readlink,mkdtemp,mkdir,rm,writeFile,readFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexClientCore} from './lib/codex-client-core.mjs';
import {createManagedCodexRuntime} from './lib/managed-codex-runtime.mjs';
import {createServerApiGateway} from './lib/server-api-gateway.mjs';
import {openManagedInferenceLedger} from './lib/managed-inference-ledger.mjs';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';
import {createManagedInferenceTurns} from './lib/managed-inference-turns.mjs';
import {createManagedInferenceGrantRoute} from './lib/managed-inference-grant-route.mjs';
import {createBuildxAuth} from './lib/buildx-auth.mjs';
import {createManagedPanelInferenceForAccount} from './lib/managed-panel-inference.mjs';
import {createPanelServerCore} from './lib/panel-server-core.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import {panelProfile} from './lib/panel-profile.mjs';
import {createModelWorkspaceSessionProfile,MANAGED_WORKBENCH_PILOT_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {MANAGED_WORKBENCH_DYNAMIC_TOOL} from './lib/managed-workbench-reads.mjs';
import {createManagedWorkbenchFixture} from './test-support/managed-inference-workbench.mjs';
import {createNativeByoBackend,createNativeByoClients} from './test-support/managed-inference-native-byo.mjs';
import {FixtureCodex} from './test-support/selection-preview-fixture.mjs';

function events(sequence,tool,args={},answer='probe complete'){
  const callingTool=Boolean(tool);
  const argumentsJson=JSON.stringify(args);
  const result=[];const emit=(type,payload)=>result.push(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  const item=callingTool?{id:'fc_probe_'+sequence,type:'function_call',status:'completed',call_id:'call_probe_'+sequence,...tool,arguments:argumentsJson}:{id:'msg_probe',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_probe_'+sequence,object:'response',created_at:1730000000,status:'completed',model:'gpt-5.1',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  emit('response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}});
  emit('response.output_item.added',{type:'response.output_item.added',output_index:0,item:callingTool?{...item,status:'in_progress',arguments:''}:{...item,status:'in_progress',content:[]}});
  if(callingTool){emit('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:argumentsJson});emit('response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:argumentsJson});}
  else{emit('response.content_part.added',{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:answer});emit('response.output_text.done',{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:answer});emit('response.content_part.done',{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
  emit('response.output_item.done',{type:'response.output_item.done',output_index:0,item});emit('response.completed',{type:'response.completed',response});return result.join('');
}

function findTool(request,name){
  const tools=request.tools??[];
  const namespace=tools.find(tool=>tool.type==='namespace'&&tool.tools?.some(entry=>entry.name===name));
  const direct=tools.find(tool=>tool.type==='function'&&(tool.name===name||tool.name?.endsWith('__'+name)));
  assert.ok(namespace||direct,`Fixture tool ${name} is present in the request`);
  return namespace?{name,namespace:namespace.name}:{name:direct.name};
}

function toolOutput(request,sequence){
  const result=request.input.find(item=>item.type==='function_call_output'&&item.call_id==='call_probe_'+sequence);
  const output=result?.output;
  // Codex wraps MCP function output in a timing header before the payload.
  if(typeof output==='string')return JSON.parse(output.match(/\nOutput:\r?\n([\s\S]+)$/)?.[1]??output);
  assert.equal(output?.length,1,'Codex returned one tool output item');
  assert.equal(output[0].type,'input_text');
  return JSON.parse(output[0].text);
}

function fixtureStream(text){
  const parts=text.split(/(?=event: )/);
  return new ReadableStream({
    async pull(controller){
      const part=parts.shift();
      if(part===undefined){controller.close();return;}
      await new Promise(resolve=>setTimeout(resolve,3));
      controller.enqueue(new TextEncoder().encode(part));
    }
  });
}

const codexExecutable=process.env.BUILDX_ISOLATED_CODEX_EXE;
const probeOptions={timeout:60000,skip:!codexExecutable};
test('Linux Codex managed relay captures synthetic tool and image egress and settles four usage records',probeOptions,t=>runProbe(t));
test('Linux Codex managed MCP sends an opaque document reference and reduced receipts through the relay',probeOptions,t=>runProbe(t,'mcp'));
test('Linux Codex panel owns managed dynamic reads and settles their four streamed requests',probeOptions,t=>runProbe(t,'panel'));
test('Linux Codex panel checks the original late receipt before retiring the managed connection',probeOptions,t=>runProbe(t,'panel-timeout'));
test('Linux Codex managed pilot rejects a direct raw MCP tool call',probeOptions,t=>runProbe(t,'panel-raw-denial'));
test('Linux Codex managed pilot round trip preserves the original receipt and SSE across simulated BYO switches',
  probeOptions,t=>runProbe(t,'panel-round-trip'));
test('Linux Codex runs both modes with synthetic ChatGPT auth and separates their inference paths',
  {...probeOptions,timeout:90000},t=>runProbe(t,'panel-native-byo'));

async function runProbe(t,mode='raw'){
  const nativeByo=mode==='panel-native-byo';
  const roundTrip=mode==='panel-round-trip'||nativeByo;
  const managed=mode!=='raw',lateReceipt=mode==='panel-timeout'||roundTrip,rawDenial=mode==='panel-raw-denial';
  const panelMode=mode==='panel'||lateReceipt||rawDenial;
  const expectedRequests=rawDenial?2:lateReceipt?3:4;
  // Refuse to run unless the entire process tree inherits an isolated network.
  assert.equal(process.platform,'linux');assert.equal(process.env.WSL_INTEROP,undefined);
  assert.ok(path.isAbsolute(codexExecutable));
  assert.match(process.env.BUILDX_PARENT_NET || '', /^net:\[\d+\]$/);assert.notEqual(await readlink('/proc/self/ns/net'),process.env.BUILDX_PARENT_NET);
  const interfaces=execFileSync('/usr/sbin/ip',['-o','link','show'],{encoding:'utf8'}).trim().split('\n');assert.equal(interfaces.length,1);assert.match(interfaces[0],/^1: lo:/);assert.match(interfaces[0],/UP/);
  assert.equal(execFileSync('/usr/sbin/ip',['route','show','default'],{encoding:'utf8'}).trim(),'');
  const dir=await mkdtemp(path.join(os.tmpdir(),'buildx-managed-codex-'));await mkdir(path.join(dir,'codex-home'));
  const workbench=managed?await createManagedWorkbenchFixture(dir,{holdSelectionReceipt:lateReceipt}):null;
  const cwd=path.join(dir,'session');await mkdir(cwd);
  const projectInstruction='fixture-parent-project-instruction-must-stay-local';
  if(panelMode){
    await mkdir(path.join(dir,'.git'));
    await writeFile(path.join(dir,'AGENTS.md'),projectInstruction);
    await writeFile(path.join(cwd,'AGENTS.md'),'fixture-original-workspace-instruction');
  }
  const fixtureDocumentPath='D:\\fixture-private-root\\fixture-model-file.rvt';
  const imagePath=path.join(dir,'fixture-private-attachment.png');
  if(!managed)await writeFile(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=','base64'));
  t.diagnostic(execFileSync(codexExecutable,['--version'],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir},encoding:'utf8'}).trim());
  const accountId=panelMode?'11111111-1111-1111-1111-111111111111':'fixture-user';
  const sessionId='fixture-cloud-session',model='gpt-5.1';
  const identity={verified:true,accountId,sessionId,expiresAt:Date.now()+60000};
  const byoBackend=nativeByo?createNativeByoBackend({streamForTurn:sequence=>
    fixtureStream(events(sequence,null,{},'fixture BYO reply '+(sequence===1?'before':'after')))}):null;
  const turns=createManagedInferenceTurns({identityOwner:Object.freeze({
    authenticate:({accessToken})=>accessToken==='fixture-login'?identity:null,
    verifySession:request=>request.sessionId===sessionId&&request.accountId===accountId?identity:null
  })});
  let turnId,finishedTurnId,panel,managedInference,panelConnection,local,retirementVerified=false;
  let openedTurns=0;
  const ledger=openManagedInferenceLedger({filename:path.join(dir,'usage.sqlite'),reserveCredits:()=>8,creditsForUsage:({totalTokens})=>totalTokens});
  ledger.grantTrial({accountId,expiresAt:Date.now()+60000,credits:100});
  const requests=[],completedTools=new Set(),workspaces=[];
  const statusTool=managed?'revit_workbench_status':'fixture_echo';
  const selectionTool=managed?'revit_get_selection':'fixture_get_selection';
  let dynamicInvoked=false,deltas='',documentRef,changedDocument,upstreamFailure;
  const grantOwner=createManagedInferenceGrants({model,resolveTurn:turns.resolveTurn});
  const turnOwner=panelMode?Object.freeze({
    async open(input){
      const result=await turns.open(input);
      if(result){turnId=result.turnId;openedTurns++;}
      return result;
    },
    async finish(input){
      const closed=await turns.finish(input);
      if(closed)finishedTurnId=input.turnId;
      return closed;
    }
  }):turns;
  const grantRoute=createManagedInferenceGrantRoute({identityOwner:turns.identityOwner,grantOwner,turnOwner});
  function respond(init){
    const request=JSON.parse(Buffer.from(init.body));
    requests.push(request);
    const step=requests.length;
    assert.ok(step<=expectedRequests,'unexpected inference request');
    if(panelMode){
      assert.deepEqual(request.tools?.map(tool=>[tool.type,tool.name]),[['function',MANAGED_WORKBENCH_DYNAMIC_TOOL.name]]);
      const serialized=JSON.stringify(request);
      if(roundTrip)assert.equal(serialized.includes('fixture BYO'),false,'BYO conversation text stays local');
      assert.equal(serialized.includes(dir),false,'the temporary local root stays on the client');
      assert.equal(serialized.includes('<skills_instructions>'),false,'the native skill catalog stays on the client');
      assert.equal(serialized.includes(projectInstruction),false,'ancestor project instruction stays on the client');
      assert.equal(serialized.includes('fixture-original-workspace-instruction'),false,'original workspace instruction stays on the client');
      const context=request.input.find(item=>item.role==='user')?.content?.[0]?.text;
      assert.ok(context?.includes('<cwd>[BuildX managed workspace]</cwd>'),'the automatically generated cwd is projected');
      assert.ok(context?.includes('<workspace_roots><root>[BuildX managed workspace]</root></workspace_roots>'),
        'the automatically generated workspace root is projected');
    }
    if(rawDenial)return new Response(fixtureStream(events(step,step===1?{name:'mcp__revit_workbench__'+statusTool}:null)),{headers:{'content-type':'text/event-stream'}});
    const wireTool=name=>findTool(request,panelMode?MANAGED_WORKBENCH_DYNAMIC_TOOL.name:name);
    let tool,args;
    if(step===1)tool=wireTool(statusTool);
    if(step===2){
      tool=wireTool(selectionTool);
      if(managed){
        const status=toolOutput(request,1);
        documentRef=status.documentRef;
        assert.match(documentRef,/^[a-f0-9-]{36}$/);
        assert.deepEqual(status,{documentOpen:true,documentRef});
      }
      args=managed?{document_ref:documentRef}:{expected_document:fixtureDocumentPath};
    }
    if(step===3&&!lateReceipt){
      if(managed){
        changedDocument=workbench.changeDocument();
        tool=wireTool(selectionTool);
        args={document_ref:documentRef};
      }else tool=findTool(request,'buildx_fixture_probe');
    }
    if(panelMode&&tool)args={tool:step===1?statusTool:selectionTool,parameters:args??{}};
    return new Response(fixtureStream(events(step,tool,args)),{headers:{'content-type':'text/event-stream'}});
  }
  const gateway=createServerApiGateway({upstreamBaseUrl:'https://provider.example/v1',apiKey:'upstream-fixture-key',
    authorizationOwner:grantOwner.authorizationOwner,accountingOwner:ledger.accountingOwner,
    fetchImpl:async(_url,init)=>{
      try{return respond(init);}
      catch(error){upstreamFailure=error;throw error;}
    }});
  const server=http.createServer((req,res)=>{
    if(byoBackend?.handle(req,res))return;
    void (req.url==='/v1/responses'?gateway.handle(req,res):grantRoute.handle(req,res));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const cloudRequest=(endpoint,body,signal)=>fetch(base+'/v1/managed/'+endpoint,{
    method:'POST',headers:{authorization:'Bearer fixture-login','content-type':'application/json'},
    body:JSON.stringify(body),signal
  });
  const factory=createManagedCodexRuntime({
    model,codexHome:path.join(dir,'codex-home'),
    workbenchPilot:panelMode,
    getCloudAuthorization:async({signal})=>{
      if(panelMode)return managedInference.getCloudAuthorization({signal});
      const response=await cloudRequest('grants',{turnId},signal);
      const grant=await response.json();
      return response.ok?grant:null;
    },
    testOnly:{url:base+'/v1/responses',fetch}
  });
  const names=Object.freeze(panelMode?[]:[statusTool,selectionTool]);let verified=false,childExited=false,relayOrigin;
  const dynamicTools=Object.freeze([Object.freeze({type:'function',name:'buildx_fixture_probe',description:'Returns a synthetic error receipt',
    inputSchema:Object.freeze({type:'object',properties:Object.freeze({}),additionalProperties:false})})]);
  const lifecycle=[];
  const mcpArgs=managed?[workbench.entry,'--managed-readonly']:
    [fileURLToPath(new URL('./test-support/managed-inference-echo-mcp.mjs',import.meta.url)),fixtureDocumentPath];
  const profile=panelMode?MANAGED_WORKBENCH_PILOT_PROFILE:Object.freeze({id:'model-workspace',service:'fixture-codex',mode:'document-workbench',toolNames:names,
    ...(!managed?{dynamicTools,supportsTurnAttachments:true}:{}),
    groups:Object.freeze([Object.freeze({name:'fixture',toolNames:names,statusTimeout:10000,failFast:true})]),
    clientInfo:Object.freeze({name:'buildx_fixture',version:'0.1'}),
    buildLaunchArgs:()=>['app-server','--listen','stdio://','--strict-config','-c','features.shell_tool=false','-c','web_search="disabled"',
      '-c','mcp_servers.fixture.enabled=true','-c',`mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
      '-c',`mcp_servers.fixture.args=${JSON.stringify(mcpArgs)}`],
    buildInstructions:()=> 'Run the fixture probes.',connectingTools:'checking',catalogFailed:'failed',catalogNotReady:'not ready',
    verifiedDiagnostic:'verified',denialMessage:'denied',verifyWholeCatalog:c=>{
      verified=names.every(name=>Boolean(c?.data?.[0]?.tools?.[name]));
      return {ok:verified};
    }});
  const client=new CodexClientCore(cwd,profile,{apiProviderFactory:factory,spawn:(cmd,args,opts)=>{
    childExited=false;
    if(panelMode){
      assert.equal(path.basename(opts.cwd),'workspace');
      assert.notEqual(opts.cwd,cwd);
      assert.notEqual(opts.cwd,opts.env.CODEX_HOME);
      assert.equal(path.dirname(opts.cwd),path.dirname(opts.env.CODEX_HOME));
      workspaces.push(opts.cwd);
    }
    if(lateReceipt){
      const baseArg=args.find(arg=>/^model_providers\.buildx_managed_[a-f0-9]+\.base_url=/.test(arg));
      assert.ok(baseArg);
      const relay=new URL(JSON.parse(baseArg.slice(baseArg.indexOf('=')+1)));
      assert.equal(relay.hostname,'127.0.0.1');
      relayOrigin=relay.origin;
    }
    const child=spawn(cmd,args,{...opts,env:{...opts.env,HOME:dir,TMPDIR:dir}});
    child.on('close',()=>childExited=true);
    return child;
  },resolveRuntimes:()=>({codex:codexExecutable,python:'unused'}),closeTimeoutMs:2500,killTimeoutMs:1000});
  client.on('diagnostic',data=>{
    if(data.code==='codex_lifecycle'||data.code==='codex_exit')lifecycle.push(data);
    if(panelMode&&data.code===profile.verifiedDiagnostic)verified=data.count===0;
  });
  if(!managed)client.on('dynamic-tool-request',call=>{
    dynamicInvoked=call.respond({success:false,contentItems:[{type:'inputText',text:JSON.stringify({
      ok:false,error:{code:'FIXTURE_REJECTED',path:'D:\\fixture-private-root\\fixture-visual-receipt.png'}
    })}]});
  });
  async function closeOwnedChild(){
    try { return await client.close(); }
    catch(error){
      assert.equal(error.code,'CODEX_CLEANUP_UNCONFIRMED');
      await assert.rejects(client.start(),{code:'CODEX_CLEANUP_REQUIRED'});
      t.diagnostic('The first shutdown window did not confirm close; retrying cleanup of the same child.');
      return client.close();
    }
  }
  try{
    if(panelMode){
      ({panel,managedInference,local}=await createProbePanel({client,workbench,accountId,base,model,lateReceipt,roundTrip,dir,byoBackend}));
    }else{
      const opened=await cloudRequest('turns/open',{});
      assert.equal(opened.status,200);
      ({turnId}=await opened.json());
    }
    let finish,reject;const turnDone=new Promise((resolve,fail)=>{finish=resolve;reject=fail;});
    void turnDone.catch(()=>{});
    client.on('notification',(method,params)=>{
      if(method==='item/completed'&&params?.item?.type==='mcpToolCall')completedTools.add(params.item.tool);
      if(method==='item/agentMessage/delta')deltas+=params?.delta??'';
      if(method==='turn/completed')params?.turn?.status==='completed'?finish():reject(new Error('turn incomplete'));
    });
    if(panelMode){
      if(!roundTrip)await client.start();
      if(nativeByo){
        await local.original.start();
        assert.equal(local.original.state.toolCount,local.original.profile.toolNames.length);
      }
      panelConnection=await connectProbePanel(panel,nativeByo?60000:25000);
      if(roundTrip){
        assert.equal((await panelConnection.status()).inferenceMode,'local-codex');
        await assertLocalProbeTurn(panelConnection,local.original,'before',byoBackend);
        assert.equal(openedTurns,0);
        assert.deepEqual(requests,[]);
        assert.equal(ledger.balance(accountId).available,100);
        assert.deepEqual(workspaces,[]);
        const before=panel.snapshot('real-codex-panel').session;
        if(nativeByo){
          await switchNativeProbeMode(t,panel,panelConnection,before.conversation.id,'local-codex','buildx-managed');
          assert.equal(local.exited(local.original),true);
        }else{
          assert.deepEqual(await panel.retireInferenceMode(),{closed:true});
          assert.equal(local.original.closed,true);
          assert.deepEqual(await panel.activateInferenceMode('buildx-managed'),{activated:true,mode:'buildx-managed'});
        }
        const managedStatus=await panelConnection.status();
        assert.equal(managedStatus.inferenceMode,'buildx-managed');
        assert.equal(managedStatus.managedInferenceReady,true);
        assert.equal(managedStatus.account.user.id,accountId);
        const after=panel.snapshot('real-codex-panel').session;
        assert.equal(after.conversation.id,before.conversation.id);
        assert.deepEqual(after.messages,before.messages);
      }
      assert.equal(verified,true);
      await submitProbePanelTurn(panelConnection);
      if(!lateReceipt)panelConnection.abort();
    }
    else{
      await client.start();assert.equal(verified,true);
      const thread=await client.newThread();
      await client.turn(thread,'Run the fixture probes.',managed?[]:[{type:'localImage',path:imagePath}]);
    }
    let timer;try{await Promise.race([turnDone,new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error('turn timed out')),25000);})]);}finally{clearTimeout(timer);}
    assert.deepEqual([...completedTools],names);
    assert.equal(dynamicInvoked,!managed);
    assert.equal(requests.length,expectedRequests);
    if(rawDenial){
      const rejection=requests[1].input.find(item=>item.type==='function_call_output'&&item.call_id==='call_probe_1');
      assert.match(JSON.stringify(rejection?.output??null),/unsupported|not found|unknown|unavailable|not available/i);
      assert.equal(workbench.requests.size,0);
    }else if(lateReceipt)await assertManagedLateReceipt(requests,workbench,panel,documentRef,client);
    else if(managed)await assertManagedWorkbenchRequests(requests,workbench,documentRef,changedDocument,panelMode);
    else assertRawRequests(t,requests,cwd,imagePath,fixtureDocumentPath);
    assert.equal(deltas,'probe complete');
    const records=()=>ledger.requestsForTurn(accountId,turnId);
    for(let n=0;records().filter(x=>x.state==='settled').length<expectedRequests&&n<50;n++)await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(records().map(x=>[x.state,x.input_tokens,x.output_tokens,x.charged]),Array.from({length:expectedRequests},()=>['settled',1,1,2]));
    assert.equal(new Set(records().map(x=>x.request_id)).size,expectedRequests);
    assert.equal(ledger.balance(accountId).available,100-2*expectedRequests);
    if(panelMode){
      for(let n=0;finishedTurnId===undefined&&n<50;n++)await new Promise(r=>setTimeout(r,20));
      assert.equal(typeof turnId,'string');
      assert.equal(finishedTurnId,turnId);
      assert.ok(panel.snapshot('real-codex-panel').session.messages.some(message=>message.text==='probe complete'));
    }else{
      const finished=await cloudRequest('turns/finish',{turnId});
      assert.equal(finished.status,200);
      assert.deepEqual(await finished.json(),{closed:true});
    }
    if(lateReceipt){
      const beforeNativeSwitch=nativeByo?panel.snapshot('real-codex-panel').session:null;
      if(nativeByo)
        await switchNativeProbeMode(t,panel,panelConnection,beforeNativeSwitch.conversation.id,'buildx-managed','local-codex');
      else await assertProbeRetirement(t,{panel,panelConnection,client,accountId});
      assert.equal(childExited,true);
      await assert.rejects(fetch(relayOrigin,{signal:AbortSignal.timeout(2000)}),error=>error.cause?.code==='ECONNREFUSED');
      retirementVerified=true;
      await assert.rejects(access(workspaces[0]),{code:'ENOENT'});
      if(roundTrip){
        const before=beforeNativeSwitch??panel.snapshot('real-codex-panel').session;
        assert.equal(before.toolReceipts?.length,1);
        if(!nativeByo)assert.deepEqual(await panel.activateInferenceMode('local-codex'),{activated:true,mode:'local-codex'});
        const localStatus=await panelConnection.status();
        assert.equal(localStatus.inferenceMode,'local-codex');
        assert.equal(localStatus.account.user.id,accountId);
        assert.equal(localStatus.codexConfirmation.localConnectionConfirmed,false);
        const after=panel.snapshot('real-codex-panel').session;
        assert.equal(after.conversation.id,before.conversation.id);
        assert.deepEqual(after.messages,before.messages);
        assert.deepEqual(after.toolReceipts,before.toolReceipts);
        if(nativeByo)assert.equal(local.returned.state.toolCount,local.returned.profile.toolNames.length);
        await assertLocalProbeTurn(panelConnection,local.returned,'after',byoBackend);
        assert.deepEqual(panel.snapshot('real-codex-panel').session.toolReceipts,before.toolReceipts);
        assert.equal(ledger.balance(accountId).available,94);
        assert.equal(openedTurns,1);
        assert.equal(workspaces.length,1);
        assert.equal(finishedTurnId,turnId);
        if(nativeByo){
          assert.equal(byoBackend.requests.length,2);
          assert.ok(byoBackend.accountChecks>=2);
          for(const [index,label] of ['before','after'].entries()){
            const request=byoBackend.requests[index];
            assert.equal(request.model,model);
            const serialized=JSON.stringify(request);
            assert.ok(serialized.includes('fixture BYO transcript '+label));
            assert.equal(serialized.includes('Run the fixture probes.'),false);
          }
        }
      }
    }else{
      const first=client.state;
      assert.equal((await closeOwnedChild()).closed,true);
      await client.start();
      assert.equal(client.state.ready,true);
      assert.ok(client.state.connectionGeneration>first.connectionGeneration);
      assert.notEqual(client.state.codexAccount.providerRevision,first.codexAccount.providerRevision);
      if(panelMode){
        assert.equal(new Set(workspaces).size,2);
        await assert.rejects(access(workspaces[0]),{code:'ENOENT'});
        await access(workspaces[1]);
      }
      assert.equal((await closeOwnedChild()).closed,true);
      if(panelMode)await assert.rejects(access(workspaces[1]),{code:'ENOENT'});
    }
    assert.equal(requests.length,expectedRequests);
  }catch(error){
    t.diagnostic(JSON.stringify({requests:requests.length,tools:[...completedTools],lifecycle,
      ...(byoBackend?{byoRequests:byoBackend.requests.length,byoAccountChecks:byoBackend.accountChecks,
        byoRoutes:byoBackend.routes}:{})}));
    throw upstreamFailure??error;
  }
  finally{
    panelConnection?.abort();
    if(!retirementVerified)await closeOwnedChild().catch(error=>t.diagnostic(error.code??'Fixture child cleanup failed'));
    try{
      if(panel){
        const closed=await panel.close();
        if(!closed.closed&&nativeByo)assert.deepEqual(await panel.close(),{closed:true});
        else assert.deepEqual(closed,{closed:true});
        if(nativeByo&&local?.returned.state.connectionGeneration>0)
          assert.equal(local.exited(local.returned),true);
      }
    }
    finally{
      grantRoute.close();grantOwner.close();turns.close();gateway.close();
      await new Promise(r=>server.close(r));
      ledger.close();
      await workbench?.close();
      const allByoClosed=!nativeByo||!local||[local.original,local.returned].every(peer=>
        peer.state.connectionGeneration===0||local.exited(peer));
      if((childExited||client.state.connectionGeneration===0)&&allByoClosed)await rm(dir,{recursive:true,force:true});
    }
  }
}

async function createProbePanel({client,workbench,accountId,base,model,lateReceipt,roundTrip,dir,byoBackend}){
  const fixtureOrigin='https://inference.example.test';
  const accountAuth=createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',
    inferenceGrantOrigin:fixtureOrigin,fetchImpl:async(url,options)=>{
      const target=new URL(url);
      if(target.origin===fixtureOrigin)return fetch(base+target.pathname,options);
      if(target.pathname.endsWith('/token'))return Response.json({
        access_token:'fixture-login',refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600
      });
      if(target.pathname.endsWith('/user'))return Response.json({id:accountId,email:'demo@example.invalid'});
      if(target.pathname.endsWith('/logout'))return new Response(null,{status:204});
      if(target.pathname.endsWith('/buildx_license_status'))return Response.json({status:'trial',startsAt:null,endsAt:null});
      throw new Error('Unexpected synthetic account route');
    }});
  const managedInference=createManagedPanelInferenceForAccount({accountAuth,isCurrent:({account,connection})=>{
    const state=client.state,provider=state.codexAccount;
    return account.verified===true&&account.userId===accountId&&state.ready===true&&provider?.type==='api_key'&&
      connection.generation===state.connectionGeneration&&connection.revision===provider.accountRevision&&
      connection.providerRevision===provider.providerRevision&&connection.model===model;
  }});
  const root=path.dirname(workbench.entry);
  const options={root,port:0,accountAuth,requireAccount:true,requireLicense:true,
    invokeWorkbench:()=>assert.fail('unexpected unscoped read'),readContextFailure:workbench.readContextFailure,
    ...(lateReceipt?{contextReceiptPollDelays:[0,25,50,100,200,400,800,1600]}:{}),
    invokeManagedWorkbenchRead:workbench.invokeManagedWorkbenchRead,audit:()=>{}};
  if(!roundTrip)return {panel:createPanelServerCore({...options,codex:client,managedInference,
    selection:panelProfile('model-workspace')}),managedInference};
  const trustedProfile=createModelWorkspaceSessionProfile(root);
  const simulatedLocal=(label,cold)=>{
    const codex=new FixtureCodex({profile:MODEL_WORKSPACE_SESSION_PROFILE,trustedProfile,cold,threadPrefix:'fixture-byo-'+label+'-'});
    codex.skillCatalogMode=client.skillCatalogMode;
    for(const method of ['listSkills','assertSkillSelection','configuredMcpCandidates','listModels','assertModelSelection','steer'])
      codex[method]=()=>assert.fail('unexpected BYO probe method '+method);
    return codex;
  };
  const local=byoBackend?await createNativeByoClients({dir,root,trustedProfile,codexExecutable,base,backend:byoBackend,model}):
    {original:simulatedLocal('before',false),returned:simulatedLocal('after',true)};
  const panel=createPanelServer({...options,codex:local.original,profile:MODEL_WORKSPACE_SESSION_PROFILE,
    managedWorkbenchPilotSwitch:true,inferenceModeFactory:mode=>mode==='buildx-managed'
      ?Object.freeze({codex:client,managedInference}):Object.freeze({codex:local.returned,managedInference:null})});
  return {panel,managedInference,local};
}

async function connectProbePanel(panel,eventTimeout){
  const {origin}=await panel.listen();
  const {csrf}=await fetch(origin+'/api/status').then(response=>response.json());
  const post=(route,input,cookie)=>fetch(origin+'/api/'+route,{
    method:'POST',headers:{Origin:origin,'X-Local-Chat':csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify({client:'real-codex-panel',...input}),signal:AbortSignal.timeout(10000)
  });
  const signed=await post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});
  assert.equal(signed.status,200);
  await signed.json();
  const cookie=signed.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const events=new AbortController();
  let stream;
  try{
    const live=await fetch(origin+'/api/events?client=real-codex-panel',{
      headers:{Cookie:cookie},signal:AbortSignal.any([events.signal,AbortSignal.timeout(eventTimeout)])
    });
    assert.equal(live.status,200);
    const frames=panelEventFrames(live.body);
    stream={frames,abort:()=>events.abort(),post:(route,body)=>post(route,body,cookie),
      status:()=>fetch(origin+'/api/status',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)}).then(response=>response.json())};
    return stream;
  }finally{if(!stream)events.abort();}
}

async function submitProbePanelTurn(connection){
  const sent=await connection.post('turn',{message:'Run the fixture probes.'});
  const result=await sent.json();
  assert.equal(sent.status,202,result.error);
  await readPanelEvent(connection.frames,event=>event.name==='conversation'&&event.data.session.messages.some(message=>
    message.role==='assistant'&&message.status==='streaming'&&message.text==='probe complete'));
}

async function switchNativeProbeMode(t,panel,connection,conversationId,expectedMode,mode){
  for(let n=0;!panel.inspectInferenceModeRetirement().ready&&n<100;n++)
    await new Promise(resolve=>setTimeout(resolve,20));
  const body={conversationId,expectedMode,mode};
  const request=async()=>{
    const response=await connection.post('inference-mode/switch',body);
    return {status:response.status,result:await response.json()};
  };
  let {status,result}=await request();
  if(status===409&&result.reason==='connection_cleanup_pending'&&result.phase==='retire'){
    t.diagnostic('HTTP switch waited for explicit cleanup of the original child.');
    ({status,result}=await request());
  }
  assert.equal(status,200,JSON.stringify(result));
  assert.deepEqual(result,{ok:true,mode});
}

async function assertLocalProbeTurn(connection,client,label,byoBackend){
  const message='fixture BYO transcript '+label;
  const blocked=await connection.post('turn',{message});
  assert.equal(blocked.status,403);await blocked.json();
  if(!byoBackend)assert.deepEqual(client.turns,[]);
  const inspected=await connection.post('codex-account/inspect',{});
  assert.equal(inspected.status,200);
  const {challengeId,display}=await inspected.json();
  if(byoBackend){
    assert.equal(display.type,'chatgpt');
    assert.equal(display.email,byoBackend.accountEmail);
  }
  const confirmed=await connection.post('codex-account/confirm',{challengeId});
  assert.equal(confirmed.status,200);await confirmed.json();
  const sent=await connection.post('turn',{message});
  assert.equal(sent.status,202);await sent.json();
  const reply='fixture BYO reply '+label;
  if(byoBackend){
    const currentAssistant=view=>view.session.messages.findLast(item=>item.role==='assistant');
    const observed=await readPanelEvent(connection.frames,event=>{
      if(event.name!=='conversation')return false;
      const item=currentAssistant(event.data);
      return item?.text===reply||['failed','unknown','interrupted'].includes(item?.status);
    });
    assert.equal(currentAssistant(observed).status,'streaming','the native BYO reply must stream before completion');
  }
  else{
    assert.equal(client.turns.length,1);
    client.finish(0,'completed',reply);
  }
  await readPanelEvent(connection.frames,event=>event.name==='conversation'&&event.data.session.messages.some(item=>
    item.role==='assistant'&&item.status==='completed'&&item.text===reply));
}

async function* panelEventFrames(body){
  let pending='';
  for await(const chunk of body.pipeThrough(new TextDecoderStream())){
    pending+=chunk;
    let end;
    while((end=pending.indexOf('\n\n'))>=0){
      const frame=pending.slice(0,end);
      pending=pending.slice(end+2);
      const data=frame.match(/^event: ([\w-]+)\ndata: (.+)$/);
      if(data)yield {name:data[1],data:JSON.parse(data[2])};
    }
  }
}

async function readPanelEvent(frames,matches){
  while(true){
    const {value,done}=await frames.next();
    assert.equal(done,false,'the original panel SSE connection is still open');
    if(matches(value))return value.data;
  }
}

async function assertProbeRetirement(t,{panel,panelConnection,client,accountId}){
  for(let n=0;!panel.inspectInferenceModeRetirement().ready&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(panel.inspectInferenceModeRetirement(),{mode:'buildx-managed',ready:true});
  const generation=client.state.connectionGeneration;
  const before=panel.snapshot('real-codex-panel').session;
  assert.ok(before.conversation.threadBinding.threadId);
  const retiring=panel.retireInferenceMode();
  const joined=panel.retireInferenceMode();
  assert.equal(joined,retiring);
  const interim=await readPanelEvent(panelConnection.frames,event=>event.name==='state'&&event.data.inferenceRetirement==='retiring');
  assert.equal(interim.ready,false);
  assert.equal(interim.account.user.id,accountId);
  const reconnect=await panelConnection.post('reconnect',{});
  assert.equal(reconnect.status,409);await reconnect.json();
  const sent=await panelConnection.post('turn',{message:'Must not reach the retired connection.'});
  assert.equal(sent.status,409);await sent.json();
  await panel.connect();

  const result=await retiring;
  if(!result.closed){
    assert.deepEqual(result,{closed:false,reason:'connection_cleanup_pending'});
    const pending=await panelConnection.status();
    assert.equal(pending.cleanupPending,true);
    assert.equal(pending.account.user.id,accountId);
    assert.equal(panel.snapshot('real-codex-panel').session.conversation.threadBinding.threadId,before.conversation.threadBinding.threadId);
    t.diagnostic('Retirement waited for explicit cleanup of the same Codex child.');
    assert.deepEqual(await panel.retireInferenceMode(),{closed:true});
  }
  const final=await readPanelEvent(panelConnection.frames,event=>event.name==='state'&&event.data.inferenceRetirement==='retired');
  assert.equal(final.cleanupPending,false);
  assert.equal(final.ready,false);
  assert.equal(client.state.connectionStatus,'closed');
  assert.equal(client.state.cleanupPending,false);
  assert.equal(client.state.connectionGeneration,generation);
  const status=await panelConnection.status();
  assert.equal(status.account.user.id,accountId);
  assert.equal(status.account.signedIn,true);
  const blocked=await panelConnection.post('turn',{message:'Retired connection remains blocked.'});
  assert.equal(blocked.status,409);await blocked.json();
  const after=panel.snapshot('real-codex-panel').session;
  assert.equal(after.conversation.id,before.conversation.id);
  assert.equal(after.conversation.threadBinding.threadId,null);
  assert.deepEqual(after.messages,before.messages);
  assert.deepEqual(after.toolReceipts,before.toolReceipts);
}

function assertRawRequests(t,requests,cwd,imagePath,fixtureDocumentPath){
    const serialized=requests.map(request=>JSON.stringify(request));
    const has=(index,marker)=>serialized[index].includes(marker);
    const inputLocations=marker=>requests[0].input.flatMap(item=>
      (item.content??[]).filter(part=>part.text?.includes(marker)).map(part=>[item.role,part.type]));
    t.diagnostic(JSON.stringify({
      workspacePath:has(0,cwd),workspacePathLocations:inputLocations(cwd),
      attachmentFilename:has(0,path.basename(imagePath)),attachmentPath:has(0,imagePath),
      attachmentPathLocations:inputLocations(imagePath),
      mcpText:has(1,'fixture-status-text'),mcpStructured:has(1,'fixture-status-structured'),mcpMeta:has(1,'fixture-status-meta')
    }));
    assert.ok(requests[0].input.some(item=>item.content?.some(part=>part.type==='input_image'&&part.image_url?.startsWith('data:image/'))));
    assert.equal(has(0,imagePath),true,'the initial request also contains the synthetic attachment path');
    assert.equal(has(0,cwd),true,'the initial request contains the synthetic workspace path');
    for(const marker of ['fixture-document-title','fixture-model-file.rvt','fixture-host-session','fixture-project-fingerprint']){
      assert.equal(has(0,marker),false,marker);
      assert.equal(has(1,marker),true,marker);
    }
    assert.equal(has(1,'fixture-status-structured'),true);
    const selectionCall=requests[2].input.find(item=>item.type==='function_call'&&item.call_id==='call_probe_2');
    assert.equal(JSON.parse(selectionCall?.arguments??'{}').expected_document,fixtureDocumentPath);
    assert.equal(has(2,'fixture-selection-document-matched'),true);
    assert.equal(has(3,'FIXTURE_REJECTED'),true);
    assert.equal(has(3,'fixture-visual-receipt.png'),true);
}

async function assertManagedWorkbenchRequests(requests,workbench,documentRef,changedDocument,panelMode){
  const serialized=JSON.stringify(requests);
  for(const marker of [workbench.session,workbench.receiptMarker,workbench.document.title,changedDocument.title,
    path.win32.basename(workbench.document.path),path.win32.basename(changedDocument.path),'expected_document',
    'DOCUMENT_MISMATCH',...workbench.requests.keys()]){
    assert.equal(serialized.includes(marker),false,marker);
  }
  for(const [index,sequence] of [[2,2],[3,3]]){
    const call=requests[index].input.find(item=>item.type==='function_call'&&item.call_id==='call_probe_'+sequence);
    const parameters={document_ref:documentRef};
    assert.deepEqual(JSON.parse(call?.arguments??'{}'),panelMode?{tool:'revit_get_selection',parameters}:parameters);
  }
  assert.deepEqual(toolOutput(requests[2],2),{elementIds:['42','9223372036854775807'],count:2,returned:2,truncated:false});
  assert.deepEqual(toolOutput(requests[3],3),{buildxToolOutcome:{schemaVersion:1,outcome:'not_started'}});
  const local=[...workbench.requests.values()];
  assert.deepEqual(local.map(({request})=>request.operation),['status','get_selection','get_selection']);
  for(const {request} of local.slice(1)){
    assert.deepEqual(request.args,{expected_document:workbench.document.path});
    assert.equal(request.targetSession,workbench.session);
  }
  assert.equal(local[1].receipt.ok,true);
  assert.equal(local[2].receipt.ok,false);
  for(const {request,receipt} of local.slice(1)){
    const original=await readFile(path.join(path.dirname(workbench.entry),'workbench','queue','outbox',request.id+'.json'),'utf8');
    assert.deepEqual(JSON.parse(original),receipt);
    assert.equal(original.includes(workbench.receiptMarker),true);
  }
}

async function assertManagedLateReceipt(requests,workbench,panel,documentRef,client){
  assert.deepEqual(toolOutput(requests[2],2),{buildxToolOutcome:{schemaVersion:1,outcome:'unconfirmed'}});
  const selectionCall=requests[2].input.find(item=>item.type==='function_call'&&item.call_id==='call_probe_2');
  assert.deepEqual(JSON.parse(selectionCall?.arguments??'{}'),{
    tool:'revit_get_selection',parameters:{document_ref:documentRef}
  });
  const local=[...workbench.requests.values()];
  assert.deepEqual(local.map(({request})=>request.operation),['status','get_selection']);
  const {request}=local[1];
  assert.deepEqual(request.args,{expected_document:workbench.document.path});
  assert.equal(request.targetSession,workbench.session);
  const serialized=JSON.stringify(requests);
  for(const marker of [workbench.document.title,path.win32.basename(workbench.document.path),workbench.session,
    workbench.receiptMarker,'expected_document',...workbench.requests.keys()]){
    assert.equal(serialized.includes(marker),false,marker);
  }
  const outbox=path.join(path.dirname(workbench.entry),'workbench','queue','outbox',request.id+'.json');
  await assert.rejects(readFile(outbox),{code:'ENOENT'});
  const snapshot=()=>panel.snapshot('real-codex-panel').session;
  const before=snapshot();
  const isUnknownSelection=item=>item.name==='revit_get_selection'&&item.status==='unknown';
  const assistant=before.messages.find(message=>message.role==='assistant'&&message.tools.some(isUnknownSelection));
  const tool=assistant?.tools.find(isUnknownSelection);
  assert.ok(tool,'the original panel turn has an unknown tool card');
  assert.equal(before.toolReceipts,undefined);
  assert.deepEqual(panel.inspectInferenceModeRetirement(),{mode:'buildx-managed',ready:false,reason:'receipt_pending'});
  assert.deepEqual(await panel.retireInferenceMode(),{closed:false,reason:'receipt_pending'});
  assert.equal(client.state.ready,true);
  workbench.releaseSelectionReceipt();
  for(let n=0;!snapshot().toolReceipts?.length&&n<150;n++)await new Promise(resolve=>setTimeout(resolve,20));
  const checked=snapshot().toolReceipts;
  assert.equal(checked?.length,1);
  const [{checkedAt,...receipt}]=checked;
  assert.deepEqual(receipt,{messageId:assistant.id,itemId:tool.id,requestId:request.id,status:'received'});
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
  assert.deepEqual(snapshot().messages,before.messages);
  const original=await readFile(outbox,'utf8');
  assert.equal(JSON.parse(original).id,request.id);
  assert.equal(original.includes(workbench.receiptMarker),true);
  assert.equal(workbench.requests.size,2);
}
