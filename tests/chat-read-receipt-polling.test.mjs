import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createChatReadReceiptProducer,createChatReadReceiptInbox} from '../lib/chat-read-receipts.mjs';
async function run({terminalAt=Infinity,status='received',advance=0,resultKind='normal',frozen=false}={}){
 let time=1000000,closed=0;const checks=[],sent=[],key=randomBytes(32).toString('hex'),requestId=randomUUID();
 let finish;const done=new Promise(resolve=>finish=resolve);
 const producer=createChatReadReceiptProducer({key,port:12345,now:()=>time,sleep:async delay=>{if(!frozen)time+=delay;},send:async (_url,options)=>{sent.push(JSON.parse(options.body));return {body:{cancel:async()=>{}}};}});
 const proof=producer.retain('revit_get_phases',requestId,{inspect:async()=>{checks.push(time-1000000);time+=advance;if(resultKind==='empty')return null;return {ok:true,value:{requestId:resultKind==='wrong'?randomUUID():requestId,status:checks.at(-1)>=terminalAt?status:'pending',terminal:checks.at(-1)>=terminalAt}};},close:async()=>{closed++;finish();}});
 await done;return {checks,sent,proof,requestId,closed,key};
}
test('late original receipt is checked after 201 seconds and relayed with original id',async()=>{
 const r=await run({terminalAt:201000});assert.deepEqual(r.checks,[0,1000,4000,14000,34000,64000,94000,124000,154000,184000,214000]);assert.equal(r.sent.length,1);assert.equal(r.sent[0].proof.requestId,r.requestId);assert.equal(r.sent[0].status,'received');assert.equal(r.closed,1);
});
test('expiry and host change close the original owner without relaying or replay',async()=>{
 const expired=await run();assert.equal(expired.checks.at(-1),299000);assert.equal(expired.sent.length,0);assert.equal(expired.closed,1);
 const changed=await run({terminalAt:1000,status:'host_changed'});assert.deepEqual(changed.checks,[0,1000]);assert.equal(changed.sent.length,0);assert.equal(changed.closed,1);
 const inbox=createChatReadReceiptInbox(expired.key,new Set(['revit_get_phases']));assert.equal(inbox.receive({proof:{...expired.proof,expires:0},status:'received'}),false);inbox.close();
});
test('inspection crossing expiry never schedules another inspection',async()=>{
 const r=await run({advance:20000});assert.ok(r.checks.length<14);assert.ok(r.checks.every(t=>t<300000));assert.equal(r.sent.length,0);assert.equal(r.closed,1);
});

test('wrong request ID and empty result stop at the bounded final check',async()=>{
 for(const resultKind of ['wrong','empty']){
  const r=await run({resultKind});assert.equal(r.checks.length,14);assert.equal(r.checks.at(-1),299000);assert.equal(r.sent.length,0);assert.equal(r.closed,1);
  const slow=await run({resultKind,advance:20000});assert.ok(slow.checks.length<14);assert.equal(slow.sent.length,0);assert.equal(slow.closed,1);
  const frozen=await run({resultKind,frozen:true});assert.equal(frozen.checks.length,14);assert.equal(frozen.sent.length,0);assert.equal(frozen.closed,1);
 }
});
