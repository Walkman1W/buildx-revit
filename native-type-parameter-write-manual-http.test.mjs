import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {preparedTypeWrite,TYPE_WRITE_NATIVE_TOKEN} from './test-support/native-type-parameter-write-approval-fixtures.mjs';
import {manualTypeWriteHttpFixture,manualTypeWriteAssetFixture,typeWriteArgs,TYPE_WRITE_DOCUMENT,TYPE_WRITE_TOOL,waitTypeWrite} from './test-support/native-type-parameter-write-manual-http-fixtures.mjs';
const approvalResult=(f,p,status)=>{
  const value=f.app.snapshot('browser').dynamicApprovalResult;
  assert.ok(value);assert.equal(value.requestId,p.id);assert.equal(value.digest,p.digest);assert.equal(value.conversationId,f.session);assert.equal(value.status,status);
};

test('manual automatic commit creates a local command and waits for the exact five-field user decision',async t=>{
  const f=await manualTypeWriteHttpFixture(t);await f.choose('automatic');const input=typeWriteArgs({mode:'commit'}),intent=await f.submit(input);
  assert.equal(intent.status,202);assert.equal(typeof intent.body.executionId,'string');await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  assert.equal(f.command().executionId,intent.body.executionId);assert.equal(f.command().status,'running');assert.equal(f.command().progress.phase,'awaiting_approval');
  assert.equal(f.writes.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});assert.equal(JSON.stringify(f.app.snapshot('browser')).includes(TYPE_WRITE_NATIVE_TOKEN),false);
  for(const [patch,options,status] of [[{client:'other'},{},409],[{digest:'0'.repeat(64)},{},409],[{parameters:{value:99}},{},400],[{confirmed:true},{},400],[{},{origin:null},403]])
    assert.equal((await f.decide(p,'accept',patch,options)).status,status);
  assert.equal(f.writes.length,0);assert.equal((await f.submit()).status,409);input.value=99;
  assert.equal((await f.decide(p)).status,200);assert.equal((await f.decide(p)).status,409);const result=await f.terminal();
  assert.equal(result.status,'completed');assert.equal(result.executionId,intent.body.executionId);assert.equal(result.result.data.mode,'commit');assert.equal(f.writes[0].args.value,3);
  approvalResult(f,p,'completed');
  assert.equal(f.writes.length,1);assert.equal(f.direct.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});
});

test('all permitted levels and transaction modes require a new confirmation and default mode remains rollback',async t=>{
  for(const level of ['rollback','confirm','automatic'])for(const mode of [undefined,'rollback','commit']){
    const f=await manualTypeWriteHttpFixture(t);await f.choose(level);const args=typeWriteArgs();if(mode===undefined)delete args.mode;else args.mode=mode;
    const result=await f.submit(args);
    if(level==='rollback'&&mode==='commit'){assert.equal(result.status,403);assert.equal(f.preparations.length,0);continue;}
    assert.equal(result.status,202);await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();assert.equal(JSON.parse(p.typeParameterReview).mode,mode??'rollback');assert.equal(f.writes.length,0);
    assert.equal((await f.decide(p,'decline')).status,200);assert.equal((await f.terminal()).status,'failed');assert.equal(f.writes.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});
  }
});

test('caller confirmation is only intent and missing source, page document paths or malformed guards never prepare',async t=>{
  const f=await manualTypeWriteHttpFixture(t);await f.choose('automatic');
  for(const patch of [{confirmed:false},{confirmed:undefined},{sourceDocument:undefined},{sourceDocument:{...TYPE_WRITE_DOCUMENT,path:'D:\\other.rvt'}},
    {parameters:{...typeWriteArgs()}},{parameters:{type_id:'1000',ack:true}}]){
    const response=await f.submit(typeWriteArgs(),patch);assert.ok([400,409].includes(response.status));assert.equal(f.preparations.length,0);assert.equal(f.writes.length,0);
  }
});

test('decline and cancellation terminate the wait and cannot reuse an old decision',async t=>{
  const f=await manualTypeWriteHttpFixture(t);await f.choose('automatic');const first=await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  assert.equal((await f.decide(p,'decline')).status,200);assert.equal((await f.terminal()).status,'failed');approvalResult(f,p,'declined');assert.equal((await f.decide(p)).status,409);
  const next=await f.submit();assert.equal(next.status,202);await waitTypeWrite(()=>Boolean(f.preview()));const pending=f.preview();assert.notEqual(pending.digest,p.digest);
  assert.equal((await f.post('interrupt',{conversationId:f.session,executionId:next.body.executionId})).status,202);
  const stopped=await f.terminal();assert.equal(stopped.status,'interrupted');assert.equal(stopped.executionId,next.body.executionId);assert.equal(stopped.error.outcome,'not_started');
  approvalResult(f,pending,'not_started');
  assert.equal((await f.decide(pending)).status,409);assert.equal(f.writes.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});
});

test('native expiry completes the local command and clears active instead of waiting forever',async t=>{
  const f=await manualTypeWriteHttpFixture(t,{expiryMs:1000});await f.choose('automatic');const intent=await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  const result=await f.terminal();assert.equal(result.status,'failed');assert.match(result.error.message,/过期/);assert.equal(result.executionId,intent.body.executionId);
  approvalResult(f,p,'not_started');
  assert.equal((await f.decide(p)).status,409);assert.equal(f.writes.length,0);assert.equal(f.preview(),null);
});

test('closing a command waiting for human confirmation settles its work and releases its native proposal',async t=>{
  const f=await manualTypeWriteHttpFixture(t);await f.choose('automatic');await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));
  assert.equal((await f.app.close()).closed,true);assert.equal(f.writes.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});
});

test('connection scope retirement cancels an unaccepted local approval without creating a chat turn',async t=>{
  const f=await manualTypeWriteHttpFixture(t);await f.choose('automatic');await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const old=f.preview();
  f.codex.state={...f.codex.state,connectionGeneration:2};assert.equal(f.app.snapshot('browser').dynamicApproval,null);await waitTypeWrite(()=>!f.app.snapshot('browser').busy);
  assert.equal((await f.decide(old)).status,409);assert.equal(f.writes.length,0);assert.deepEqual(f.calls,{threads:0,turns:0});
});

test('cancelling an in-flight preparation clears the command while its late read cannot create a proposal',async t=>{
  let release,started=false,settled=false;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await manualTypeWriteHttpFixture(t,{prepare:async(args,control)=>{started=true;await barrier;assert.equal(control.shouldContinue(),false);const result={};Object.defineProperty(result,'typeWritePreparation',{value:preparedTypeWrite(args,{sourceDocument:control.sourceDocument})});settled=true;return result;}});
  await f.choose('automatic');const intent=await f.submit();assert.equal(intent.status,202);await waitTypeWrite(()=>started);
  assert.equal((await f.post('interrupt',{conversationId:f.session,executionId:intent.body.executionId})).status,202);assert.equal((await f.terminal()).status,'interrupted');
  release();await waitTypeWrite(()=>settled);assert.equal(f.preview(),null);assert.equal(f.writes.length,0);
});

test('an uncertain preparation retains its original read owner and late recovery never approves a write',async t=>{
  let terminal=false,closes=0;const requestId='b'.repeat(8)+'-bbbb-bbbb-bbbb-'+'b'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}});
  const f=await manualTypeWriteHttpFixture(t,{prepare:async()=>{throw Object.assign(new Error('Controlled original preparation unknown'),{receiptOwner,requestId});}});
  await f.choose('automatic');await f.submit();const result=await f.terminal();assert.equal(result.status,'failed');assert.equal(result.error.outcome,'not_started');
  const pending=f.app.snapshot('browser').modelReceipt;assert.equal(pending.tool,'revit_get_type_parameter_impact');assert.equal(f.writes.length,0);assert.equal((await f.submit()).status,409);
  terminal=true;assert.equal((await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket})).status,200);const checked=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(closes,1);assert.equal(f.preview(),null);assert.equal(f.writes.length,0);assert.equal(f.command().status,'failed');
});

test('unknown manual execution is retained by the permission owner and late settlement updates only its matching command',async t=>{
  let terminal=false,closes=0;const requestId='d'.repeat(8)+'-dddd-dddd-dddd-'+'d'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:terminal?'received':'pending',terminal,requestId}}),close:async()=>{closes++;return {ok:true,value:{closed:true}};}});
  const f=await manualTypeWriteHttpFixture(t,{invoke:async()=>{throw Object.assign(new Error('Controlled unknown write'),{receiptOwner});}});
  await f.choose('automatic');const intent=await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();await f.decide(p);
  const result=await f.terminal();assert.equal(result.status,'unknown');assert.equal(result.canInspectReceipt,false);assert.equal(f.writes.length,1);
  approvalResult(f,p,'unconfirmed');
  const pending=f.app.snapshot('browser').modelReceipt;assert.equal(pending.tool,TYPE_WRITE_TOOL);assert.equal((await f.decide(p)).status,409);assert.equal((await f.submit()).status,409);
  terminal=true;await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket});const checked=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.command().executionId,intent.body.executionId);assert.equal(f.command().status,'completed');assert.equal(f.command().receiptAcknowledged,true);
  approvalResult(f,p,'completed');
  assert.equal(closes,1);assert.equal(f.writes.length,1);assert.equal(f.preview(),null);
});

test('cancel after acceptance preserves the one late execution instead of reporting cancellation as rollback',async t=>{
  let release,started=false;const barrier=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await manualTypeWriteHttpFixture(t,{invoke:async(_tool,args,control)=>{started=true;await barrier;assert.equal(control.shouldContinue(),false);return {operation:'set_type_parameter',mode:args.mode,committed:false,value:{controlled:true}};}});
  await f.choose('automatic');const intent=await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();await f.decide(p);await waitTypeWrite(()=>started);
  await f.post('interrupt',{conversationId:f.session,executionId:intent.body.executionId});release();const result=await f.terminal();assert.equal(result.status,'unknown');assert.equal(f.writes.length,1);
  approvalResult(f,p,'unconfirmed');
  const pending=f.app.snapshot('browser').modelReceipt;await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket});const checked=f.app.snapshot('browser').modelReceipt;
  await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true});
  assert.equal(f.command().status,'completed');approvalResult(f,p,'completed');assert.equal(f.writes.length,1);assert.deepEqual(f.calls,{threads:0,turns:0});
});

test('a late uncertain preparation from a cancelled command blocks a newer unaccepted proposal without losing its owner',async t=>{
  let reject,reads=0;const barrier=new Promise((_resolve,rejectValue)=>{reject=rejectValue;});t.after(()=>reject(new Error('Controlled fixture completed')));
  const requestId='e'.repeat(8)+'-eeee-eeee-eeee-'+'e'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId}}),close:async()=>({ok:true,value:{closed:true}})});
  const f=await manualTypeWriteHttpFixture(t,{prepare:async(args,control)=>{reads++;if(reads===1)return barrier;const result={};Object.defineProperty(result,'typeWritePreparation',{value:preparedTypeWrite(args,{sourceDocument:control.sourceDocument})});return result;}});
  await f.choose('automatic');const first=await f.submit();await waitTypeWrite(()=>reads===1);await f.post('interrupt',{conversationId:f.session,executionId:first.body.executionId});await f.terminal();
  const second=await f.submit();assert.equal(second.status,202);await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();
  reject(Object.assign(new Error('Controlled original cancelled read remains unknown'),{receiptOwner,requestId}));await waitTypeWrite(()=>Boolean(f.app.snapshot('browser').modelReceipt));
  await waitTypeWrite(()=>!f.app.snapshot('browser').busy);assert.equal(f.preview(),null);assert.equal((await f.decide(p)).status,409);assert.equal(f.writes.length,0);
  const pending=f.app.snapshot('browser').modelReceipt;await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket});const checked=f.app.snapshot('browser').modelReceipt;
  await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true});assert.equal(f.writes.length,0);
});

test('the actual manual field and typed review modules are served byte-for-byte only by model HTTP profiles',async t=>{
  for(const kind of ['model','source','customer']){
    const f=await manualTypeWriteAssetFixture(t,kind);
    for(const [name,expected] of Object.entries(f.originals)){
      const response=await fetch(f.origin+'/'+name);
      if(kind!=='model'){assert.equal(response.status,404,kind+'/'+name);continue;}
      assert.equal(response.status,200,name);assert.match(response.headers.get('content-type'),/^text\/javascript; charset=utf-8$/);
      const actual=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(expected).digest('hex'));
      assert.equal(actual.equals(expected),true);
    }
  }
});

test('a late original receipt cannot project an approval result into a replacement connection scope',async t=>{
  const requestId='f'.repeat(8)+'-ffff-ffff-ffff-'+'f'.repeat(12),receiptOwner=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',terminal:true,requestId}}),close:async()=>({ok:true,value:{closed:true}})});
  const f=await manualTypeWriteHttpFixture(t,{invoke:async()=>{throw Object.assign(new Error('Controlled original unknown'),{receiptOwner});}});
  await f.choose('automatic');await f.submit();await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();await f.decide(p);await f.terminal();approvalResult(f,p,'unconfirmed');
  const pending=f.app.snapshot('browser').modelReceipt;f.codex.state={...f.codex.state,connectionGeneration:2};assert.equal(f.app.snapshot('browser').dynamicApprovalResult,null);
  await f.post('model-receipt/check',{conversationId:f.session,ticket:pending.ticket});const checked=f.app.snapshot('browser').modelReceipt;
  assert.equal((await f.post('model-receipt/acknowledge',{conversationId:f.session,ticket:pending.ticket,checkRevision:checked.checkRevision,confirmed:true})).status,200);
  assert.equal(f.app.snapshot('browser').dynamicApprovalResult,null);assert.equal(f.writes.length,1);
});
