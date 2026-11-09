import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedPanelInference} from './lib/managed-panel-inference.mjs';
import {createManagedWorkbenchReads} from './lib/managed-workbench-reads.mjs';
import {workbenchFailureEvidence} from './lib/workbench-client.mjs';

const status='revit_workbench_status',selection='revit_get_selection';
const document={title:'synthetic',path:'D:\\fixture\\model.rvt'},hostSession='fixture-host';
const statusResult={document,hostSession};
const originalRequestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const selectionResult={request_id:originalRequestId,value:{total:1,returned:1,truncated:false,items:[{element_id:'9223372036854775807'}]}};
const notStarted=error=>workbenchFailureEvidence(error).outcome==='not_started';
function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

function fixture(invoke){
  const calls=[];
  let now=1,currentIdentity;
  const owner=createManagedPanelInference({
    isCurrent:({account,connection})=>account===currentIdentity?.account&&connection===currentIdentity?.connection,
    openTurn:async()=>({turnId:'same-fixture-turn-id',expiresAt:now+50}),
    finishTurn:async()=>({closed:true}),
    now:()=>now
  });
  const read=createManagedWorkbenchReads(async(name,args,options)=>{
    calls.push({name,args,options});
    if(invoke)return invoke(name,options);
    return name===status?statusResult:selectionResult;
  },owner.isLocalToolScopeCurrent);
  function start(account,connection,{signal,allowLocalTools=()=>true}={}){
    currentIdentity={account,connection};
    return owner.beginTurn({account,connection,signal,allowLocalTools,requestGrant:()=>null});
  }
  return {owner,read,calls,start,expire(){now+=50;},switchIdentity(){currentIdentity=null;}};
}

test('document references are scoped to the original lease across turns, accounts and connections',async()=>{
  const f=fixture(),a={},b={},generationOne={},generationTwo={};
  const noOptions=await f.start(a,generationOne);
  await assert.rejects(f.read(status,{}),notStarted);
  assert.equal(f.calls.length,0);
  await noOptions.close();
  const first=await f.start(a,generationOne);
  const old=await f.read(status,{},{scope:first.localToolScope});
  assert.equal(typeof old.documentRef,'string');
  assert.equal(JSON.stringify(old).includes(document.path),false);
  const selected=await f.read(selection,{document_ref:old.documentRef},{scope:first.localToolScope});
  assert.deepEqual(selected,{elementIds:['9223372036854775807'],count:1,returned:1,truncated:false});
  assert.deepEqual(f.calls[1].options.sourceDocument,{...document,session:hostSession});
  assert.equal(Object.hasOwn(f.calls[1].options,'scope'),false);
  await first.close();

  let prior=old.documentRef;
  for(const [account,connection] of [[a,generationOne],[b,generationOne],[b,generationTwo]]){
    const lease=await f.start(account,connection);
    const count=f.calls.length;
    await assert.rejects(f.read(selection,{document_ref:prior},{scope:lease.localToolScope}),notStarted);
    await assert.rejects(f.read(status,{},{scope:first.localToolScope}),notStarted);
    assert.equal(f.calls.length,count);
    const {documentRef}=await f.read(status,{},{scope:lease.localToolScope});
    assert.notEqual(documentRef,prior);
    prior=documentRef;
    await lease.close();
  }
  await f.owner.close();
});

test('abort, expiry and account revocation deny an existing local tool scope',async()=>{
  const f=fixture(),account={},connection={};
  const stop=new AbortController();
  const first=await f.start(account,connection,{signal:stop.signal});
  assert.equal(f.owner.isLocalToolScopeCurrent(first.localToolScope),true);
  stop.abort();
  assert.equal(f.owner.isLocalToolScopeCurrent(first.localToolScope),false);
  await first.close();
  const second=await f.start(account,connection);
  f.expire();
  assert.equal(f.owner.isLocalToolScopeCurrent(second.localToolScope),false);
  await second.close();
  const third=await f.start(account,connection);
  f.switchIdentity();
  await assert.rejects(f.read(status,{},{scope:third.localToolScope}),notStarted);
  assert.equal(f.calls.length,0);
  await third.close();
  await f.owner.close();
});

test('a revoked read cannot publish late or invalidate a newer turn reference',async()=>{
  const before=deferred(),after=deferred();
  let publications=0,allow=true,delayRead=true;
  const f=fixture(async(name,control)=>{
    if(name===status)return statusResult;
    if(delayRead)await before.promise;
    if(!control.shouldContinue())throw Object.assign(new Error('not published'),{interruptedBeforeEnqueue:true});
    publications++;
    if(delayRead)await after.promise;
    return selectionResult;
  });
  const account={},connection={};
  const first=await f.start(account,connection,{allowLocalTools:()=>allow});
  const a={scope:first.localToolScope};
  const {documentRef}=await f.read(status,{},a);
  const pending=f.read(selection,{document_ref:documentRef},a);
  allow=false;
  before.resolve();
  await assert.rejects(pending,notStarted);
  assert.equal(publications,0);
  allow=true;
  assert.equal(f.owner.isLocalToolScopeCurrent(first.localToolScope),false);
  await first.close();

  const second=await f.start(account,connection);
  const b={scope:second.localToolScope};
  const ref=(await f.read(status,{},b)).documentRef;
  const late=f.read(selection,{document_ref:ref},b);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(publications,1);
  await second.close();
  const third=await f.start(account,connection);
  const c={scope:third.localToolScope};
  const fresh=(await f.read(status,{},c)).documentRef;
  after.resolve();
  await assert.rejects(late,error=>{
    const evidence=workbenchFailureEvidence(error);
    assert.equal(evidence.outcome,'unconfirmed');
    assert.deepEqual(evidence.requestIds,[originalRequestId]);
    return true;
  });
  assert.equal(publications,1);
  delayRead=false;
  assert.equal((await f.read(selection,{document_ref:fresh},c)).count,1);
  assert.equal(publications,2);
  await third.close();
  await f.owner.close();
});
