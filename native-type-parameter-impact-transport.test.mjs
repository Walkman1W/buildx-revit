import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Ajv from 'ajv';
import {invokeAtomicWorkbenchRead,invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {createModelToolDispatcher} from './lib/model-tool-dispatch.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS} from './lib/native-parameter-queries.mjs';
import {loadNativeTypeParameterImpactProducer} from './test-support/native-type-parameter-impact-producer.mjs';
import {IMPACT_TOOL,IMPACT_OPERATION,IMPACT_SESSION,IMPACT_TYPE_ID,IMPACT_PARAMETER_ID,impactArguments,impactValue,typeParameterImpactFixture} from './test-support/native-type-parameter-impact-fixtures.mjs';

const noQueued=async f=>{assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(f.queue+'/inbox'),[]);};
const schema=()=>new Ajv({strict:true}).compile(NATIVE_PARAMETER_QUERY_TOOLS.find(tool=>tool.name===IMPACT_TOOL).outputSchema);

test('the impact operation rejects old or incomplete hosts before either path publishes a request',async t=>{
  for(const hostPatch of [{version:'0.8.5'},{version:'0.8.6-preview'},{atomicReadSnapshot:false},
    {nativeParameterQueriesVersion:undefined},{nativeParameterQueriesVersion:2},
    {nativeParameterQueryOperations:['get_type_parameters','get_parameter_value']},{nativeParameterQueryOperations:[IMPACT_OPERATION,IMPACT_OPERATION]}]){
    const f=await typeParameterImpactFixture(t,{hostPatch});
    for(const invoke of [invokeAtomicWorkbenchRead,invokeWorkbench])await assert.rejects(invoke(IMPACT_TOOL,impactArguments(),{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
    await noQueued(f);
  }
});

test('one atomic preview retains exact IDs, raw facts, complete coverage and explicit absence of write authorization',async t=>{
  const f=await typeParameterImpactFixture(t),value=await invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:f.root,timeout:2000});
  const validate=schema();assert.equal(validate(value),true,JSON.stringify(validate.errors));assert.deepEqual(value.value,impactValue());
  assert.equal(value.value.write_authorization,'not_granted');assert.equal(value.modifiedByOperation,false);assert.equal(value.document.path,'');
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);assert.equal(f.requests[0].operation,IMPACT_OPERATION);
  assert.deepEqual(f.requests[0].args,impactArguments());assert.equal(Object.hasOwn(f.requests[0].args,'mode'),false);
});

test('host/document mismatch or malformed preview facts stay owned and unconfirmed without alternate operations',async t=>{
  const corruptions=[
    result=>{result.snapshot.capabilities.nativeParameterQueriesVersion=0;},result=>{result.snapshot.capabilities.nativeParameterQueryOperations=[];},
    result=>{result.snapshot.hostVersion='0.8.5';},result=>{result.value.hostSession='e'.repeat(32);},result=>{result.value.document.path='D:\\other.rvt';},
    result=>{result.value.value.type_id='9223372036854775805';},result=>{result.value.value.parameter.parameter_id='-124';},
    result=>{result.value.value.instance_ids=['10','2'];result.value.value.instance_count=2;},
    result=>{result.value.value.instance_ids=[2];result.value.value.instance_count=1;},
    result=>{result.value.value.instance_count=2;},result=>{result.value.value.coverage.complete=false;},
    result=>{result.value.value.coverage.scanned_elements=2;},result=>{result.value.value.coverage.indirect_effects='assessed';},
    result=>{result.value.value.write_authorization='granted';},
  ];
  for(const corrupt of corruptions){
    const f=await typeParameterImpactFixture(t,{corrupt});let owner;
    await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:f.root,timeout:2000,retainReceiptOwner:true}),error=>{
      const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.ok(error.requestId);owner=f.remember(facts.receiptOwner);assert.ok(owner);return true;
    });
    const original=await owner.inspect();assert.notEqual(original.ok&&original.value?.terminal===true,true);assert.equal(f.requests.length,1);
  }
});

test('instance aliases, names and fabricated write/ack fields are rejected before publication',async t=>{
  const f=await typeParameterImpactFixture(t);
  for(const args of [{element_id:'9007199254740993',parameter_id:IMPACT_PARAMETER_ID},
    {...impactArguments(),parameter_name:'Width'},{...impactArguments(),value:2},{...impactArguments(),ack:true},{...impactArguments(),mode:'commit'},
    impactArguments({type_id:9007199254740992}),impactArguments({parameter_id:'-1'})]){
    await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,args,{root:f.root,timeout:100}),error=>workbenchFailureEvidence(error).outcome==='not_started');
  }
  await noQueued(f);
});

test('manual read dispatch preserves the source document and never uses the write dispatcher',async()=>{
  const source={session:IMPACT_SESSION,title:'Preview source',path:''},calls=[];
  const dispatch=createModelToolDispatcher({invokeAtomicRead:async(name,args,options)=>{calls.push({name,args,options});return {hostSession:source.session,document:{title:source.title,path:source.path}};},
    invokeWorkbench:async()=>{throw new Error('impact preview cannot enter model mutation dispatch');}});
  const result=await dispatch.invokeCommand(IMPACT_TOOL,impactArguments(),{sourceDocument:source});assert.equal(result.ok,true);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,{...impactArguments(),expected_document:''});assert.equal(calls[0].options.expectedHostSession,source.session);
  const changed=createModelToolDispatcher({invokeAtomicRead:async()=>({hostSession:source.session,document:{title:'Different unsaved model',path:''}})});
  await assert.rejects(changed.invokeTool(IMPACT_TOOL,impactArguments(),{sourceDocument:source}),/来源文档/);
});

test('cancellation before enqueue is not started and a published cancellation checks only its original receipt',async t=>{
  const before=await typeParameterImpactFixture(t);
  await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:before.root,timeout:100,shouldContinue:()=>false}),error=>workbenchFailureEvidence(error).outcome==='not_started');await noQueued(before);
  let current=true,owner;
  const after=await typeParameterImpactFixture(t,{respond:false,onRequest:()=>{current=false;}});
  await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:after.root,timeout:2000,retainReceiptOwner:true,shouldContinue:()=>current}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=after.remember(facts.receiptOwner);assert.ok(owner);return true;
  });
  assert.equal(after.requests.length,1);await after.publish(after.requests[0]);assert.equal((await owner.inspect()).value.status,'received');assert.equal(after.requests.length,1);assert.equal(owner.close().ok,true);
});

test('timeout and explicit native failure/expiry never replay an impact read or infer write permission',async t=>{
  const f=await typeParameterImpactFixture(t,{respond:false});let owner;
  await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:f.root,timeout:80,retainReceiptOwner:true}),error=>{
    const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');owner=f.remember(facts.receiptOwner);return true;
  });
  assert.ok(owner);assert.equal(f.requests.length,1);await f.publish(f.requests[0]);assert.equal((await owner.inspect()).value.status,'received');assert.equal(f.requests.length,1);
  for(const [outcome,failure] of [
    ['failed',{error:{code:'InvalidOperationException',message:'type_id must identify an ElementType.'},execution:{started:true,phase:'dispatch',reason:null}}],
    ['expired',{error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Expired before execution.'},execution:{started:false,phase:'validation',reason:'expired'}}],
  ]){
    const failed=await typeParameterImpactFixture(t,{failure});
    await assert.rejects(invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:failed.root,timeout:2000,retainReceiptOwner:true}),error=>{
      const facts=workbenchFailureEvidence(error);failed.remember(facts.receiptOwner);return facts.outcome===outcome;
    });assert.equal(failed.requests.length,1);
  }
});

test('workspace MCP advertises the read-only schema and validates the complete structured preview',async t=>{
  const f=await typeParameterImpactFixture(t),{client,stderr}=await f.connect(),listed=await client.listTools();
  assert.equal(listed.tools.length,34);const matches=listed.tools.filter(tool=>tool.name===IMPACT_TOOL);assert.equal(matches.length,1);
  assert.ok(matches[0].outputSchema);assert.equal(matches[0].annotations.readOnlyHint,true);assert.equal(listed.tools.some(tool=>tool.name==='revit_set_type_parameter'),false);
  const result=await client.callTool({name:IMPACT_TOOL,arguments:impactArguments()},{timeout:7000});assert.equal(result.isError,false,JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);assert.equal(schema()(result.structuredContent),true);
  assert.equal(result.structuredContent.value.write_authorization,'not_granted');assert.equal(f.requests.length,1);
  const forbidden=await client.callTool({name:IMPACT_TOOL,arguments:{...impactArguments(),ack:true,mode:'commit'}},{timeout:7000});
  assert.equal(forbidden.isError,true);assert.equal(forbidden.structuredContent.buildxToolOutcome.outcome,'not_started');assert.equal(f.requests.length,1);assert.deepEqual(stderr,[]);
});

test('MCP keeps old-host rejection not started and a fabricated authorization unconfirmed',async t=>{
  for(const [options,outcome,count] of [
    [{hostPatch:{version:'0.8.5'}},'not_started',0],
    [{corrupt:result=>{result.value.value.write_authorization='granted';}},'unconfirmed',1],
  ]){
    const f=await typeParameterImpactFixture(t,options),{client,stderr}=await f.connect();await client.listTools();
    const result=await client.callTool({name:IMPACT_TOOL,arguments:impactArguments()},{timeout:7000});assert.equal(result.isError,true,JSON.stringify(result));
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,outcome);assert.equal(f.requests.length,count);assert.deepEqual(stderr,[]);
  }
});

test('actual C# type-impact facts pass through the real Node queue and MCP without source mutation',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterImpactProducer(t),observations=[];
  const f=await typeParameterImpactFixture(t,{produce:async request=>{
    const actual=await produce({args:request.args,instanceCount:3,candidateCount:8});assert.equal(actual.ok,true,JSON.stringify(actual.error));
    assert.equal(actual.facts.sourceFactsUnchanged,true);assert.equal(actual.facts.modifiedBefore,actual.facts.modifiedAfter);
    assert.equal(actual.facts.setterApisAvailable,false);assert.equal(actual.facts.transactionApisAvailable,false);observations.push(actual.value);return actual.value;
  }});
  const direct=await invokeAtomicWorkbenchRead(IMPACT_TOOL,impactArguments(),{root:f.root,timeout:4000});assert.equal(schema()(direct),true);
  assert.deepEqual(direct.value.instance_ids,['9007199254740000','9007199254740001','9007199254740002']);assert.equal(direct.value.coverage.scanned_elements,8);
  assert.ok(direct.value.instance_ids.every(id=>typeof id==='string'));
  const {client,stderr}=await f.connect();await client.listTools();
  const result=await client.callTool({name:IMPACT_TOOL,arguments:impactArguments()},{timeout:7000});assert.equal(result.isError,false,JSON.stringify(result));
  assert.deepEqual(result.structuredContent.value,direct.value);assert.equal(result.structuredContent.value.type_id,IMPACT_TYPE_ID);
  assert.equal(result.structuredContent.value.write_authorization,'not_granted');assert.equal(observations.length,2);assert.equal(f.requests.length,2);assert.deepEqual(stderr,[]);
});
