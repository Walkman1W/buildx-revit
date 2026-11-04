import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {loadNativeParameterWriteProducer} from './test-support/native-parameter-write-producer.mjs';

const source={session:'a'.repeat(32),title:'Parameter write fixture',path:'D:\\controlled\\parameter-write.rvt'};
function timing(id,stamp){return {schemaVersion:1,requestId:id,hostSession:source.session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,
  observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null};}
async function fixture(t,produce,input){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-setter-queue-')),owner=randomUUID(),identity=await fs.lstat(root,{bigint:true});
  await fs.writeFile(path.join(root,'owner.json'),JSON.stringify({owner}),{flag:'wx'});
  for(const child of ['inbox','outbox','processing'])await fs.mkdir(path.join(root,'queue',child),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:source.session,pid:process.pid,version:'0.8.3'}));
  let job=null,observed=null,workerError=null,requests=0;
  t.after(async()=>{
    if(job)await job;
    const resolved=path.resolve(root),real=await fs.realpath(root),now=await fs.lstat(root,{bigint:true});
    assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(resolved).startsWith('buildx-setter-queue-'));
    assert.equal(real.toLowerCase(),resolved.toLowerCase());assert.equal(now.isDirectory(),true);assert.equal(now.isSymbolicLink(),false);
    assert.deepEqual([now.dev,now.ino,now.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);assert.equal(JSON.parse(await fs.readFile(path.join(root,'owner.json'),'utf8')).owner,owner);
    await fs.rm(resolved,{recursive:true,force:false});
  });
  const options={root,timeout:7000,retainReceiptOwner:true,sourceDocument:source,shouldContinue:()=>true,onTiming(event){
    if(event.phase!=='published'||job)return;
    job=(async()=>{
      const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',event.requestId+'.json'),'utf8'));requests++;
      observed=await produce({...input,args:request.args});const stamp=new Date().toISOString();
      // Only the queue envelope/timing and API peers are controlled. The setter,
      // inner transaction and outer group result are actual production C#.
      const envelope=observed.ok?{id:request.id,ok:true,hostSession:source.session,result:observed.result,completedUtc:stamp,timing:timing(request.id,stamp)}:
        {id:request.id,ok:false,hostSession:source.session,error:{code:observed.error.type,message:observed.error.message},execution:{started:true,phase:'dispatch',reason:null},completedUtc:stamp,timing:timing(request.id,stamp)};
      await fs.writeFile(path.join(root,'queue','outbox',request.id+'.json'),JSON.stringify(envelope),{flag:'wx'});
    })().catch(error=>{workerError=error;});
  }};
  return {options,async finish(){if(job)await job;assert.equal(workerError,null);assert.equal(requests,1);return observed;},get requests(){return requests;}};
}

test('actual production setter and transaction results pass through the real Node queue and retained receipt owner',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeParameterWriteProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  const change={element_id:100,parameter_id:1,value:2,value_unit:'internal'};
  for(const mode of ['commit','rollback'])await t.test(mode+' reconciles false-returning setters by observed values without changing outer mode',async child=>{
    const f=await fixture(child,produce,{parameters:[{id:1,storage:'Double',value:1,behavior:'falseApplied'}]});
    const result=await invokeWorkbench('revit_set_parameters',{expected_document:source.path,mode,changes:[change]},f.options),observed=await f.finish();
    assert.equal(observed.ok,true);assert.equal(result.value.updated_count,1);assert.equal(result.value.changes[0].changed,true);assert.equal(result.value.changes[0].after_internal,2);
    assert.equal(result.committed,mode==='commit');assert.equal(observed.after.parameters[0].value,mode==='commit'?2:1);
    const checked=result.receiptOwner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'received');assert.equal(checked.value.terminal,true);assert.equal(result.receiptOwner.close().ok,true);
  });
  await t.test('no-op rows remain counted while avoiding a setter call',async child=>{
    const f=await fixture(child,produce,{parameters:[{id:1,storage:'String',value:'原值',behavior:'throws'}]});
    const result=await invokeWorkbench('revit_set_parameters',{expected_document:source.path,mode:'commit',changes:[{element_id:100,parameter_id:1,value:'原值'}]},f.options),observed=await f.finish();
    assert.equal(result.value.updated_count,1);assert.equal(result.value.changes[0].changed,false);assert.equal(observed.after.parameters[0].SetCalls,0);assert.equal(result.receiptOwner.inspect().value.status,'received');assert.equal(result.receiptOwner.close().ok,true);
  });
  for(const [name,input,restored] of [
    ['setter true without the requested value',{parameters:[{id:1,storage:'Double',value:1,behavior:'trueNoChange'}]},true],
    ['post-commit drift',{parameters:[{id:1,storage:'Double',value:1}],commitBehavior:'drift'},true],
    ['post-commit drift with pending group rollback',{parameters:[{id:1,storage:'Double',value:1}],commitBehavior:'drift',groupBehavior:'rollbackPending'},false]
  ])await t.test(name+' remains unconfirmed in the client and never replays',async child=>{
    const f=await fixture(child,produce,input);
    let failure;try{await invokeWorkbench('revit_set_parameters',{expected_document:source.path,mode:'commit',changes:[change]},f.options);assert.fail('Expected an execution failure.');}catch(error){failure=error;}
    const observed=await f.finish(),facts=workbenchFailureEvidence(failure);assert.equal(observed.ok,false);assert.equal(facts.outcome,'unconfirmed');assert.ok(facts.receiptOwner);
    const checked=facts.receiptOwner.inspect();assert.equal(checked.ok,true);assert.equal(checked.value.status,'unconfirmed');assert.equal(checked.value.terminal,false);assert.equal(checked.value.canCheckAgain,true);
    assert.equal(Object.hasOwn(checked.value.evidence,'transaction'),false);assert.equal(Object.hasOwn(checked.value.evidence,'rolledBack'),false);
    assert.equal(observed.after.parameters[0].value,restored?1:3);assert.equal(observed.transactions.GroupCommits,0);assert.equal(f.requests,1);assert.equal(facts.receiptOwner.close().ok,true);
  });
});
