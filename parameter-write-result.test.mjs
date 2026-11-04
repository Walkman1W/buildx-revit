import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertParameterWriteResult} from './lib/parameter-write-result.mjs';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';

const sourceDocument={session:'a'.repeat(32),path:'C:\\parameter-fixture.rvt',title:'Parameter fixture'};
const change=(patch={})=>({element_id:11,parameter_id:-123,value:2,value_unit:'internal',...patch});
const args=(changes=[change()])=>({expected_document:sourceDocument.path,mode:'commit',changes});
const row=(patch={})=>({element_id:11,parameter_id:-123,storage_type:'Double',data_type:'',changed:true,before_internal:1,after_internal:2,...patch});
const result=(changes=[row()])=>({updated_count:changes.length,changes});
const rejects=(value,request)=>assert.throws(()=>assertParameterWriteResult(value,request),Error);

test('parameter receipt verification preserves the exact original typed result and request',()=>{
  const request=args([change(),change({element_id:12,parameter_id:2,value:0}),change({element_id:13,parameter_id:3,value:''})]);
  const value=result([row(),row({element_id:12,parameter_id:2,storage_type:'Integer',changed:false,before_internal:0,after_internal:0}),
    row({element_id:13,parameter_id:3,storage_type:'String',before_internal:null,after_internal:''})]);
  const beforeValue=structuredClone(value),beforeRequest=structuredClone(request);
  for(const item of value.changes)Object.freeze(item);
  Object.freeze(value.changes);Object.freeze(value);
  for(const item of request.changes)Object.freeze(item);
  Object.freeze(request.changes);Object.freeze(request);
  assert.equal(assertParameterWriteResult(value,request),value);
  assert.deepEqual(value,beforeValue);assert.deepEqual(request,beforeRequest);
  assert.equal(value.updated_count,3,'the row count includes a verified unchanged parameter');
  assert.equal(assertParameterWriteResult(value,{...request,mode:'rollback'}),value);
});

test('legacy safe integer identities preserve real negative built-in parameter IDs',()=>{
  for(const element_id of [1,Number.MAX_SAFE_INTEGER])for(const parameter_id of [1,Number.MAX_SAFE_INTEGER,-2,-Number.MAX_SAFE_INTEGER]){
    const request=args([change({element_id,parameter_id})]),value=result([row({element_id,parameter_id})]);
    assert.equal(assertParameterWriteResult(value,request),value);
  }
  for(const element_id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'11','9007199254740993',11n,null,NaN,Infinity]){
    rejects(result(),args([change({element_id})]));rejects(result([row({element_id})]),args());
  }
  for(const parameter_id of [0,-0,-1,1.5,Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER-1,'-123',-123n,null,NaN,Infinity]){
    rejects(result(),args([change({parameter_id})]));rejects(result([row({parameter_id})]),args());
  }
});

test('every exact change pair must appear once with a matching bounded row count',()=>{
  const maximum=Array.from({length:50},(_,index)=>change({element_id:index+1}));
  const maximumRows=maximum.map(item=>row({element_id:item.element_id}));
  assert.doesNotThrow(()=>assertParameterWriteResult(result(maximumRows),args(maximum)));
  rejects(result([]),args([]));
  rejects(result([...maximumRows,row({element_id:51})]),args([...maximum,change({element_id:51})]));
  for(const updated_count of [0,2,1.5,'1',null,NaN,Infinity])rejects({...result(),updated_count},args());
  rejects(result([]),args());rejects(result([row(),row({element_id:12})]),args());
  rejects(result(),args([change(),change({element_id:12})]));
  rejects(result([row(),row()]),args([change(),change()]));
  rejects(result([row(),row()]),args([change(),change({element_id:12})]));
  rejects(result([row(),row({element_id:12})]),args([change(),change()]));
  rejects(result([row({element_id:12})]),args());
  rejects(result([row({parameter_id:-124})]),args());
});

test('missing fields, extra fields and non-data container shapes cannot become verified receipts',()=>{
  for(const key of ['updated_count','changes']){const value=result();delete value[key];rejects(value,args());}
  for(const key of Object.keys(row())){const value=result();delete value.changes[0][key];rejects(value,args());}
  for(const key of ['element_id','parameter_id','value']){const request=args();delete request.changes[0][key];rejects(result(),request);}
  rejects({...result(),verified:true},args());
  rejects(result([row({set_returned:true})]),args());
  rejects(result(),args([change({code:'unregistered'})]));
  for(const value of [null,[],1,'result',new Date(),{...result(),changes:null},{...result(),changes:{0:row(),length:1}}])rejects(value,args());
  for(const request of [null,[],{},args(null),args({0:change(),length:1}),args([null]),args([[]])])rejects(result(),request);
});

test('Double values require finite raw numbers and explicit internal units without conversion',()=>{
  for(const value of [0,-0,Number.MIN_VALUE,-1.25,1e20,Number.MAX_VALUE]){
    const before=value===0?1:0;
    assert.doesNotThrow(()=>assertParameterWriteResult(result([row({before_internal:before,after_internal:value})]),args([change({value})])));
  }
  assert.doesNotThrow(()=>assertParameterWriteResult(result([row({before_internal:null})]),args()));
  for(const value of [NaN,Infinity,-Infinity,'2',true,null,{},[]]){
    rejects(result(),args([change({value})]));
    rejects(result([row({after_internal:value})]),args());
    if(value!==null)rejects(result([row({before_internal:value})]),args());
  }
  const omitted=args();delete omitted.changes[0].value_unit;rejects(result(),omitted);
  for(const value_unit of ['mm','feet','',null,1])rejects(result(),args([change({value_unit})]));
  rejects(result([row({after_internal:609.6})]),args([change({value:2})]));
});

test('Integer values stay Int32 and String values retain exact empty and localized text',()=>{
  for(const value of [-2147483648,2147483647,0]){
    const before=value===0?1:0;
    assert.doesNotThrow(()=>assertParameterWriteResult(result([row({storage_type:'Integer',before_internal:before,after_internal:value})]),args([change({value})])));
  }
  assert.doesNotThrow(()=>assertParameterWriteResult(result([row({storage_type:'Integer',before_internal:null,after_internal:2})]),args()));
  for(const [storage_type,value] of [['Integer',2],['String','2']]){
    const request=args([change({value})]);delete request.changes[0].value_unit;
    assert.doesNotThrow(()=>assertParameterWriteResult(result([row({storage_type,before_internal:null,after_internal:value})]),request));
  }
  for(const value of [-2147483649,2147483648,1.5,Number.MAX_SAFE_INTEGER+1,'2',true,null,NaN,Infinity]){
    rejects(result([row({storage_type:'Integer'})]),args([change({value})]));
    rejects(result([row({storage_type:'Integer',after_internal:value})]),args());
    if(value!==null)rejects(result([row({storage_type:'Integer',before_internal:value})]),args());
  }
  for(const value of ['','中文参数','2','\u0000'])for(const before_internal of [null,'prior',value]){
    const request=args([change({value})]),valueResult=result([row({storage_type:'String',before_internal,after_internal:value,changed:before_internal!==value})]);
    assert.equal(assertParameterWriteResult(valueResult,request),valueResult);
  }
  for(const value of [2,true,null,{},[]]){
    rejects(result([row({storage_type:'String',before_internal:'1',after_internal:'2'})]),args([change({value})]));
    if(value!==null)rejects(result([row({storage_type:'String',before_internal:value,after_internal:'2'})]),args([change({value:'2'})]));
    rejects(result([row({storage_type:'String',before_internal:'1',after_internal:value})]),args([change({value:'2'})]));
  }
});

test('changed describes actual before and after differences independently of a setter return flag',()=>{
  assert.doesNotThrow(()=>assertParameterWriteResult(result([row({before_internal:2,after_internal:2,changed:false})]),args()));
  rejects(result([row({before_internal:2,after_internal:2,changed:true})]),args());
  rejects(result([row({before_internal:1,after_internal:2,changed:false})]),args());
  for(const changed of [0,1,'true',null])rejects(result([row({changed})]),args());
  for(const storage_type of ['Double','Integer']){
    const value=result([row({storage_type,before_internal:-0,after_internal:0,changed:false})]);
    assert.equal(assertParameterWriteResult(value,args([change({value:-0})])),value);
    rejects(result([row({storage_type,before_internal:-0,after_internal:0,changed:true})]),args([change({value:0})]));
  }
});

test('a successful setter cannot hide a mismatched readback, storage kind or metadata type',()=>{
  rejects(result([row({after_internal:3,changed:true})]),args());
  rejects(result([row({storage_type:'String',before_internal:'1',after_internal:'2'})]),args());
  rejects(result([row({storage_type:'Integer',before_internal:1,after_internal:2})]),args([change({value:2.5})]));
  for(const storage_type of ['None','ElementId','double','Other',null,1])rejects(result([row({storage_type})]),args());
  for(const data_type of [null,false,{},[],2])rejects(result([row({data_type})]),args());
  assert.doesNotThrow(()=>assertParameterWriteResult(result([row({data_type:''})]),args()));
});

async function queueFixture(t){
  const parent=path.resolve(os.tmpdir()),prefix='buildx-parameter-result-';
  const root=await fs.mkdtemp(path.join(parent,prefix)),owner=randomUUID(),receiptOwners=[];
  const relative=path.relative(parent,root);
  assert.ok(path.isAbsolute(root)&&relative.startsWith(prefix)&&!relative.includes(path.sep)&&!path.isAbsolute(relative));
  const identity=await fs.lstat(root),marker=path.join(root,'.fixture-owner');
  await fs.writeFile(marker,owner,{flag:'wx'});
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(root)),parent);
    const current=await fs.lstat(root);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());
    assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(current.birthtimeMs,identity.birthtimeMs);
    assert.equal(await fs.readFile(marker,'utf8'),owner);
    for(const receiptOwner of receiptOwners)await receiptOwner.close();
    await fs.rm(root,{recursive:true,force:false});
  });
  const queue=path.join(root,'queue');
  for(const child of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,child),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:sourceDocument.session,pid:process.pid,version:'0.8.2'}),{flag:'wx'});
  return {root,queue,receiptOwners};
}

function envelope(request,value){
  const stamp=new Date().toISOString();
  return {id:request.id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:request.id,hostSession:sourceDocument.session,
    schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,
    observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,
    observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},
    result:{operation:'set_parameters',mode:'commit',committed:true,document:sourceDocument.title,value}};
}

test('a legacy incorrect success stays unknown and reconciles its original receipt without replay',async t=>{
  const f=await queueFixture(t),requestArgs=args();
  const pending=invokeWorkbench('revit_set_parameters',requestArgs,{root:f.root,timeout:3000,sourceDocument,
    expectedHostSession:sourceDocument.session,retainReceiptOwner:true,shouldContinue:()=>true}).then(value=>({value}),error=>({error}));
  let filename;
  for(let attempt=0;attempt<100&&!filename;attempt++){
    filename=(await fs.readdir(path.join(f.queue,'inbox'))).find(name=>name.endsWith('.json'));
    if(!filename)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(filename,'the isolated fixture must receive the one named request');
  const request=JSON.parse(await fs.readFile(path.join(f.queue,'inbox',filename),'utf8'));
  assert.equal(request.operation,'set_parameters');assert.deepEqual(request.args,requestArgs);
  const response=path.join(f.queue,'outbox',filename);
  await fs.writeFile(response,JSON.stringify(envelope(request,result([row({after_internal:3})]))),{flag:'wx'});
  const caught=await pending;
  assert.ok(caught.error,'a legacy ok:true envelope cannot confirm a mismatched parameter value');
  const facts=workbenchFailureEvidence(caught.error);
  assert.equal(facts.outcome,'unconfirmed');assert.deepEqual(facts.requestIds,[request.id]);
  const owner=facts.receiptOwner;assert.ok(owner);
  f.receiptOwners.push(owner);
  const invalid=await owner.inspect();
  assert.ok(invalid.ok===false||invalid.value?.status==='unconfirmed'&&invalid.value?.terminal===false);
  await fs.writeFile(response,JSON.stringify(envelope(request,result())));
  const verified=await owner.inspect();
  assert.equal(verified.ok,true);assert.equal(verified.value.status,'received');assert.equal(verified.value.terminal,true);
  assert.deepEqual((await fs.readdir(path.join(f.queue,'inbox'))).filter(name=>name.endsWith('.json')),[filename]);
  assert.deepEqual(await fs.readdir(path.join(f.queue,'processing')),[]);
  assert.equal((await owner.close()).value.closed,true);

  // The legacy direct/MCP path has no trusted retained owner, but must still
  // reject the same business mismatch instead of returning committed:true.
  const rawPending=invokeWorkbench('revit_set_parameters',requestArgs,{root:f.root,timeout:3000})
    .then(value=>({value}),error=>({error}));
  let rawFilename;
  for(let attempt=0;attempt<100&&!rawFilename;attempt++){
    rawFilename=(await fs.readdir(path.join(f.queue,'inbox'))).find(name=>name.endsWith('.json')&&name!==filename);
    if(!rawFilename)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(rawFilename);assert.notEqual(rawFilename,filename);
  const rawRequest=JSON.parse(await fs.readFile(path.join(f.queue,'inbox',rawFilename),'utf8'));
  assert.equal(rawRequest.operation,'set_parameters');assert.deepEqual(rawRequest.args,requestArgs);
  await fs.writeFile(path.join(f.queue,'outbox',rawFilename),JSON.stringify(envelope(rawRequest,result([row({after_internal:3})]))),{flag:'wx'});
  const rawCaught=await rawPending;
  assert.ok(rawCaught.error);assert.equal(rawCaught.value,undefined);
  assert.equal(workbenchFailureEvidence(rawCaught.error).outcome,'unconfirmed');
  const finalRequests=(await fs.readdir(path.join(f.queue,'inbox'))).filter(name=>name.endsWith('.json'));
  assert.equal(finalRequests.filter(name=>name===rawFilename).length,1);
  assert.ok(finalRequests.every(name=>name===filename||name===rawFilename),'neither invocation may publish a replacement request');
});
