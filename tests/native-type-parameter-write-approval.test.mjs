import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPermissionOwner} from '../lib/model-permission-owner.mjs';
import {createModelPermissionServices} from '../lib/model-permission-services.mjs';
import {capturePreparedTypeWrite,preparedTypeWriteReview,issueTypeWriteUserDecision,consumeTypeWriteUserDecision,approvePreparedTypeWrite,consumeApprovedTypeWrite} from '../lib/type-parameter-write-approval.mjs';
import {TYPE_WRITE_TOOL,TYPE_WRITE_DOCUMENT,TYPE_WRITE_NATIVE_TOKEN,typeWriteArgs,typeWriteImpact,nativeTypePreparation,preparedTypeWrite,typeWriteHost} from '../test-support/native-type-parameter-write-approval-fixtures.mjs';

const scope=()=>({client:'browser',conversationId:'controlled',generation:1,revision:2,account:'controlled-account',document:{...TYPE_WRITE_DOCUMENT}});
function ownerFixture({level='automatic',access=false,verifyDocument=async()=>true,invoke}={}){
  const calls=[],binding={...scope(),...access?{accessPolicy:{id:'controlled-policy',revision:1,accountScope:'controlled-account',mode:'full-access'}}:{}};
  const owner=createModelPermissionOwner({verifyDocument,invoke:async(...args)=>{calls.push(args);return invoke?invoke(...args):{ok:true,value:{controlled:true}};}});
  owner.setLevel({scope:binding,level,isCurrent:()=>true});
  const propose=(args=typeWriteArgs(),prepared=preparedTypeWrite({...args,mode:level==='rollback'?'rollback':args.mode??'rollback'}),callId='controlled-call')=>
    owner.propose({scope:binding,callId,tool:TYPE_WRITE_TOOL,parameters:args,reviewedTypeWrite:prepared,isCurrent:()=>true});
  const proof=p=>issueTypeWriteUserDecision({ticket:p.ticket,digest:p.digest,sourceDocument:TYPE_WRITE_DOCUMENT,deadline:p.deadline});
  return {owner,calls,binding,propose,proof};
}

test('native preparation is opaque, detached and bound to the exact proposed state, impact, mode and document',()=>{
  const args=typeWriteArgs(),impact=typeWriteImpact(),native=nativeTypePreparation(),prepared=capturePreparedTypeWrite({args,impact,sourceDocument:TYPE_WRITE_DOCUMENT,nativePreparation:native});
  assert.ok(Object.isFrozen(prepared));assert.deepEqual(Object.keys(prepared),[]);assert.equal(JSON.stringify(prepared),'{}');
  args.value=99;impact.parameter.value_internal=88;native.token='0'.repeat(32);
  const observed=preparedTypeWriteReview(prepared,{args:typeWriteArgs(),sourceDocument:TYPE_WRITE_DOCUMENT});
  assert.equal(observed.review.value,3);assert.equal(observed.review.parameter.value_internal,2);assert.equal(JSON.stringify(observed).includes(TYPE_WRITE_NATIVE_TOKEN),false);
  for(const patch of [{value:4},{mode:'commit'},{type_id:'9223372036854775805'},{parameter_id:'-124'},
    {expected_instance_ids:['2','10']},{expected_state:{...typeWriteArgs().expected_state,value_internal:9}}])
    assert.throws(()=>preparedTypeWriteReview(prepared,{args:typeWriteArgs(patch),sourceDocument:TYPE_WRITE_DOCUMENT}));
  assert.throws(()=>preparedTypeWriteReview(prepared,{args:typeWriteArgs(),sourceDocument:{...TYPE_WRITE_DOCUMENT,session:'e'.repeat(32)}}));
  assert.throws(()=>preparedTypeWriteReview(JSON.parse(JSON.stringify(prepared)),{args:typeWriteArgs(),sourceDocument:TYPE_WRITE_DOCUMENT}));
});

test('untrusted or incomplete native facts cannot create an approvable preparation',()=>{
  for(const impact of [typeWriteImpact({instance_count:2}),typeWriteImpact({instance_ids:['2','10']}),
    typeWriteImpact({parameter:{...typeWriteImpact().parameter,is_read_only:true}}),typeWriteImpact({write_authorization:'granted'})])
    assert.throws(()=>preparedTypeWrite(typeWriteArgs(),{impact}));
  for(const nativePreparation of [nativeTypePreparation({token:'UPPER'}),nativeTypePreparation({schema_version:2}),
    nativeTypePreparation({expires_utc:new Date(Date.now()-1000).toISOString()}),nativeTypePreparation({expires_utc:new Date(Date.now()+130000).toISOString()}),
    {...nativeTypePreparation(),ack:true}])assert.throws(()=>preparedTypeWrite(typeWriteArgs(),{nativePreparation}));
});

test('all authority levels, modes and full-access still require a one-use panel user decision',async()=>{
  for(const level of ['rollback','confirm','automatic'])for(const mode of ['rollback','commit'])for(const access of [false,true]){
    const f=ownerFixture({level,access}),p=f.propose(typeWriteArgs({mode}));assert.equal(p.requiresApproval,true,level+'/'+mode+'/'+access);
    assert.equal(JSON.parse(p.typeParameterReview).mode,level==='rollback'?'rollback':mode);assert.equal(f.calls.length,0);
    for(const userDecisionProof of [undefined,{},Object.freeze({}),{confirmed:true},{ticket:p.ticket,digest:p.digest}])
      await assert.rejects(f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept',userDecisionProof}),{code:'MODEL_APPROVAL_UNAVAILABLE'});
    assert.equal(f.calls.length,0);const result=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept',userDecisionProof:f.proof(p)});
    assert.equal(result.status,'completed');assert.equal(f.calls.length,1);assert.ok(f.calls[0][2].approvedTypeWrite);
    assert.equal(f.calls[0][2].retainReceiptOwner,true);assert.equal(typeof f.calls[0][2].shouldContinue,'function');
    assert.deepEqual(f.calls[0][2].sourceDocument,TYPE_WRITE_DOCUMENT);
    await assert.rejects(f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept',userDecisionProof:f.proof(p)}));
    assert.equal((await f.owner.close()).closed,true);
  }
});

test('the user proof is bound, single-use and absent from serialized proposal data',()=>{
  const f=ownerFixture(),p=f.propose(),proof=f.proof(p);
  assert.equal(JSON.stringify(proof),'{}');assert.equal(JSON.stringify(p).includes(TYPE_WRITE_NATIVE_TOKEN),false);
  assert.equal(consumeTypeWriteUserDecision(proof,{ticket:p.ticket,digest:'0'.repeat(64),sourceDocument:TYPE_WRITE_DOCUMENT}),false);
  assert.equal(consumeTypeWriteUserDecision(proof,{ticket:p.ticket,digest:p.digest,sourceDocument:TYPE_WRITE_DOCUMENT}),false);
  const fresh=f.proof(p);assert.equal(consumeTypeWriteUserDecision(fresh,{ticket:p.ticket,digest:p.digest,sourceDocument:TYPE_WRITE_DOCUMENT}),true);
  assert.equal(consumeTypeWriteUserDecision(fresh,{ticket:p.ticket,digest:p.digest,sourceDocument:TYPE_WRITE_DOCUMENT}),false);
});

test('approved transport capabilities bind final arguments and cannot be copied, reused or transferred to another host',()=>{
  const args=typeWriteArgs(),approve=()=>approvePreparedTypeWrite(preparedTypeWrite(args),{args,sourceDocument:TYPE_WRITE_DOCUMENT,deadline:Date.now()+50000});
  const approved=approve();assert.equal(JSON.stringify(approved),'{}');
  assert.throws(()=>consumeApprovedTypeWrite(JSON.parse(JSON.stringify(approved)),{args,sourceDocument:TYPE_WRITE_DOCUMENT,host:typeWriteHost()}));
  const native=consumeApprovedTypeWrite(approved,{args,sourceDocument:TYPE_WRITE_DOCUMENT,host:typeWriteHost()});assert.equal(native.token,TYPE_WRITE_NATIVE_TOKEN);
  assert.throws(()=>consumeApprovedTypeWrite(approved,{args,sourceDocument:TYPE_WRITE_DOCUMENT,host:typeWriteHost()}));
  for(const host of [typeWriteHost({sessionId:'e'.repeat(32)}),typeWriteHost({version:'0.8.7'}),typeWriteHost({nativeTypeParameterWritesVersion:0})])
    assert.throws(()=>consumeApprovedTypeWrite(approve(),{args,sourceDocument:TYPE_WRITE_DOCUMENT,host}));
  const changed=approve();assert.throws(()=>consumeApprovedTypeWrite(changed,{args:{...args,value:4},sourceDocument:TYPE_WRITE_DOCUMENT,host:typeWriteHost()}));
  assert.throws(()=>consumeApprovedTypeWrite(changed,{args,sourceDocument:TYPE_WRITE_DOCUMENT,host:typeWriteHost()}));
});

test('a denied, expired, revoked or document-mismatched proposal never dispatches',async()=>{
  const denied=ownerFixture(),p=denied.propose();assert.equal((await denied.owner.decide({ticket:p.ticket,digest:p.digest,decision:'decline'})).status,'declined');assert.equal(denied.calls.length,0);
  const revoked=ownerFixture(),r=revoked.propose(),proof=revoked.proof(r);revoked.owner.revoke();
  await assert.rejects(revoked.owner.decide({ticket:r.ticket,digest:r.digest,decision:'accept',userDecisionProof:proof}));assert.equal(revoked.calls.length,0);
  const mismatch=ownerFixture({verifyDocument:async()=>false}),m=mismatch.propose();
  assert.equal((await mismatch.owner.decide({ticket:m.ticket,digest:m.digest,decision:'accept',userDecisionProof:mismatch.proof(m)})).status,'not_started');assert.equal(mismatch.calls.length,0);
  const expiry=ownerFixture(),e=expiry.propose(),ep=expiry.proof(e),clock=Date.now;
  try{Date.now=()=>e.deadline+1;await assert.rejects(expiry.owner.decide({ticket:e.ticket,digest:e.digest,decision:'accept',userDecisionProof:ep}));assert.equal(expiry.calls.length,0);}
  finally{Date.now=clock;}
});

test('the proposal freezes and displays complete approved raw String values without leaking the native token',()=>{
  const before='原'.repeat(8192),value='新'.repeat(8192),parameter={...typeWriteImpact().parameter,storage_type:'String',value_internal:before,value_display:before,data_type:null,unit_type:null};
  const args=typeWriteArgs({value,value_unit:undefined,expected_state:{storage_type:'String',has_value:true,value_internal:before,data_type:null}});delete args.value_unit;
  const f=ownerFixture(),p=f.propose(args,preparedTypeWrite(args,{impact:typeWriteImpact({parameter})}));
  args.value='mutated';args.expected_instance_ids.length=0;const review=JSON.parse(p.typeParameterReview);
  assert.equal(review.value,value);assert.equal(review.parameter.value_internal,before);assert.equal(review.parameter.value_display,before);
  assert.equal(review.instance_count,3);assert.equal(p.parameters.value,value);assert.equal(p.typeParameterReview.includes(TYPE_WRITE_NATIVE_TOKEN),false);
});

test('the trusted service passes the full proposal only as a private read option and returns only the opaque preparation',async()=>{
  const args=typeWriteArgs(),calls=[],prepared=preparedTypeWrite(args),services=createModelPermissionServices({observe:async(...input)=>{
    calls.push(input);const result={};Object.defineProperty(result,'typeWritePreparation',{value:prepared});return result;
  }}),control={sourceDocument:TYPE_WRITE_DOCUMENT,shouldContinue:()=>true};
  const result=await services.prepareTypeParameterWrite(args,control);assert.equal(result,prepared);assert.equal(JSON.stringify(result),'{}');
  assert.equal(calls[0][0],'revit_get_type_parameter_impact');assert.deepEqual(calls[0][1],{type_id:args.type_id,parameter_id:args.parameter_id,expected_document:args.expected_document});
  assert.deepEqual(calls[0][2].typeWriteProposal,args);assert.equal(calls[0][2].expectedHostSession,TYPE_WRITE_DOCUMENT.session);
  const fake=createModelPermissionServices({observe:async()=>({typeWritePreparation:{token:TYPE_WRITE_NATIVE_TOKEN}})});
  await assert.rejects(fake.prepareTypeParameterWrite(args,control));
});

test('unknown type execution stays owned and cannot reuse the approval or automatically replay',async()=>{
  let terminal=false,closed=0;const receiptOwner=Object.freeze({inspect:()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId:'original-type-write'}}),close:()=>{closed++;return {ok:true,value:{closed:true}};}});
  const f=ownerFixture({invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner})}),p=f.propose();
  assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept',userDecisionProof:f.proof(p)})).status,'unconfirmed');
  assert.equal((await f.owner.inspect({ticket:p.ticket,scope:f.binding})).value.status,'pending');
  await assert.rejects(f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept',userDecisionProof:f.proof(p)}));assert.equal(f.calls.length,1);
  terminal=true;const checked=await f.owner.inspect({ticket:p.ticket,scope:f.binding});
  assert.equal((await f.owner.acknowledge({ticket:p.ticket,scope:f.binding,expected:checked.value})).closed,true);assert.equal(closed,1);assert.equal(f.calls.length,1);
});

test('a successful preparation closes its retained read receipt before returning the opaque capability',async()=>{
  let closes=0;const prepared=preparedTypeWrite(),services=createModelPermissionServices({observe:async(_name,_args,control)=>{
    assert.equal(control.retainReceiptOwner,true);const result={receiptOwner:{close:async()=>{closes++;return {ok:true,value:{closed:true}};}}};Object.defineProperty(result,'typeWritePreparation',{value:prepared});return result;
  }});
  assert.equal(await services.prepareTypeParameterWrite(typeWriteArgs(),{sourceDocument:TYPE_WRITE_DOCUMENT,shouldContinue:()=>true}),prepared);assert.equal(closes,1);
});

test('preparation transport uncertainty or failed successful-read cleanup preserves its original receipt owner',async()=>{
  const receiptOwner=Object.freeze({inspect:()=>({ok:true,value:{status:'pending',terminal:false}}),close:()=>({ok:false})}),requestId='b'.repeat(8)+'-bbbb-bbbb-bbbb-'+ 'b'.repeat(12);
  const failed=createModelPermissionServices({observe:async()=>{throw Object.assign(new Error('Controlled original read unknown'),{receiptOwner,requestId});}});
  await assert.rejects(failed.prepareTypeParameterWrite(typeWriteArgs(),{sourceDocument:TYPE_WRITE_DOCUMENT}),error=>error.receiptOwner===receiptOwner&&error.requestId===requestId);
  const prepared=preparedTypeWrite(),cleanup=createModelPermissionServices({observe:async()=>{const result={receiptOwner};Object.defineProperty(result,'typeWritePreparation',{value:prepared});return result;}});
  await assert.rejects(cleanup.prepareTypeParameterWrite(typeWriteArgs(),{sourceDocument:TYPE_WRITE_DOCUMENT}),error=>error.receiptOwner===receiptOwner&&/cleanup/.test(error.message));
});
