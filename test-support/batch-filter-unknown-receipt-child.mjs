import assert from 'node:assert/strict';
import {typeWriteHttpFixture,waitTypeWrite,TYPE_WRITE_DOCUMENT} from './batch-filter-write-http-fixture.mjs';
const t={after(){}};const f=await typeWriteHttpFixture(t,{writeReceiptCorrupt:true});await f.choose('automatic');await f.begin();
const args={expected_document:TYPE_WRITE_DOCUMENT.path,category:'OST_Walls',parameter_id:'-100',mode:'rollback',storage_type:'Integer',value:9};f.codex.request(1,args);await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();assert.equal((await f.decide(p)).status,200);await waitTypeWrite(()=>f.codex.answers.length===1&&Boolean(f.app.snapshot('browser').modelReceipt));
const first=f.queue.requests[1];assert.equal(f.codex.answers[0].success,false);assert.equal(f.queue.requests.length,2);assert.equal((await f.decide(p)).status,409);f.codex.request(2,args);await waitTypeWrite(()=>f.codex.answers.length===2);assert.equal(f.queue.requests.length,2);
const receipt=f.app.snapshot('browser').modelReceipt;const check=await f.post('model-receipt/check',{conversationId:f.session,ticket:receipt.ticket});assert.equal(check.status,200);const checked=f.app.snapshot('browser').modelReceipt;assert.equal(checked.check.status,'unconfirmed');assert.equal(checked.check.requestId,first.id);
await assert.rejects(f.app.close(),/模型操作原回执尚未确认/);
console.log(JSON.stringify({status:'passed',requestId:first.id,receiptStatus:checked.check.status,queueRoot:f.queue.options().root,requestCount:f.queue.requests.length,cleanup:'refused_unknown_as_expected'}));
process.exit(0);
