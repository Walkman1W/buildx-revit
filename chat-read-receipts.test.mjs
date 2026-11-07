import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createPanelChatStore} from './lib/chat-store.mjs';
import {CHAT_READ_RECEIPT_KEY_ENV,CHAT_READ_RECEIPT_META,CHAT_READ_RECEIPT_PATH,CHAT_READ_RECEIPT_PORT_ENV} from './lib/chat-read-receipts.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)),tool='revit_get_phases',hostSession='a'.repeat(32);
class Codex extends EventEmitter{
  constructor(){
    super();
    this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});
    this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:1}};
    this.turns=0;
  }
  async newThread(){return 'thread';}
  async turn(){this.turns++;return {turn:{id:'turn'}};}
  async close(){return {closed:true};}
  notify(method,params){this.emit('notification',method,{threadId:'thread',turnId:'turn',...params});}
}

async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-chat-read-receipt-'));
  const codex=new Codex(),key=randomBytes(32).toString('hex'),history=createPanelChatStore({stateDirectory:path.join(directory,'history')});
  const cleanup=[];
  const app=createPanelServer({root,codex,profile:MODEL_WORKSPACE_SESSION_PROFILE,port:0,
    historyStore:history,chatReadReceiptKey:key,invokeWorkbench:async()=>{throw new Error('Unexpected read');},...options});
  t.after(async()=>{for(const stop of cleanup)await stop();await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {origin,port}=await app.listen(),{csrf}=await (await fetch(origin+'/api/status')).json();
  async function post(route,value,headers={Origin:origin,'X-Local-Chat':csrf}){
    const response=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
    return {status:response.status,value:await response.json()};
  }
  return {app,codex,directory,history,key,port,post,cleanup};
}

async function openWorkspaceMcp(f){
  await fs.copyFile(path.join(root,'workbench-mcp.mjs'),path.join(f.directory,'workbench-mcp.mjs'));
  for(const name of ['lib','public','release'])await fs.cp(path.join(root,name),path.join(f.directory,name),{
    recursive:true,filter:async filename=>(await fs.lstat(filename)).isDirectory()||['.mjs','.json'].includes(path.extname(filename))
  });
  // The unchanged production MCP entry and transport execute the timeout
  // path without waiting for the 150-second production deadline in tests.
  const dispatch=path.join(f.directory,'lib','model-tool-dispatch.mjs');
  await fs.rename(dispatch,path.join(f.directory,'lib','controlled-model-tool-dispatch.mjs'));
  await fs.writeFile(dispatch,"import {invokeModelTool as real} from './controlled-model-tool-dispatch.mjs';\n"+
    'export const invokeModelTool=(name,args,options)=>real(name,args,{...options,timeout:30});\n');
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(f.directory,'workbench-mcp.mjs'),'--workspace'],
    cwd:f.directory,env:{...process.env,[CHAT_READ_RECEIPT_KEY_ENV]:f.key,[CHAT_READ_RECEIPT_PORT_ENV]:String(f.port)},stderr:'pipe'});
  transport.stderr.resume();
  const client=new Client({name:'buildx-chat-read-receipt-fixture',version:'1.0.0'},{capabilities:{}});
  f.cleanup.push(()=>client.close());
  await client.connect(transport);
  return client;
}

for(const status of ['expired','received'])test('the original MCP receipt becomes '+status+' without changing or replaying the Codex tool',async t=>{
  const f=await fixture(t),workbench=path.join(f.directory,'workbench'),queue=path.join(workbench,'queue');
  await Promise.all(['inbox','processing','outbox'].map(folder=>fs.mkdir(path.join(queue,folder),{recursive:true})));
  const capabilities={atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:['get_phases']};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:hostSession,pid:process.pid,version:'0.8.8',...capabilities}));
  const started=await f.post('/api/turn',{client:'test',message:'Read stages'});
  assert.equal(started.status,202);
  const mcp=await openWorkspaceMcp(f),result=await mcp.callTool({name:tool,arguments:{limit:1}},{timeout:5000});
  assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
  const proof=result._meta?.[CHAT_READ_RECEIPT_META];assert.ok(proof);
  const {requestId}=proof,filename=requestId+'.json';
  assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[filename]);
  const invalid={proof:{...proof,requestId:randomUUID()},status:'received'};
  assert.equal((await f.post(CHAT_READ_RECEIPT_PATH,{proof,status:'received'},{'X-BuildX-Read-Receipt-Key':randomBytes(32).toString('hex')})).status,403);
  assert.equal((await f.post(CHAT_READ_RECEIPT_PATH,{proof,status:'received'},{Origin:'http://localhost','X-BuildX-Read-Receipt-Key':f.key})).status,403);
  assert.equal((await f.post(CHAT_READ_RECEIPT_PATH,invalid,{'X-BuildX-Read-Receipt-Key':f.key})).status,409);
  // App-server v2 McpToolCallResult preserves the metadata and typed
  // structured content but does not expose the MCP isError field.
  const {isError:_mcpError,...appServerResult}=result;
  f.codex.notify('item/completed',{item:{type:'mcpToolCall',id:'untrusted',server:'other',tool,status:'failed',result:appServerResult}});
  f.codex.notify('item/completed',{item:{type:'mcpToolCall',id:'original',server:'revit_workbench',tool,status:'failed',result:appServerResult}});
  f.codex.notify('item/completed',{item:{type:'agentMessage',id:'reply',text:'Original Codex reply'}});
  f.codex.notify('turn/completed',{turn:{id:'turn',status:'completed'}});
  const original=f.app.snapshot('test').session;
  const assistant=original.messages.find(message=>message.role==='assistant');
  assert.equal(assistant.tools.find(item=>item.id==='original').status,'unknown');
  assert.equal(original.toolReceipts,undefined);
  assert.equal(JSON.stringify(original).includes(proof.signature),false);
  await fs.rename(path.join(queue,'inbox',filename),path.join(queue,'processing',filename));
  const document={title:'Controlled fixture model',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
  const originalResult=status==='expired'?{ok:false,hostSession,execution:{started:false,phase:'validation',reason:'expired'},
    error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Expired before dispatch'}}:{ok:true,result:{
    operation:'get_phases',hostSession,atomicReadSnapshot:true,
    snapshot:{hostSession,hostVersion:'0.8.8',document,capabilities},
    value:{hostSession,document:{title:document.title,path:document.path},operation:'get_phases',modifiedByOperation:false,
      value:{schema_version:1,items:[{id:'0',name:'Fixture phase'}],offset:0,limit:1,total:1,has_more:false,
        coverage:{scanned:1,complete:true,stop_reason:null}}}}};
  const outbox=path.join(queue,'outbox',filename);
  await fs.writeFile(outbox+'.tmp',JSON.stringify({id:requestId,completedUtc:new Date().toISOString(),...originalResult}));
  await fs.rename(outbox+'.tmp',outbox);
  let current;
  for(let i=0;i<160;i++){
    current=f.app.snapshot('test').session;
    if(current.toolReceipts?.length&&current.conversation.persistence?.status==='saved')break;
    await wait(20);
  }
  assert.equal(current.conversation.persistence.status,'saved');
  assert.deepEqual(current.messages,original.messages);
  assert.deepEqual(current.toolReceipts,[{messageId:assistant.id,itemId:'original',requestId,status,checkedAt:current.toolReceipts?.[0]?.checkedAt}]);
  assert.equal(JSON.stringify(current.toolReceipts).includes('Fixture phase'),false);
  const historical=await f.history.get('model:research-local',original.conversation.id);
  assert.equal(historical.ok,true);
  assert.deepEqual(historical.session.messages,original.messages);
  assert.deepEqual(historical.session.toolReceipts,current.toolReceipts);
  assert.equal((await f.post(CHAT_READ_RECEIPT_PATH,{proof,status:'received'},{'X-BuildX-Read-Receipt-Key':f.key})).status,409);
  assert.equal(f.codex.turns,1);
  assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[]);
  assert.deepEqual(await fs.readdir(path.join(queue,'processing')),[filename]);
});

test('a late snapshot start receipt is reconciled through the original MCP request, without a replay',async t=>{
  const name='revit_get_snapshot_delta',operation='get_snapshot_delta';
  const f=await fixture(t),queue=path.join(f.directory,'workbench','queue');
  await Promise.all(['inbox','processing','outbox'].map(folder=>fs.mkdir(path.join(queue,folder),{recursive:true})));
  const capabilities={atomicReadSnapshot:true,nativeSnapshotDeltaVersion:1,nativeSnapshotDeltaOperations:[operation]};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:hostSession,pid:process.pid,version:'0.8.9',...capabilities}));
  assert.equal((await f.post('/api/turn',{client:'test',message:'Start the fixture snapshot'})).status,202);
  const mcp=await openWorkspaceMcp(f),result=await mcp.callTool({name,arguments:{action:'start'}},{timeout:5000});
  assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
  const proof=result._meta?.[CHAT_READ_RECEIPT_META];assert.ok(proof);assert.equal(proof.tool,name);
  const filename=proof.requestId+'.json';assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[filename]);
  const request=JSON.parse(await fs.readFile(path.join(queue,'inbox',filename),'utf8'));
  assert.equal(request.operation,operation);assert.equal(request.args.action,'start');assert.equal(request.atomicRead,true);
  const {isError:_mcpError,...appServerResult}=result;
  f.codex.notify('item/completed',{item:{type:'mcpToolCall',id:'original',server:'revit_workbench',tool:name,status:'failed',result:appServerResult}});
  f.codex.notify('turn/completed',{turn:{id:'turn',status:'completed'}});
  const original=f.app.snapshot('test').session;
  const assistant=original.messages.find(message=>message.role==='assistant');
  assert.equal(assistant.tools.find(item=>item.id==='original').status,'unknown');
  await fs.rename(path.join(queue,'inbox',filename),path.join(queue,'processing',filename));
  const document={title:'Controlled fixture model',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
  const value={schema_version:1,state:'active',baseline_token:'a'.repeat(32),version:0,baseline_count:1,reason:null};
  const payload={id:proof.requestId,hostSession,completedUtc:new Date().toISOString(),ok:true,result:{operation,hostSession,atomicReadSnapshot:true,
    snapshot:{hostSession,hostVersion:'0.8.9',document,capabilities},value:{operation,hostSession,document:{title:document.title,path:document.path},modifiedByOperation:false,value}}};
  const outbox=path.join(queue,'outbox',filename);await fs.writeFile(outbox+'.tmp',JSON.stringify(payload));await fs.rename(outbox+'.tmp',outbox);
  let current;for(let i=0;i<160;i++){current=f.app.snapshot('test').session;if(current.toolReceipts?.length&&current.conversation.persistence?.status==='saved')break;await wait(20);}
  assert.equal(current.conversation.persistence.status,'saved');
  assert.deepEqual(current.toolReceipts,[{messageId:assistant.id,itemId:'original',requestId:proof.requestId,status:'received',checkedAt:current.toolReceipts?.[0]?.checkedAt}]);
  assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[]);assert.deepEqual(await fs.readdir(path.join(queue,'processing')),[filename]);
  assert.equal(f.codex.turns,1);
});

test('library refresh waits for the existing optional status request to reach a verified terminal state',async t=>{
  const requestId=randomUUID(),timeout=new Error('Controlled timeout');let terminal=false,calls=0,checks=0,closes=0;
  const owner=Object.freeze({
    inspect:()=>{checks++;return {ok:true,value:{requestId,status:terminal?'expired':'pending',terminal}};},
    close:()=>{closes++;return {ok:true,value:{closed:true}};}
  });
  const f=await fixture(t,{
    invokeAtomicContextRead:async(name,args,options)=>{
      assert.equal(name,'revit_workbench_status');assert.equal(options.retainReceiptOwner,true);
      if(++calls===1)throw timeout;
      return {hostSession,document:{title:'Unsaved model',path:''}};
    },
    readContextFailure:error=>error===timeout?{outcome:'unconfirmed',requestIds:[requestId],receiptOwner:owner}:null
  });
  const list=()=>f.post('/api/project-files',{client:'test',action:'list-roots',parameters:{}});
  for(let i=0;i<4;i++)assert.equal((await list()).value.value.projectStatus,'unavailable');
  assert.equal(calls,1);assert.equal(checks,3);assert.equal(closes,0);
  terminal=true;
  assert.equal((await list()).value.value.projectStatus,'unsaved');
  assert.equal(calls,2);assert.equal(closes,1);
});

test('late project binding preview receipt returns to the original MCP call without replay',async t=>{
 const name='revit_preview_project_parameter_binding',operation='preview_project_parameter_binding',f=await fixture(t),queue=path.join(f.directory,'workbench','queue');
 await Promise.all(['inbox','processing','outbox'].map(folder=>fs.mkdir(path.join(queue,folder),{recursive:true})));
 const capabilities={atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:[operation],projectBindingPreviewVersion:1};
 await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:hostSession,pid:process.pid,version:'0.8.9',...capabilities}));
 assert.equal((await f.post('/api/turn',{client:'test',message:'Preview binding'})).status,202);
 const document={title:'Controlled fixture model',path:'D:\\samples\\controlled.rvt',activeViewId:12,activeViewType:'ThreeD',modified:false};
 const args={expected_document:document.path,definition_guid:'d6c25563-54cb-43e7-8003-e7cf8df36916',definition_id:'45',data_type:'text',category_ids:['-2000011']};
 const mcp=await openWorkspaceMcp(f),result=await mcp.callTool({name,arguments:args},{timeout:5000});
 assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed');const proof=result._meta?.[CHAT_READ_RECEIPT_META];assert.ok(proof);assert.equal(proof.tool,name);
 const filename=proof.requestId+'.json';assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[filename]);
 const request=JSON.parse(await fs.readFile(path.join(queue,'inbox',filename),'utf8'));assert.equal(request.operation,operation);assert.equal(request.atomicRead,true);
 const {isError:_mcpError,...appServerResult}=result;f.codex.notify('item/completed',{item:{type:'mcpToolCall',id:'original',server:'revit_workbench',tool:name,status:'failed',result:appServerResult}});f.codex.notify('turn/completed',{turn:{id:'turn',status:'completed'}});
 const original=f.app.snapshot('test').session,assistant=original.messages.find(message=>message.role==='assistant');assert.equal(assistant.tools.find(item=>item.id==='original').status,'unknown');
 await fs.rename(path.join(queue,'inbox',filename),path.join(queue,'processing',filename));
 const value={schema_version:1,definition_guid:args.definition_guid,definition_id:'45',data_type:'text',definition_name:'Synthetic',document_title:document.title,document_path:document.path,binding_before:'unbound',proposed_binding:'instance',category_ids:['-2000011'],instance_count:0,instances:[],coverage:'complete_current_document_instances',future_instances_affected:true,authorization:'not_granted',host_session_bound:false,human_decision:false,binding_attempted:false,external_file_accessed:false};
 const payload={id:proof.requestId,hostSession,completedUtc:new Date().toISOString(),ok:true,result:{operation,hostSession,atomicReadSnapshot:true,snapshot:{hostSession,hostVersion:'0.8.9',document,capabilities},value:{operation,hostSession,document:{title:document.title,path:document.path},modifiedByOperation:false,value}}};
 const outbox=path.join(queue,'outbox',filename);await fs.writeFile(outbox+'.tmp',JSON.stringify(payload));await fs.rename(outbox+'.tmp',outbox);
 let current;for(let i=0;i<160;i++){current=f.app.snapshot('test').session;if(current.toolReceipts?.length&&current.conversation.persistence?.status==='saved')break;await wait(20);}
 assert.deepEqual(current.toolReceipts,[{messageId:assistant.id,itemId:'original',requestId:proof.requestId,status:'received',checkedAt:current.toolReceipts?.[0]?.checkedAt}]);
 assert.deepEqual(await fs.readdir(path.join(queue,'inbox')),[]);assert.deepEqual(await fs.readdir(path.join(queue,'processing')),[filename]);assert.equal(f.codex.turns,1);
});
