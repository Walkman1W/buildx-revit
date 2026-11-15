import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {invokeAtomicWorkbenchRead,invokeWorkbench,workbenchFailureEvidence} from '../lib/workbench-client.mjs';
import {createModelToolDispatcher} from '../lib/model-tool-dispatch.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS} from '../lib/native-parameter-queries.mjs';
import {loadNativeSingleParameterProducer} from '../test-support/native-single-parameter-producer.mjs';

const project=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const name='revit_get_parameter_value',operation='get_parameter_value',session='b'.repeat(32),sourceId='9007199254740993';
const document={title:'Single parameter fixture',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
const capabilities=()=>({atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:[operation]});
const business=request=>({schema_version:1,element_id:request.args.element_id,element_name:'Selected element',parameter:{
  parameter_id:request.args.parameter_id??'-123',name:request.args.parameter_name??' Width ',storage_type:'Double',is_read_only:false,has_value:true,
  data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:2,value_display:'609.6 mm'}});
const args={element_id:sourceId,parameter_id:'-123'};

// Production Node and MCP boundaries run unchanged. Every simulated host,
// copied source and response belongs to one verified temporary directory.
async function fixture(t,{hostPatch={},respond=true,corrupt,onRequest,failure,produce=business}={}){
  const temporary=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(temporary,'buildx-single-parameter-'));
  const owned=await fs.lstat(base,{bigint:true}),stage=path.join(base,'program'),root=path.join(stage,'workbench'),queue=path.join(root,'queue');
  const clients=[],requests=[],errors=[];let stopped=false,pump,prepared=false;
  t.after(async()=>{
    for(const client of clients)await client.close();stopped=true;if(pump)await pump;
    assert.deepEqual(errors,[],'controlled queue peer failed');
    const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});
    assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),temporary);assert.match(path.basename(target),/^buildx-single-parameter-/);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());
    assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[owned.dev,owned.ino,owned.birthtimeNs]);
    assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());await fs.rm(target,{recursive:true,force:true});
  });
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const host={sessionId:session,pid:process.pid,version:'0.8.4',...capabilities(),...hostPatch};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
  const envelope=async request=>{
    if(failure)return {id:request.id,hostSession:session,ok:false,...failure,completedUtc:new Date().toISOString()};
    const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,
      snapshot:{hostSession:session,hostVersion:host.version,document,capabilities:capabilities()},
      value:{operation:request.operation,hostSession:session,document:{title:document.title,path:document.path},modifiedByOperation:false,value:await produce(request)}};
    corrupt?.(result,request);return {id:request.id,ok:true,result,completedUtc:new Date().toISOString()};
  };
  const publish=async request=>{
    const target=path.join(queue,'outbox',request.id+'.json'),partial=target+'.tmp';
    await fs.writeFile(partial,JSON.stringify(await envelope(request)));await fs.rename(partial,target);
  };
  pump=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(file=>file.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);await fs.rename(path.join(queue,'inbox',filename),processing);
      const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);assert.equal(request.operation,operation);
      if(onRequest)await onRequest(request);if(respond)await publish(request);
    }
    await new Promise(resolve=>setTimeout(resolve,3));
  }})().catch(error=>errors.push(String(error)));
  const connect=async()=>{
    if(!prepared){
      await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
      for(const directory of ['lib','public','release','manifests'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
        recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile()&&['.mjs','.js','.json'].includes(path.extname(filename)));},
      });
      await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));prepared=true;
    }
    const stderr=[],transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),'--workspace'],cwd:stage,stderr:'pipe'});
    transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
    const client=new Client({name:'buildx-native-single-parameter-test',version:'1.0.0'},{capabilities:{}});clients.push(client);
    await client.connect(transport);return {client,stderr};
  };
  return {root,queue,requests,publish,connect};
}

test('single reads require host 0.8.4 and their own operation before either invocation path can enqueue',async t=>{
  for(const hostPatch of [{version:'0.8.2'},{version:'0.8.3'},{version:'0.8.4-preview'},{atomicReadSnapshot:false},
    {nativeParameterQueriesVersion:undefined},{nativeParameterQueriesVersion:2},
    {nativeParameterQueryOperations:['get_type_parameters']},{nativeParameterQueryOperations:[operation,operation]}]){
    const f=await fixture(t,{hostPatch});
    for(const invoke of [invokeAtomicWorkbenchRead,invokeWorkbench])await assert.rejects(invoke(name,args,{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
    assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
  }
});

test('both selectors cross one atomic queue with exact identity, raw/internal units and schema evidence',async t=>{
  for(const selector of [{parameter_id:'-9223372036854775808'},{parameter_name:' 精确 Width '}]){
    const f=await fixture(t),chosen={element_id:sourceId,...selector};
    const value=await invokeAtomicWorkbenchRead(name,chosen,{root:f.root,timeout:2000});
    const validate=new Ajv({strict:true}).compile(NATIVE_PARAMETER_QUERY_TOOLS.find(tool=>tool.name===name).outputSchema);
    assert.equal(validate(value),true,JSON.stringify(validate.errors));assert.equal(value.value.element_id,sourceId);
    if(selector.parameter_id)assert.equal(value.value.parameter.parameter_id,selector.parameter_id);else assert.equal(value.value.parameter.name,selector.parameter_name);
    assert.equal(value.value.parameter.value_internal,2);assert.equal(value.value.parameter.value_display,'609.6 mm');
    assert.equal(value.modifiedByOperation,false);assert.equal(value.document.path,'');assert.equal(value.snapshot.capabilities.nativeParameterQueriesVersion,1);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);assert.deepEqual(f.requests[0].args,chosen);
  }
});

test('snapshot or selected-fact corruption stays unconfirmed with no alternate lookup or replay',async t=>{
  const cases=[
    [args,result=>{result.snapshot.capabilities.nativeParameterQueriesVersion=0;}],
    [args,result=>{result.snapshot.capabilities.nativeParameterQueryOperations=['get_type_parameters'];}],
    [args,result=>{result.snapshot.hostVersion='0.8.3';}],
    [args,result=>{result.value.hostSession='c'.repeat(32);}],
    [args,result=>{result.value.document.path='D:\\other.rvt';}],
    [args,result=>{result.value.value.element_id='9007199254740994';}],
    [args,result=>{result.value.value.parameter.parameter_id='-124';}],
    [{element_id:sourceId,parameter_id:'9007199254740993'},result=>{result.value.value.parameter.parameter_id='9007199254740992';}],
    [{element_id:sourceId,parameter_name:' Width '},result=>{result.value.value.parameter.name='Width';}],
    [{element_id:sourceId,parameter_name:'Width'},result=>{result.value.value.parameter.name='width';}],
    [args,result=>{result.value.value.parameter.value_internal='609.6 mm';}],
    [args,result=>{result.value.value.parameters=[result.value.value.parameter];delete result.value.value.parameter;}],
  ];
  for(const [chosen,corrupt] of cases){
    const f=await fixture(t,{corrupt});
    await assert.rejects(invokeAtomicWorkbenchRead(name,chosen,{root:f.root,timeout:2000}),error=>{
      assert.equal(workbenchFailureEvidence(error).outcome,'unconfirmed');assert.ok(error.requestId);return true;
    });assert.equal(f.requests.length,1);
  }
});

test('malformed selectors and unsafe IDs fail before publication instead of choosing a different selector',async t=>{
  const f=await fixture(t);
  for(const chosen of [{element_id:sourceId},{...args,parameter_name:' Width '},{element_id:sourceId,parameter_id:0},
    {element_id:sourceId,parameter_id:'-1'},{element_id:sourceId,parameter_id:9007199254740992},
    {element_id:sourceId,parameter_name:''},{element_id:sourceId,parameter_name:'字'.repeat(1025)},
    {element_id:sourceId,parameter_name:' Width ',mode:'commit'}])await assert.rejects(invokeAtomicWorkbenchRead(name,chosen,{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

test('single command dispatch binds its source document without converting the name or invoking a write',async()=>{
  const source={session,title:document.title,path:''},calls=[];
  const dispatch=createModelToolDispatcher({invokeAtomicRead:async(tool,chosen,options)=>{
    calls.push({tool,chosen,options});return {hostSession:session,document:{title:document.title,path:''}};
  },invokeWorkbench:async()=>{throw new Error('a single-parameter read must stay atomic');}});
  const chosen={element_id:sourceId,parameter_name:' Width '};
  const result=await dispatch.invokeCommand(name,chosen,{sourceDocument:source});assert.equal(result.ok,true);
  assert.equal(calls.length,1);assert.equal(calls[0].tool,name);assert.deepEqual(calls[0].chosen,{...chosen,expected_document:''});assert.equal(calls[0].options.expectedHostSession,session);
  const changed=createModelToolDispatcher({invokeAtomicRead:async()=>({hostSession:session,document:{title:'Different unsaved document',path:''}})});
  await assert.rejects(changed.invokeTool(name,chosen,{sourceDocument:source}),/来源文档/);
});

test('cancellation before publication is not started and after publication keeps the original selector receipt',async t=>{
  const before=await fixture(t);
  await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:before.root,timeout:100,shouldContinue:()=>false}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(before.requests.length,0);
  let current=true,owner,requestId;
  const after=await fixture(t,{respond:false,onRequest:()=>{current=false;}});
  await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:after.root,timeout:2000,retainReceiptOwner:true,shouldContinue:()=>current}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;requestId=error.requestId;return true;
  });
  assert.ok(owner);assert.equal(after.requests.length,1);assert.equal(after.requests[0].id,requestId);
  await after.publish(after.requests[0]);assert.equal((await owner.inspect()).value.status,'received');assert.equal(after.requests.length,1);assert.equal(owner.close().ok,true);
});

test('a timeout reconciles its original single read without automatic selector changes or replay',async t=>{
  const f=await fixture(t,{respond:false});let owner;
  await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:80,retainReceiptOwner:true}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;return true;
  });
  assert.equal(f.requests.length,1);assert.ok(owner);await f.publish(f.requests[0]);assert.equal((await owner.inspect()).value.status,'received');assert.equal(f.requests.length,1);assert.equal(owner.close().ok,true);
});

test('explicit selection failure and expiry preserve execution facts without retry',async t=>{
  for(const [outcome,failure] of [
    ['failed',{error:{code:'InvalidOperationException',message:'Exact parameter name is ambiguous.'},execution:{started:true,phase:'dispatch',reason:null}}],
    ['expired',{error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Expired before execution.'},execution:{started:false,phase:'validation',reason:'expired'}}],
  ]){
    const f=await fixture(t,{failure});
    await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:2000}),error=>workbenchFailureEvidence(error).outcome===outcome);assert.equal(f.requests.length,1);
  }
});

test('actual C# single-parameter DTOs cross the production Node queue without changing source facts',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeSingleParameterProducer(t);
  const f=await fixture(t,{produce:async request=>{
    const produced=await produce({args:request.args});assert.equal(produced.ok,true,JSON.stringify(produced.error));
    assert.equal(produced.facts.sourceFactsUnchanged,true);assert.equal(produced.facts.modifiedAfter,false);return produced.value;
  }});
  for(const selector of [{parameter_id:'-123'},{parameter_name:' Name '},{parameter_id:'9223372036854775807'},{parameter_id:201}]){
    const value=await invokeAtomicWorkbenchRead(name,{element_id:sourceId,...selector},{root:f.root,timeout:4000});
    assert.equal(value.value.element_id,sourceId);assert.equal(value.modifiedByOperation,false);
    if(selector.parameter_id==='9223372036854775807')assert.equal(value.value.parameter.value_internal,'9007199254740995');
    if(selector.parameter_id===201){assert.equal(value.value.parameter.has_value,false);assert.equal(value.value.parameter.value_internal,null);}
  }
  assert.equal(f.requests.length,4);
});

test('the installed MCP client validates both selector results and exact structuredContent',async t=>{
  const f=await fixture(t),{client,stderr}=await f.connect(),listed=await client.listTools();
  const matches=listed.tools.filter(tool=>tool.name===name);assert.equal(matches.length,1);assert.equal(matches[0].annotations.readOnlyHint,true);
  assert.ok(matches[0].inputSchema.oneOf);assert.ok(matches[0].outputSchema);
  const validate=new Ajv({strict:true}).compile(matches[0].outputSchema);
  for(const chosen of [args,{element_id:sourceId,parameter_name:' Width '}]){
    const result=await client.callTool({name,arguments:chosen},{timeout:7000});assert.equal(result.isError,false,JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);assert.equal(validate(result.structuredContent),true,JSON.stringify(validate.errors));
    assert.equal(result.structuredContent.value.element_id,sourceId);assert.equal(result.structuredContent.value.parameter.value_internal,2);
    assert.equal(result.structuredContent.request_id,f.requests.at(-1).id);assert.equal(result.structuredContent.operation,operation);
  }
  assert.equal(f.requests.length,2);assert.deepEqual(stderr,[]);
});

test('MCP keeps old-host and invalid-selector calls not started and corrupt selected facts unconfirmed',async t=>{
  for(const [options,chosen,outcome,count] of [
    [{hostPatch:{version:'0.8.3'}},args,'not_started',0],
    [{}, {...args,parameter_name:' Width '},'not_started',0],
    [{corrupt:result=>{result.value.value.parameter.name='Width';}},{element_id:sourceId,parameter_name:' Width '},'unconfirmed',1],
  ]){
    const f=await fixture(t,options),{client,stderr}=await f.connect();await client.listTools();
    const result=await client.callTool({name,arguments:chosen},{timeout:7000});assert.equal(result.isError,true,JSON.stringify(result));
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,outcome);assert.equal(f.requests.length,count);assert.deepEqual(stderr,[]);
  }
});
