import test from 'node:test';
import assert from 'node:assert/strict';
import {TYPE_WRITE_TOOL,TYPE_WRITE_DOCUMENT,TYPE_WRITE_NATIVE_TOKEN,typeWriteArgs,preparedTypeWrite,typeWriteHttpFixture,waitTypeWrite} from './test-support/native-type-parameter-write-approval-fixtures.mjs';

test('automatic type commit waits for the real bound HTTP decision and never exposes its native permit',async t=>{
  const f=await typeWriteHttpFixture(t);assert.equal((await f.choose('automatic')).status,200);assert.equal((await f.begin()).status,202);
  const args=typeWriteArgs({mode:'commit'});f.codex.request(1,args);await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  assert.equal(f.preparations.length,1);assert.equal(f.writes.length,0);assert.equal(p.action,TYPE_WRITE_TOOL);
  const review=JSON.parse(p.typeParameterReview);assert.equal(review.mode,'commit');assert.deepEqual(review.instance_ids,args.expected_instance_ids);
  assert.equal(review.parameter.value_internal,2);assert.equal(review.value,3);assert.equal(JSON.stringify(f.app.snapshot('browser')).includes(TYPE_WRITE_NATIVE_TOKEN),false);
  assert.equal(f.app.snapshot('other').dynamicApproval,null);
  for(const [patch,options,status] of [[{client:'other'},{},409],[{digest:'0'.repeat(64)},{},409],[{parameters:{value:99}},{},400],
    [{ack:true},{},400],[{},{origin:null},403],[{},{origin:'http://attacker.invalid'},403]]){
    assert.equal((await f.decide(p,'accept',patch,options)).status,status);assert.equal(f.writes.length,0);
  }
  args.value=99;args.expected_instance_ids.length=0;
  assert.equal((await f.decide(p)).status,200);assert.equal((await f.decide(p)).status,409);await waitTypeWrite(()=>f.codex.answers.length===1);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].args.value,3);assert.deepEqual(f.writes[0].args.expected_instance_ids,['2','10','9007199254740993']);
  assert.equal(f.writes[0].control.retainReceiptOwner,true);assert.equal(f.writes[0].control.shouldContinue(),true);
  assert.equal(f.codex.answers[0].success,true);assert.equal(JSON.stringify(f.codex.answers).includes(TYPE_WRITE_NATIVE_TOKEN),false);
});

test('every permission and requested mode still produces its own typed confirmation before any write',async t=>{
  for(const level of ['rollback','confirm','automatic'])for(const mode of ['rollback','commit']){
    const f=await typeWriteHttpFixture(t);await f.choose(level);await f.begin();f.codex.request(1,typeWriteArgs({mode}));
    await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview(),effective=level==='rollback'?'rollback':mode;
    assert.equal(JSON.parse(p.typeParameterReview).mode,effective);assert.equal(f.preparations[0].args.mode,effective);assert.equal(f.writes.length,0);
    assert.equal((await f.decide(p)).status,200);await waitTypeWrite(()=>f.writes.length===1&&f.codex.answers.length===1);
    assert.equal(f.writes[0].args.mode,effective);assert.deepEqual(f.writes[0].control.sourceDocument,TYPE_WRITE_DOCUMENT);
  }
});

test('decline performs no write and a later proposal requires a new independent confirmation',async t=>{
  const f=await typeWriteHttpFixture(t);await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>Boolean(f.preview()));const first=f.preview();
  assert.equal((await f.decide(first,'decline')).status,200);await waitTypeWrite(()=>f.codex.answers.length===1);assert.equal(f.writes.length,0);
  assert.equal((await f.decide(first)).status,409);f.codex.request(2,typeWriteArgs());await waitTypeWrite(()=>Boolean(f.preview()));const next=f.preview();
  assert.notEqual(next.id,first.id);assert.notEqual(next.digest,first.digest);assert.equal(f.writes.length,0);
  assert.equal((await f.decide(next)).status,200);await waitTypeWrite(()=>f.writes.length===1&&f.codex.answers.length===2);assert.equal(f.preparations.length,2);
});

test('manual command flags cannot authorize type writes in any permission or transaction mode',async t=>{
  for(const level of ['rollback','confirm','automatic']){
    const f=await typeWriteHttpFixture(t);await f.choose(level);
    for(const mode of [undefined,'rollback','commit']){
      const parameters=typeWriteArgs();delete parameters.expected_document;if(mode===undefined)delete parameters.mode;else parameters.mode=mode;
      const result=await f.post('command',{conversationId:f.session,commandId:TYPE_WRITE_TOOL,parameters,confirmed:true,sourceDocument:TYPE_WRITE_DOCUMENT});
      assert.equal(result.status,403);assert.equal(result.body.outcome,'not_started');assert.equal(f.writes.length,0);assert.equal(f.direct.length,0);assert.equal(f.preparations.length,0);
    }
  }
});

test('caller-supplied stale state or an incomplete instance set cannot become a confirmation',async t=>{
  const f=await typeWriteHttpFixture(t);await f.choose('automatic');await f.begin();
  for(const [index,args] of [typeWriteArgs({expected_state:{...typeWriteArgs().expected_state,value_internal:9}}),typeWriteArgs({expected_instance_ids:['2','10']})].entries()){
    f.codex.request(index+1,args);await waitTypeWrite(()=>f.codex.answers.length===index+1);
    assert.equal(f.codex.answers[index].success,false);assert.equal(f.preview(),null);assert.equal(f.writes.length,0);
    const result=JSON.parse(f.codex.answers[index].contentItems[0].text);assert.equal(result.error.outcome,'not_started');assert.equal(result.error.stage,'proposal');
  }
});

test('native preparation expiry clamps the dialog deadline and cannot be accepted after expiry',async t=>{
  const f=await typeWriteHttpFixture(t,{expiryMs:1000});await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  assert.ok(p.deadline<=Date.now()+1000);await waitTypeWrite(()=>Date.now()>p.deadline);
  assert.equal((await f.decide(p)).status,409);assert.equal(f.writes.length,0);
});

test('a document changed between display and acceptance revokes the write instead of using the former approval',async t=>{
  const f=await typeWriteHttpFixture(t);await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs({mode:'commit'}));await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  f.changeDocument({path:'D:\\controlled\\other.rvt'});assert.equal((await f.decide(p)).status,200);await waitTypeWrite(()=>f.codex.answers.length===1);
  assert.equal(f.writes.length,0);assert.equal(f.codex.answers[0].success,false);assert.equal(f.app.snapshot('browser').modelPermission.level,null);
});

test('a late preparation from a replaced connection never becomes an approvable card',async t=>{
  let release,started=false;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await typeWriteHttpFixture(t,{prepare:async(args,control)=>{started=true;await barrier;const result={};Object.defineProperty(result,'typeWritePreparation',{value:preparedTypeWrite(args,{sourceDocument:control.sourceDocument})});return result;}});
  await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>started);
  f.codex.state={...f.codex.state,connectionGeneration:2};release();await waitTypeWrite(()=>f.codex.rejected>0);
  assert.equal(f.writes.length,0);assert.equal(f.preview(),null);
});

test('unknown execution retains the original receipt and neither the old decision nor a new AI call replays it',async t=>{
  let terminal=false,closes=0;const receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId:'original-type-request'}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}});
  const f=await typeWriteHttpFixture(t,{invoke:async()=>{throw Object.assign(new Error('Controlled unknown write'),{receiptOwner});}});
  await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  assert.equal((await f.decide(p)).status,200);await waitTypeWrite(()=>Boolean(f.app.snapshot('browser').modelReceipt)&&f.codex.answers.length===1);
  assert.equal(f.writes.length,1);assert.equal((await f.decide(p)).status,409);f.codex.request(2,typeWriteArgs());await waitTypeWrite(()=>f.codex.answers.length===2);
  assert.equal(f.writes.length,1);assert.equal(f.preparations.length,1);const pending=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);assert.equal(f.app.snapshot('browser').modelReceipt.check.terminal,false);
  terminal=true;assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);
  const checked=f.app.snapshot('browser').modelReceipt;assert.equal(checked.check.requestId,'original-type-request');
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt,null);assert.equal(closes,1);assert.equal(f.writes.length,1);
});

test('an uncertain preparation read stays owned while writes remain not started and a late read never auto-approves',async t=>{
  let terminal=false,closes=0;const requestId='a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}});
  const f=await typeWriteHttpFixture(t,{prepare:async()=>{throw Object.assign(new Error('Controlled preparation read timeout'),{receiptOwner,requestId});}});
  await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>f.codex.answers.length===1&&Boolean(f.app.snapshot('browser').modelReceipt));
  const business=JSON.parse(f.codex.answers[0].contentItems[0].text);assert.equal(business.error.outcome,'not_started');assert.equal(business.error.details.preparationOutcome,'unconfirmed');
  assert.equal(business.error.details.recoveryPending,true);assert.equal(business.error.details.requestId,requestId);assert.equal(f.writes.length,0);assert.equal(f.preview(),null);
  const pending=f.app.snapshot('browser').modelReceipt;assert.equal(pending.tool,'revit_get_type_parameter_impact');
  f.codex.request(2,typeWriteArgs());await waitTypeWrite(()=>f.codex.answers.length===2);assert.equal(f.preparations.length,1);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);assert.equal(f.app.snapshot('browser').modelReceipt.check.terminal,false);
  terminal=true;assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);const checked=f.app.snapshot('browser').modelReceipt;
  assert.equal(checked.check.requestId,requestId);assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(closes,1);assert.equal(f.app.snapshot('browser').modelReceipt,null);assert.equal(f.preview(),null);assert.equal(f.writes.length,0);assert.equal(f.preparations.length,1);
});

test('a preparation read rejected after a connection change retains the original grant receipt without a new proposal',async t=>{
  let reject,started=false;const barrier=new Promise((_resolve,rejectValue)=>{reject=rejectValue;});t.after(()=>reject(new Error('Controlled finished fixture')));
  const requestId='c'.repeat(8)+'-cccc-cccc-cccc-'+'c'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId}}),close:async()=>({ok:true,value:{closed:true}})});
  const f=await typeWriteHttpFixture(t,{prepare:async()=>{started=true;return barrier;}});await f.choose('automatic');await f.begin();f.codex.request(1,typeWriteArgs());await waitTypeWrite(()=>started);
  f.codex.state={...f.codex.state,connectionGeneration:2};reject(Object.assign(new Error('Original read remains owned'),{receiptOwner,requestId}));
  await waitTypeWrite(()=>Boolean(f.app.snapshot('browser').modelReceipt));const pending=f.app.snapshot('browser').modelReceipt;
  assert.equal(pending.sourceConversationId,f.session);assert.equal(f.preview(),null);assert.equal(f.writes.length,0);
  assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);const checked=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.app.snapshot('browser').modelReceipt,null);assert.equal(f.writes.length,0);
});
