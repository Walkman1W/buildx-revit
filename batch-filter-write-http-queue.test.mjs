import test from 'node:test';import assert from 'node:assert/strict';
import {typeWriteHttpFixture,waitTypeWrite,TYPE_WRITE_DOCUMENT} from './test-support/batch-filter-write-http-fixture.mjs';
test('closed fixture: conversation to prepare, HTTP decision, one write and original receipt',async t=>{
 const f=await typeWriteHttpFixture(t);assert.equal((await f.choose('automatic')).status,200);assert.equal((await f.begin()).status,202);
 const args={expected_document:TYPE_WRITE_DOCUMENT.path,category:'OST_Walls',parameter_id:'-100',mode:'rollback',storage_type:'Integer',value:9};f.codex.request(1,args);
 await waitTypeWrite(()=>Boolean(f.preview()));const p=f.preview();assert.equal(JSON.parse(p.batchFilterWriteReview).total,1);assert.equal(f.writes.length,0);assert.equal((await f.decide(p)).status,200);assert.equal((await f.decide(p)).status,409);
 await waitTypeWrite(()=>f.codex.answers.length===1);assert.equal(f.writes.length,1);assert.equal(f.queue.requests.length,2);assert.equal(f.queue.requests[1].operation,'batch_set_parameters_by_filter');assert.equal(f.codex.answers[0].success,true);assert.equal(f.receiptSnapshots[0].status,'received');assert.equal(f.receiptSnapshots[0].requestId,f.queue.requests[1].id);
});
