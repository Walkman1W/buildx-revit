import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {invokeAtomicWorkbenchRead,invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS} from './lib/native-parameter-queries.mjs';

// Only the Revit queue peer is simulated. Node dispatch, stdio entry and the
// installed MCP client's output-schema validation use production modules.
const project=path.dirname(fileURLToPath(import.meta.url));
const name='revit_get_type_parameters',operation='get_type_parameters',session='a'.repeat(32);
const sourceId='9007199254740993',typeId='9223372036854775807';
const document={title:'Type parameter fixture',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
const capabilities=()=>({atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:[operation]});
const parameter=()=>({parameter_id:'-1001001',name:'Width',storage_type:'Double',is_read_only:false,has_value:true,
  data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:3.280839895,value_display:'1000 mm'});
const business=request=>({schema_version:1,element_id:request.args.element_id,element_name:'Instance',source_is_type:false,
  type_id:typeId,type_name:'Type',parameters:[parameter()]});

async function fixture(t,{hostPatch={},snapshotPatch={},respond=true,corrupt,onRequest,failure,produce=business}={}){
  const temporary=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(temporary,'buildx-type-parameter-'));
  const owned=await fs.lstat(base,{bigint:true}),stage=path.join(base,'program'),root=path.join(stage,'workbench'),queue=path.join(root,'queue');
  const clients=[],requests=[],errors=[];let stopped=false,pump,prepared=false;
  t.after(async()=>{
    for(const client of clients)await client.close();
    stopped=true;if(pump)await pump;
    assert.deepEqual(errors,[],'controlled queue peer failed');
    const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});
    assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),temporary);
    assert.match(path.basename(target),/^buildx-type-parameter-/);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());
    assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[owned.dev,owned.ino,owned.birthtimeNs]);
    assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());
    await fs.rm(target,{recursive:true,force:true});
  });
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const host={sessionId:session,pid:process.pid,version:'0.8.2',...capabilities(),...hostPatch};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
  const envelope=request=>{
    if(failure)return {id:request.id,hostSession:session,ok:false,...failure,completedUtc:new Date().toISOString()};
    const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,
      snapshot:{hostSession:session,hostVersion:host.version,document,...{capabilities:capabilities()},...snapshotPatch},
      value:{operation:request.operation,hostSession:session,document:{title:document.title,path:document.path},modifiedByOperation:false,value:produce(request)}};
    corrupt?.(result,request);
    return {id:request.id,ok:true,result,completedUtc:new Date().toISOString()};
  };
  const publish=async request=>{
    const target=path.join(queue,'outbox',request.id+'.json'),partial=target+'.tmp';
    await fs.writeFile(partial,JSON.stringify(envelope(request)));await fs.rename(partial,target);
  };
  pump=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(file=>file.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);
      await fs.rename(path.join(queue,'inbox',filename),processing);
      const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);
      assert.equal(request.operation,operation,'only the named read may reach the queue');
      if(onRequest)await onRequest(request);
      if(respond)await publish(request);
    }
    await new Promise(resolve=>setTimeout(resolve,3));
  }})().catch(error=>errors.push(String(error)));
  const connect=async()=>{
    if(!prepared){
      // Source-only copies keep normal relative imports and a new local queue;
      // no account/configuration/history files or binaries enter this fixture.
      await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
      for(const directory of ['lib','public','release','manifests'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
        recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile()&&['.mjs','.js','.json'].includes(path.extname(filename)));},
      });
      await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));prepared=true;
    }
    const stderr=[],transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),'--workspace'],cwd:stage,stderr:'pipe'});
    transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
    const client=new Client({name:'buildx-native-type-parameter-test',version:'1.0.0'},{capabilities:{}});clients.push(client);
    await client.connect(transport);return {client,stderr};
  };
  return {root,queue,requests,publish,connect};
}

test('new parameter queries reject old or incomplete host evidence before any queue publication',async t=>{
  for(const hostPatch of [{version:'0.8.1'},{version:'0.8.2-preview'},{atomicReadSnapshot:false},
    {nativeParameterQueriesVersion:undefined},{nativeParameterQueriesVersion:2},
    {nativeParameterQueryOperations:[]},{nativeParameterQueryOperations:[operation,operation]},
    {nativeParameterQueriesVersion:undefined,nativeModelQueriesVersion:1,nativeModelQueryOperations:[operation]}]){
    const f=await fixture(t,{hostPatch});
    for(const invoke of [invokeAtomicWorkbenchRead,invokeWorkbench])await assert.rejects(invoke(name,{element_id:sourceId},{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
    assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
  }
});

test('the real atomic queue retains exact source/type IDs, raw values, source identity and output schema',async t=>{
  for(const direct of [false,true]){
    const f=await fixture(t,{produce:request=>({...business(request),...direct?{source_is_type:true,type_id:request.args.element_id,element_name:'Type'}:{}})});
    const value=await invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:f.root,timeout:2000});
    const validate=new Ajv({strict:true}).compile(NATIVE_PARAMETER_QUERY_TOOLS[0].outputSchema);
    assert.equal(validate(value),true,JSON.stringify(validate.errors));
    assert.equal(value.value.element_id,sourceId);assert.equal(value.value.source_is_type,direct);
    assert.equal(value.value.type_id,direct?sourceId:typeId);assert.equal(value.value.parameters[0].value_internal,3.280839895);
    assert.equal(value.value.parameters[0].unit_type,'autodesk.unit.unit:millimeters-1.0.1');
    assert.equal(value.modifiedByOperation,false);assert.equal(value.document.path,'');assert.equal(value.hostSession,session);
    assert.equal(value.snapshot.capabilities.nativeParameterQueriesVersion,1);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);
    assert.equal(f.requests[0].operation,operation);assert.equal(f.requests[0].args.element_id,sourceId);
    assert.equal(Object.hasOwn(f.requests[0].args,'mode'),false);
  }
});

test('snapshot-side capability or business corruption is unconfirmed with no fallback or replay',async t=>{
  const corruptions=[
    result=>{result.snapshot.capabilities.nativeParameterQueriesVersion=0;},
    result=>{result.snapshot.capabilities.nativeParameterQueryOperations=[];},
    result=>{result.snapshot.capabilities.atomicReadSnapshot=false;},
    result=>{result.snapshot.hostVersion='0.8.1';},
    result=>{result.value.hostSession='b'.repeat(32);},
    result=>{result.value.document.path='D:\\other.rvt';},
    result=>{result.value.value.element_id='41';},
    result=>{result.value.value.source_is_type=true;},
    result=>{delete result.value.value.type_id;},
    result=>{result.value.value.parameters[0].value_internal='converted display';},
  ];
  for(const corrupt of corruptions){
    const f=await fixture(t,{corrupt});
    await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:f.root,timeout:2000}),error=>{
      assert.equal(workbenchFailureEvidence(error).outcome,'unconfirmed');assert.ok(error.requestId);return true;
    });
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,operation);
  }
});

test('invalid exact IDs, write fields and a different expected host publish no business request',async t=>{
  const f=await fixture(t);
  for(const args of [{element_id:9007199254740992},{element_id:'9223372036854775808'},{element_id:'01'},
    {element_id:sourceId,mode:'commit'},{element_id:sourceId,parameter_name:'Width'}]){
    await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  }
  await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:f.root,expectedHostSession:'c'.repeat(32),timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

test('cancellation before publication is not started; cancellation after publication reconciles the original receipt',async t=>{
  const before=await fixture(t);
  await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:before.root,timeout:100,shouldContinue:()=>false}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(before.requests.length,0);
  let current=true,owner,requestId;
  const after=await fixture(t,{respond:false,onRequest:()=>{current=false;}});
  await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:after.root,timeout:2000,retainReceiptOwner:true,shouldContinue:()=>current}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;requestId=error.requestId;return true;
  });
  assert.ok(owner);assert.equal(after.requests.length,1);assert.equal(after.requests[0].id,requestId);
  await after.publish(after.requests[0]);
  const original=await owner.inspect();assert.equal(original.ok,true);assert.equal(original.value.status,'received');
  assert.equal(after.requests.length,1);assert.equal(owner.close().ok,true);
});

test('a timed-out type read stays unknown until its original receipt arrives and is never automatically retried',async t=>{
  const f=await fixture(t,{respond:false});let owner;
  await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:f.root,timeout:80,retainReceiptOwner:true}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;return true;
  });
  assert.equal(f.requests.length,1);assert.ok(owner);
  await f.publish(f.requests[0]);assert.equal((await owner.inspect()).value.status,'received');
  assert.equal(f.requests.length,1);assert.equal(owner.close().ok,true);
});

test('explicit native failure and expiry retain their execution facts without a second request',async t=>{
  for(const [outcome,failure] of [
    ['failed',{error:{code:'InvalidOperationException',message:'Source has no valid type.'},execution:{started:true,phase:'dispatch',reason:null}}],
    ['expired',{error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Expired before execution.'},execution:{started:false,phase:'validation',reason:'expired'}}],
  ]){
    const f=await fixture(t,{failure});
    await assert.rejects(invokeAtomicWorkbenchRead(name,{element_id:sourceId},{root:f.root,timeout:2000}),error=>workbenchFailureEvidence(error).outcome===outcome);
    assert.equal(f.requests.length,1);
  }
});

test('the installed MCP client validates the production type-query output and exact structuredContent',async t=>{
  const f=await fixture(t),{client,stderr}=await f.connect();
  const listed=await client.listTools(),tools=listed.tools.filter(tool=>tool.name===name);
  assert.equal(tools.length,1);assert.ok(tools[0].outputSchema);assert.equal(tools[0].annotations.readOnlyHint,true);
  const result=await client.callTool({name,arguments:{element_id:sourceId}},{timeout:7000});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  const validate=new Ajv({strict:true}).compile(tools[0].outputSchema);
  assert.equal(validate(result.structuredContent),true,JSON.stringify(validate.errors));
  assert.equal(result.structuredContent.value.element_id,sourceId);assert.equal(result.structuredContent.value.type_id,typeId);
  assert.equal(result.structuredContent.value.parameters[0].value_internal,3.280839895);
  assert.equal(result.structuredContent.request_id,f.requests[0].id);assert.equal(result.structuredContent.modifiedByOperation,false);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);assert.deepEqual(stderr,[]);
});

test('MCP reports an old host as not started and a malformed type result as unconfirmed without replay',async t=>{
  for(const [options,outcome,count] of [
    [{hostPatch:{version:'0.8.1'}},'not_started',0],
    [{corrupt:result=>{result.value.value.type_id=null;}},'unconfirmed',1],
  ]){
    const f=await fixture(t,options),{client,stderr}=await f.connect();await client.listTools();
    const result=await client.callTool({name,arguments:{element_id:sourceId}},{timeout:7000});
    assert.equal(result.isError,true,JSON.stringify(result));assert.equal(result.structuredContent.buildxToolOutcome.outcome,outcome);
    assert.equal(f.requests.length,count);assert.deepEqual(stderr,[]);
  }
});
