import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {invokeAtomicWorkbenchRead,invokeReadonlyPanelCommand,invokeWorkbench} from './lib/workbench-client.mjs';
import {loadNativeReadProducer,nativeProducerAvailable} from './test-support/native-read-producer.mjs';

async function hostFixture(t,{atomic=true,corrupt=null,producer=null,failure=null,version=atomic?'0.6.4':'0.6.1'}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-atomic-read-')),queue=path.join(root,'queue');
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const session='d'.repeat(32),document={title:'Atomic sample',path:'D:\\samples\\atomic.rvt',activeViewId:12,activeViewType:'ThreeD',allowedSample:true,modified:false};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version,...atomic?{atomicReadSnapshot:true}:{}}));
  const requests=[],errors=[];let stopped=false;
  const snapshot=()=>({hostSession:session,hostVersion:version,document:{...document},capabilities:{atomicReadSnapshot:atomic}});
  function native(request){
    if(request.operation==='status')return snapshot();
    let value;
    if(request.operation==='get_selection')value={total:0,returned:0,truncated:false,items:[]};
    else if(request.operation==='list_levels')value={items:[{element_id:1,name:'Level 1',elevation_mm:0,project_elevation_mm:0}]};
    else if(request.operation==='list_family_types'||request.operation==='search_elements')value={items:[],total:0,offset:request.args.offset,limit:request.args.limit,has_more:false};
    else if(request.operation==='describe_parameters')value={element_id:request.args.element_id,parameters:[]};
    else throw new Error('Unexpected operation '+request.operation);
    if(producer)return producer({operation:request.operation,session,document:{...document},args:request.args,value});
    // Portable protocol peers remain useful for non-Windows runs. Native tests
    // below execute the actual C# producer and never add its protocol fields.
    return {hostSession:session,operation:request.operation,document:{title:document.title,path:document.path},modifiedByOperation:false,value};
  }
  const loop=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const source=path.join(queue,'inbox',filename),request=JSON.parse(await fs.readFile(source,'utf8'));
      await fs.rename(source,path.join(queue,'processing',filename));requests.push(request);
      if(failure){
        await fs.writeFile(path.join(queue,'outbox',filename),JSON.stringify({id:request.id,hostSession:session,ok:false,...failure,completedUtc:new Date().toISOString()}));
        continue;
      }
      let value=await native(request);
      if(request.atomicRead)value={operation:request.operation,hostSession:session,atomicReadSnapshot:true,snapshot:snapshot(),value};
      if(corrupt)corrupt(value,request);
      const response={id:request.id,ok:true,result:value,completedUtc:new Date().toISOString()};
      await fs.writeFile(path.join(queue,'outbox',filename),JSON.stringify(response));
    }
    await new Promise(resolve=>setTimeout(resolve,4));
  }})().catch(error=>errors.push(error));
  t.after(async()=>{stopped=true;await loop;assert.deepEqual(errors,[]);assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('buildx-atomic-read-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,requests,session,document};
}

test('manual model overview consumes one real queue receipt on the atomic host',async t=>{
  const host=await hostFixture(t);
  const result=await invokeReadonlyPanelCommand('document',{}, {root:host.root,timeout:2000});
  assert.equal(result.ok,true);assert.equal(result.value.document.title,'Atomic sample');
  assert.equal(result.value.data.modified,false);assert.equal(result.value.requestIds.length,1);
  assert.equal(host.requests.length,1);assert.equal(host.requests[0].atomicRead,true);
});

test('manual selection binds the active document in the same native read',async t=>{
  const host=await hostFixture(t);
  const result=await invokeReadonlyPanelCommand('selection',{}, {root:host.root,timeout:2000});
  assert.equal(result.ok,true);assert.equal(result.value.data.total,0);assert.equal(host.requests.length,1);
  assert.equal(host.requests[0].operation,'get_selection');
  assert.equal(Object.hasOwn(host.requests[0].args,'expected_document'),false);
});

test('MCP read owner preserves a caller-selected document and native result shape',async t=>{
  const host=await hostFixture(t);
  const result=await invokeAtomicWorkbenchRead('revit_list_levels',{expected_document:host.document.path},{root:host.root,timeout:2000});
  assert.equal(result.operation,'list_levels');assert.equal(result.value.items[0].name,'Level 1');
  assert.equal(result.snapshot.document.path,host.document.path);assert.equal(host.requests.length,1);
  assert.equal(host.requests[0].args.expected_document,host.document.path);
});

test('mismatched atomic identities remain unconfirmed and are not retried',async t=>{
  const host=await hostFixture(t,{corrupt:result=>{result.snapshot.document.path='D:\\samples\\different.rvt';}});
  const result=await invokeReadonlyPanelCommand('levels',{}, {root:host.root,timeout:2000});
  assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');assert.equal(host.requests.length,1);
  if(result.receiptOwner)assert.equal((await result.receiptOwner.close()).ok,true);
});

test('caller document mismatch cannot be replaced by an automatic current-document choice',async t=>{
  const host=await hostFixture(t);
  await assert.rejects(invokeAtomicWorkbenchRead('revit_get_selection',{expected_document:'D:\\other.rvt'},{root:host.root,timeout:2000}),/caller-selected document/);
  assert.equal(host.requests.length,1);
});

test('an old host retains the existing before/read/after validation',async t=>{
  const host=await hostFixture(t,{atomic:false});
  const result=await invokeAtomicWorkbenchRead('revit_get_selection',{}, {root:host.root,timeout:2000});
  assert.equal(result.value.total,0);assert.equal(result.request_ids.length,3);
  assert.deepEqual(host.requests.map(request=>request.operation),['status','get_selection','status']);
  assert.ok(host.requests.every(request=>!request.atomicRead));
});

test('atomic protocol cannot admit a write or an old host based on a version string alone',async t=>{
  const host=await hostFixture(t,{atomic:false,version:'0.6.4'});
  for(const tool of ['revit_execute_csharp','revit_set_parameters','revit_move_elements','revit_copy_elements','revit_create_wall','revit_create_pipe'])
    await assert.rejects(invokeWorkbench(tool,{expected_document:host.document.path,code:'return null;'}, {root:host.root,atomicRead:true}),/named read-only/);
  await assert.rejects(invokeWorkbench('revit_workbench_status',{}, {root:host.root,atomicRead:true}),/does not advertise/);
  assert.equal(host.requests.length,0);
});

test('all five real C# query DTOs pass the Node atomic receipt boundary', {skip:!nativeProducerAvailable}, async t=>{
  const producer=await loadNativeReadProducer(t);
  t.diagnostic(JSON.stringify(producer.sourceEvidence));
  const cases=[
    ['revit_get_selection',{}],['revit_search_elements',{limit:5,offset:0}],
    ['revit_list_levels',{}],['revit_list_family_types',{limit:5,offset:0}],
    ['revit_describe_parameters',{element_id:1}]
  ];
  for(const [tool,args] of cases)await t.test(tool,async t=>{
    const host=await hostFixture(t,{producer});
    // Existing unsaved edits belong to the document, not to this read operation.
    host.document.modified=true;
    const result=await invokeAtomicWorkbenchRead(tool,{expected_document:host.document.path,...args},{root:host.root,timeout:4000});
    assert.equal(result.modifiedByOperation,false);
    assert.equal(result.snapshot.document.modified,true);
    assert.equal(result.document.path,host.document.path);
    assert.equal(host.requests.length,1);
  });
});

test('a native-produced query cannot hide an explicit change or an unknown modification fact', {skip:!nativeProducerAvailable}, async t=>{
  const producer=await loadNativeReadProducer(t);
  for(const marker of [true,null,undefined])await t.test(String(marker),async t=>{
    const host=await hostFixture(t,{producer,corrupt:result=>{
      if(marker===undefined)delete result.value.modifiedByOperation;
      else result.value.modifiedByOperation=marker;
    }});
    const result=await invokeReadonlyPanelCommand('selection',{}, {root:host.root,timeout:4000});
    assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');
    assert.match(result.error.message,/Atomic query receipt/);
    assert.equal(host.requests.length,1);
    if(result.receiptOwner)assert.equal((await result.receiptOwner.close()).ok,true);
  });
});

test('query failure and expiry facts remain failures without replay or success normalization', async t=>{
  const cases=[
    {error:{code:'InvalidOperationException',message:'Controlled read failed'},execution:{started:true,phase:'dispatch',reason:null},outcome:'failed'},
    {error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Request expired before execution; no operation was run.'},execution:{started:false,phase:'validation',reason:'expired'},outcome:'expired'}
  ];
  for(const {outcome,...failure} of cases)await t.test(outcome,async t=>{
    const host=await hostFixture(t,{failure});
    await assert.rejects(invokeAtomicWorkbenchRead('revit_get_selection',{}, {root:host.root,timeout:2000}),error=>{
      assert.equal(error.outcome,outcome);assert.equal(error.nativeFailure.started,failure.execution.started);
      assert.equal(error.nativeFailure.code,failure.error.code);return true;
    });
    assert.equal(host.requests.length,1);
  });
});

test('the real write dispatch branch preserves commit, rollback and failure facts', {skip:!nativeProducerAvailable}, async t=>{
  const producer=await loadNativeReadProducer(t);
  const input={operation:'create_wall',value:{element_id:42},document:{modified:false}};
  await t.test('commit records a controlled mutation without a read-only marker',async()=>{
    const receipt=await producer.inspect({...input,args:{mode:'commit'}});
    assert.equal(receipt.ok,true);assert.equal(receipt.result.committed,true);
    assert.equal(Object.hasOwn(receipt.result,'modifiedByOperation'),false);
    assert.deepEqual([receipt.facts.writeCalls,receipt.facts.commits,receipt.facts.rollbacks,receipt.facts.mutations],[1,1,0,1]);
    assert.equal(receipt.facts.modifiedAfter,true);
  });
  await t.test('omitted mode retains the production rollback default',async()=>{
    const receipt=await producer.inspect(input);
    assert.equal(receipt.ok,true);assert.equal(receipt.result.committed,false);
    assert.equal(receipt.result.mode,'rollback');assert.equal(receipt.facts.modifiedAfter,false);
    assert.deepEqual([receipt.facts.commits,receipt.facts.rollbacks,receipt.facts.mutations],[0,1,0]);
    assert.equal(Object.hasOwn(receipt.result,'modifiedByOperation'),false);
  });
  await t.test('a write failure rolls back and cannot produce a read success DTO',async()=>{
    const receipt=await producer.inspect({...input,args:{mode:'commit'},fail:true});
    assert.equal(receipt.ok,false);assert.equal(receipt.result,null);
    assert.match(receipt.error.message,/Controlled write failure/);
    assert.deepEqual([receipt.facts.writeCalls,receipt.facts.commits,receipt.facts.rollbacks,receipt.facts.mutations],[1,0,1,0]);
    assert.equal(receipt.facts.modifiedAfter,false);
  });
  await t.test('serialization failure occurs before commit and preserves rollback',async()=>{
    const receipt=await producer.inspect({...input,args:{mode:'commit'},value:'x'.repeat(250001)});
    assert.equal(receipt.ok,false);assert.equal(receipt.result,null);
    assert.match(receipt.error.message,/Result too large/);
    assert.deepEqual([receipt.facts.commits,receipt.facts.rollbacks,receipt.facts.mutations],[0,1,0]);
  });
  await t.test('document mismatch prevents any controlled write',async()=>{
    const receipt=await producer.inspect({...input,args:{mode:'commit',expected_document:'D:\\other.rvt'}});
    assert.equal(receipt.ok,false);assert.equal(receipt.result,null);
    assert.match(receipt.error.message,/does not match/);
    assert.deepEqual([receipt.facts.writeCalls,receipt.facts.commits,receipt.facts.rollbacks,receipt.facts.mutations],[0,0,0,0]);
  });
  await t.test('a read failure has no success DTO and does not modify a document',async()=>{
    const receipt=await producer.inspect({operation:'get_selection',fail:true});
    assert.equal(receipt.ok,false);assert.equal(receipt.result,null);
    assert.match(receipt.error.message,/Controlled read failure/);
    assert.deepEqual([receipt.facts.readCalls,receipt.facts.writeCalls,receipt.facts.commits,receipt.facts.mutations],[1,0,0,0]);
    assert.equal(receipt.facts.modifiedAfter,false);
  });
});
