import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';
import {invokeAtomicWorkbenchRead,invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {createModelToolDispatcher} from './lib/model-tool-dispatch.mjs';
import {NATIVE_MODEL_QUERY_NAMES,NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,NATIVE_MODEL_QUERY_TOOLS,MODEL_PREPARATION_QUERY_NAME,MODEL_PREPARATION_OPERATION,MODEL_PREPARATION_QUERY_TOOL} from './lib/native-model-queries.mjs';
import {loadNativeModelQueryProducer} from './test-support/native-model-query-producer.mjs';

const session='e'.repeat(32),document={title:'Native sample',path:'',activeViewId:12,activeViewType:'ThreeD',modified:true};
async function fixture(t,{host={},doc=document,respond=true,corrupt=null,onRequest=null,businessProducer=null,failure=null}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-native-query-transport-')),queue=path.join(root,'queue');
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const identity={sessionId:session,pid:process.pid,version:'0.8.1',atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL),...host};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(identity));
  const requests=[],errors=[];let stopped=false;
  const envelope=(request,business)=>{
    if(failure)return {id:request.id,hostSession:session,ok:false,...failure,completedUtc:new Date().toISOString()};
    const snapshot={hostSession:session,hostVersion:identity.version,document:doc,capabilities:{atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:identity.nativeModelQueryOperations}};
    const value={operation:request.operation,hostSession:session,document:doc===null?null:{title:doc.title,path:doc.path},modifiedByOperation:false,value:business??{schema_version:1,status:doc===null?'no_document':'ready',document_open:doc!==null}};
    const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,snapshot,value};
    if(corrupt)corrupt(result,request);
    return {id:request.id,ok:true,result,completedUtc:new Date().toISOString()};
  };
  const loop=(async()=>{while(!stopped){
    for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const source=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(source,'utf8'));
      await fs.rename(source,path.join(queue,'processing',name));requests.push(request);onRequest?.(request);
      if(respond){
        const produced=businessProducer?await businessProducer({operation:request.operation,args:request.args,noDocument:doc===null}):null;
        if(produced&&!produced.ok)throw new Error('Native business fixture failed: '+JSON.stringify(produced.error));
        await fs.writeFile(path.join(queue,'outbox',name),JSON.stringify(envelope(request,produced?.value)));
      }
    }
    await new Promise(resolve=>setTimeout(resolve,3));
  }})().catch(error=>errors.push(error));
  t.after(async()=>{stopped=true;await loop;assert.deepEqual(errors,[]);const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('buildx-native-query-transport-'));await fs.rm(target,{recursive:true,force:true});});
  return {root,queue,requests,envelope};
}

test('all six native queries reject old or incompletely advertised hosts before any enqueue',async t=>{
  for(const host of [{version:'0.8.0'},{nativeModelQueriesVersion:undefined},{nativeModelQueryOperations:[]},{atomicReadSnapshot:false}]){
    const f=await fixture(t,{host});
    for(const name of NATIVE_MODEL_QUERY_NAMES){
      const args=name.includes('element_parameters')||name.includes('element_geometry')?{element_id:1}:{};
      await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:20}),error=>workbenchFailureEvidence(error).outcome==='not_started');
      await assert.rejects(invokeWorkbench(name,args,{root:f.root,timeout:20}));
    }
    assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
  }
});

test('native health uses one atomic queue and supports no active document',async t=>{
  for(const doc of [document,null]){
    const f=await fixture(t,{doc});
    const result=await invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:2000});
    assert.equal(result.value.document_open,doc!==null);assert.equal(result.modifiedByOperation,false);
    assert.equal(result.snapshot.document,doc===null?null:result.snapshot.document);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);
  }
});

test('native health rejects malformed business values and changed document identities without retry',async t=>{
  for(const corrupt of [result=>{result.value.value.document_open='yes';},result=>{result.value.document.path='D:\\other.rvt';},result=>{result.snapshot.capabilities.nativeModelQueriesVersion=0;},result=>{result.value.hostSession='a'.repeat(32);},result=>{result.value.value.document_open=false;result.value.value.status='no_document';}]){
    const f=await fixture(t,{corrupt});
    await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:2000}),error=>{
      assert.equal(workbenchFailureEvidence(error).outcome,'unconfirmed');assert.ok(error.requestId);return true;
    });assert.equal(f.requests.length,1);
  }
});

test('no-document health still verifies its inner host session',async t=>{
  const f=await fixture(t,{doc:null,corrupt:result=>{result.value.hostSession='a'.repeat(32);}});
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:2000}),error=>workbenchFailureEvidence(error).outcome==='unconfirmed');
  assert.equal(f.requests.length,1);
});

test('malformed native arguments are known not started and never publish a preflight',async t=>{
  const f=await fixture(t);
  for(const [name,args] of [['revit_get_element_parameters',{element_id:9007199254740992}],['revit_get_element_geometry',{element_id:'9223372036854775808'}],['revit_get_elements_by_type',{category:'made up category'}],['revit_list_views',{limit:501}]]){
    await assert.rejects(invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:20}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  }
  assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

test('cancellation while a native receipt is received retains the original receipt for reconciliation',async t=>{
  const f=await fixture(t);let current=true,owner;
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:2000,retainReceiptOwner:true,shouldContinue:()=>current,onTiming:event=>{if(event.phase==='receipt_received')current=false;}}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;return true;
  });
  assert.equal(f.requests.length,1);assert.ok(owner);assert.equal(owner.inspect().value.status,'received');assert.equal(owner.close().ok,true);
});

test('native query failures preserve explicit failed and expired states without replay',async t=>{
  for(const [outcome,failure] of [['failed',{error:{code:'InvalidOperationException',message:'Controlled native query failure'},execution:{started:true,phase:'dispatch',reason:null}}],['expired',{error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Request expired before execution; no operation was run.'},execution:{started:false,phase:'validation',reason:'expired'}}]]){
    const f=await fixture(t,{failure});
    await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:2000}),error=>{const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,outcome);assert.ok(error.requestId);return true;});
    assert.equal(f.requests.length,1);
  }
});

test('all six actual C# business DTOs cross the real Node atomic queue boundary', {skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeModelQueryProducer(t);
  const doc={title:'Query fixture',path:'D:\\fixture.rvt',activeViewId:2001,activeViewType:'ThreeD',modified:false};
  for(const name of NATIVE_MODEL_QUERY_NAMES){
    const f=await fixture(t,{doc,businessProducer:produce});
    const args=name.includes('element_parameters')||name.includes('element_geometry')?{element_id:'9007199254740993'}:{};
    const value=await invokeAtomicWorkbenchRead(name,args,{root:f.root,timeout:4000});
    const validate=new Ajv({strict:false}).compile(NATIVE_MODEL_QUERY_TOOLS.find(tool=>tool.name===name).outputSchema);
    assert.equal(validate(value),true,JSON.stringify(validate.errors));
    assert.equal(value.value.schema_version,1);assert.equal(value.document.path,doc.path);assert.equal(f.requests.length,1);
  }
});

test('the actual C# preparation DTO crosses one atomic queue through the normal command dispatcher', {skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeModelQueryProducer(t);
  const doc={title:'Query fixture',path:'D:\\fixture.rvt',activeViewId:2001,activeViewType:'FloorPlan',modified:false};
  const f=await fixture(t,{doc,businessProducer:produce,host:{nativeModelQueryOperations:[MODEL_PREPARATION_OPERATION]}});
  const sourceDocument={session,title:doc.title,path:doc.path};
  const dispatch=createModelToolDispatcher();
  const result=await dispatch.invokeCommand(MODEL_PREPARATION_QUERY_NAME,{}, {sourceDocument,root:f.root,timeout:4000});
  assert.equal(result.ok,true,result.error?.message);
  t.after(()=>result.receiptOwner.close());
  const validate=new Ajv({strict:false}).compile(MODEL_PREPARATION_QUERY_TOOL.outputSchema);
  assert.equal(validate(result.value.data),true,JSON.stringify(validate.errors));
  assert.deepEqual(result.value.data.value.selection_ids,['10000','9007199254740993']);
  assert.deepEqual(result.value.data.value.levels.map(item=>item.element_id),['1','2']);
  assert.equal(f.requests.length,1);
  assert.deepEqual(result.value.requestIds,[f.requests[0].id]);
  assert.equal(f.requests[0].args.expected_document,doc.path);
  assert.equal(f.requests[0].atomicRead,true);
});

test('all six queries share sourceDocument guards through manual and MCP dispatch',async()=>{
  const source={session,title:document.title,path:document.path},calls=[];
  const dispatch=createModelToolDispatcher({invokeAtomicRead:async(name,args,options)=>{
    calls.push({name,args,options});return {hostSession:session,document:{title:source.title,path:source.path},request_id:'11111111-1111-4111-8111-111111111111'};
  }});
  for(const name of NATIVE_MODEL_QUERY_NAMES){
    const args=name.includes('element_parameters')||name.includes('element_geometry')?{element_id:'9007199254740993'}:{};
    await dispatch.invokeTool(name,args,{sourceDocument:source});
    const result=await dispatch.invokeCommand(name,args,{sourceDocument:source});assert.equal(result.ok,true);
    assert.equal(calls.at(-1).args.expected_document,'');assert.equal(calls.at(-1).options.expectedHostSession,session);
  }
  const changed=createModelToolDispatcher({invokeAtomicRead:async()=>({hostSession:session,document:{title:'Another unsaved document',path:''}})});
  await assert.rejects(changed.invokeTool('revit_health',{}, {sourceDocument:source}),/来源文档/);
  await assert.rejects(dispatch.invokeTool('revit_health',{expected_document:'D:\\other.rvt'},{sourceDocument:source}),/文档或宿主已变化/);
});

test('cancellation before enqueue publishes nothing; cancellation after publication retains the original receipt',async t=>{
  const before=await fixture(t);
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:before.root,shouldContinue:()=>false,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(before.requests.length,0);
  let current=true;
  const after=await fixture(t,{respond:false,onRequest:()=>{current=false;}});
  let owner,requestId;
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:after.root,shouldContinue:()=>current,retainReceiptOwner:true,timeout:2000}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=facts.receiptOwner;requestId=error.requestId;return true;
  });
  assert.equal(after.requests.length,1);assert.ok(owner);assert.equal(after.requests[0].id,requestId);
  await fs.writeFile(path.join(after.queue,'outbox',requestId+'.json'),JSON.stringify(after.envelope(after.requests[0])));
  const verified=await owner.inspect();assert.equal(verified.ok,true);assert.equal(verified.value.status,'received');
  assert.equal(after.requests.length,1);assert.equal((await owner.close()).ok,true);
});

test('native timeout and a replacement host never start a fallback query',async t=>{
  const f=await fixture(t,{respond:false});
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,timeout:30}),error=>{
    assert.equal(workbenchFailureEvidence(error).outcome,'unconfirmed');assert.ok(error.requestId);return true;
  });assert.equal(f.requests.length,1);
  await assert.rejects(invokeAtomicWorkbenchRead('revit_health',{}, {root:f.root,expectedHostSession:'a'.repeat(32),timeout:30}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  assert.equal(f.requests.length,1);
});
