import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {createDynamicCabinetOwner,DYNAMIC_CABINET_TOOL} from './lib/dynamic-cabinet-owner.mjs';

const scope=()=>({client:'client',conversationId:'conversation',threadId:'thread',turnId:'turn',generation:1,revision:1,account:{scope:'model',sessionId:'session',userId:'user',generation:1}});
const request=(action='create',parameters={template_id:'metric-generic-model'},callId='call')=>({threadId:'thread',turnId:'turn',callId,tool:DYNAMIC_CABINET_TOOL.name,arguments:{action,parameters}});
const proposal=(owner,params=request(),binding=scope(),isCurrent=()=>true)=>owner.propose({params,scope:binding,isCurrent});
const decide=(owner,p,decision='accept')=>owner.decide({ticket:p.ticket,digest:p.digest,decision});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const completed=(command='revit_family_create_cabinet')=>({ok:true,value:{command,tool:command,data:{operation:command.replace('revit_',''),hostSession:'host',value:{success:true,job_handle:'owned-job'}}}});

test('advertised schema is a bounded dynamic tool contract consistent with its validator',()=>{
  assert.equal(DYNAMIC_CABINET_TOOL.type,'function');assert.equal(DYNAMIC_CABINET_TOOL.inputSchema.additionalProperties,false);
  const validate=new Ajv2020({strict:false}).compile(DYNAMIC_CABINET_TOOL.inputSchema);
  assert.equal(validate({action:'create',parameters:{template_id:'metric-generic-model',width_mm:1300}}),true);
  assert.equal(validate({action:'save',parameters:{job_handle:'job'}}),true);
  assert.equal(validate({action:'close',parameters:{job_handle:'job',width_mm:400}}),false);
  assert.equal(validate({action:'create',parameters:{template_id:'metric-generic-model',width_mm:9000}}),false);
});

test('only approved named operation dispatches the frozen displayed snapshot once',async()=>{
  const calls=[];const owner=createDynamicCabinetOwner({invokeCommand:async(...args)=>{calls.push(args);return completed();}});
  const params=request('create',{template_id:'metric-generic-model',width_mm:1300});const p=proposal(owner,params);params.arguments.parameters.width_mm=4000;
  assert.equal(calls.length,0);assert.equal(p.kind,'plugin');assert.equal(JSON.parse(p.parameters).width_mm,1300);
  const result=await decide(owner,p);assert.equal(result.success,true);assert.equal(calls.length,1);assert.equal(calls[0][0],'revit_family_create_cabinet');assert.equal(calls[0][1].width_mm,1300);assert.ok(Object.isFrozen(calls[0][1]));assert.equal(calls[0][2].confirmed,true);assert.equal(calls[0][2].retainReceiptOwner,true);
  await assert.rejects(decide(owner,p));assert.throws(()=>proposal(owner,params));assert.deepEqual(await owner.close(),{closed:true});
});
test('decline, scope change, altered digest, invalid arguments and expiry never dispatch',async()=>{
  let calls=0;const owner=createDynamicCabinetOwner({invokeCommand:async()=>{calls++;return {ok:true};},approvalTimeoutMs:5});
  let alive=true;const p=proposal(owner,request(),scope(),()=>alive);
  await assert.rejects(owner.decide({ticket:p.ticket,digest:'x',decision:'accept'}));alive=false;await assert.rejects(decide(owner,p));assert.equal(await owner.cancel({ticket:p.ticket}),true);
  assert.throws(()=>proposal(owner,request('create',{template_id:'metric-generic-model',width_mm:9999},'other')));
  const q=proposal(owner,request('close',{job_handle:'job'},'second'));await decide(owner,q,'decline');
  const r=proposal(owner,request('save',{job_handle:'job'},'third'));await new Promise(resolve=>setTimeout(resolve,15));await assert.rejects(decide(owner,r));assert.equal(calls,0);assert.deepEqual(await owner.close(),{closed:true});
});
test('unknown result keeps original receipt and blocks further work until same binding verifies and acknowledges',async()=>{
  let checks=0;const receipt={inspect:()=>({ok:true,value:{terminal:true,status:'received',evidence:{request:'original'},checkedAt:String(++checks)}}),close:()=>({ok:true,value:{closed:true}})};
  let calls=0;const owner=createDynamicCabinetOwner({invokeCommand:async()=>{calls++;return {ok:false,error:{outcome:'unconfirmed'},receiptOwner:receipt};}});
  const p=proposal(owner,request('save',{job_handle:'owned'}));const result=await decide(owner,p);assert.equal(result.success,false);assert.throws(()=>proposal(owner,request('close',{job_handle:'owned'},'second')));
  const wrong=scope();wrong.account.userId='other';await assert.rejects(owner.inspect({ticket:p.ticket,scope:wrong}));
  const checked=await owner.inspect({ticket:p.ticket,scope:scope()});await assert.rejects(owner.acknowledge({ticket:p.ticket,scope:scope(),expected:{terminal:true,status:'failed'}}));
  assert.deepEqual(await owner.close(),{closed:false});assert.deepEqual(await owner.acknowledge({ticket:p.ticket,scope:scope(),expected:checked.value}),{closed:true});assert.deepEqual(await owner.close(),{closed:true});assert.equal(calls,1);
});
test('cancel after dispatch and late reply retain outcome and never replay',async()=>{
  const pending=deferred();let calls=0;let alive=true;
  const owner=createDynamicCabinetOwner({invokeCommand:()=>{calls++;return pending.promise;}});const p=proposal(owner,request(),scope(),()=>alive);
  const executing=decide(owner,p);assert.equal(calls,1);alive=false;assert.equal(await owner.cancel({ticket:p.ticket}),false);
  pending.resolve(completed());await assert.rejects(executing);assert.throws(()=>proposal(owner,request('create',{template_id:'metric-generic-model'},'next')));assert.deepEqual(await owner.close(),{closed:false});
  const wrong=scope();wrong.account.userId='other';await assert.rejects(owner.inspect({ticket:p.ticket,scope:wrong}));const observed=await owner.inspect({ticket:p.ticket,scope:scope()});assert.equal(observed.value.status,'received');assert.deepEqual(await owner.acknowledge({ticket:p.ticket,scope:scope(),expected:observed.value}),{closed:true});assert.deepEqual(await owner.close(),{closed:true});assert.equal(calls,1);
});
test('unknown without receipt and failed cleanup stay fail-closed',async()=>{
  const first=createDynamicCabinetOwner({invokeCommand:async()=>{throw new Error('connection lost');}});const p=proposal(first);assert.equal((await decide(first,p)).success,false);assert.deepEqual(await first.close(),{closed:false});await assert.rejects(first.inspect({ticket:p.ticket,scope:scope()}));
  const receipt={inspect:()=>({ok:true,value:{terminal:true,status:'failed'}}),close:()=>({ok:false})};const second=createDynamicCabinetOwner({invokeCommand:async()=>({ok:false,error:{outcome:'failed'},receiptOwner:receipt})});const q=proposal(second);await decide(second,q);await assert.rejects(second.acknowledge({ticket:q.ticket,scope:scope(),expected:{terminal:true,status:'failed'}}));assert.deepEqual(await second.close(),{closed:false});
});
