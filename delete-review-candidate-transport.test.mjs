import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startInternalDeleteReview} from './lib/delete-review-candidate-transport.mjs';
const session='a'.repeat(32),doc={session,path:'D:\\controlled\\demo.rvt',title:'demo'},args={mode:'commit',target_kind:'sheet',target_id:'3',target_unique_id:'uid-3'},access={id:'93078f13-16a8-4c1c-9120-358f22dbe801',revision:1,accountScope:'test'};
async function fixture(){const base=path.resolve('artifacts');await fs.mkdir(base,{recursive:true});const queue=await fs.mkdtemp(path.join(base,'delete-review-node-'));for(const x of ['inbox','processing','outbox','cancel'])await fs.mkdir(path.join(queue,x));await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:123,version:'0.8.9',startedUtc:'2026-01-01T00:00:00Z',nativeDeleteReviewCandidateVersion:1}));return queue;}
const opts=queue=>({queue,sourceDocument:doc,args,accessPolicy:access,isCurrent:()=>true,timeoutMs:30000});
async function claim(queue,id){const from=path.join(queue,'inbox',id+'.json'),to=path.join(queue,'processing',id+'.json');const raw=await fs.readFile(from,'utf8');await fs.rename(from,to);return JSON.parse(raw);}
async function respond(queue,id,value){await fs.writeFile(path.join(queue,'outbox',id+'.json'),JSON.stringify(value),{flag:'wx'});}
function success(id,patch={}){return {id,ok:true,completedUtc:new Date().toISOString(),result:{operation:'internal_delete_review_candidate',request_id:id,hostSession:session,document:{title:doc.title,path:doc.path},status:'delete_declined',mode:'commit',affected:[{element_id:'3',unique_id:'uid-3'},{element_id:'15',unique_id:'uid-15'}],target_id:'3',target_unique_id:'uid-3',target_kind:'sheet',preview_expires_utc:new Date(Date.now()+60000).toISOString(),...patch}};}
test('actual isolated queue uses one original request and verifies bound native receipt',async()=>{
 const q=await fixture(),run=await startInternalDeleteReview(opts(q));let inspect=run.receiptOwner.inspect();assert.equal(inspect.value.status,'pending');
 const request=await claim(q,run.requestId);assert.equal(request.id,run.requestId);assert.equal(request.targetSession,session);assert.equal(request.operation,'internal_delete_review_candidate');assert.equal(request.args.expected_document,doc.path);assert.deepEqual(request.accessPolicy,access);assert.equal(Object.hasOwn(request.args,'confirmed'),false);
 await respond(q,run.requestId,success(run.requestId));inspect=run.receiptOwner.inspect();assert.equal(inspect.value.status,'declined');assert.equal(inspect.value.committed,false);assert.equal(inspect.value.value.status,'delete_declined');assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);assert.equal((await fs.readdir(path.join(q,'processing'))).length,1);assert.equal(run.receiptOwner.close().ok,true);
});
test('unknown, cancellation and late original response retain owner without replay',async()=>{
 const q=await fixture(),run=await startInternalDeleteReview(opts(q));await claim(q,run.requestId);assert.equal((await run.cancel()).ok,true);assert.equal((await run.cancel()).ok,true);
 const marker=JSON.parse(await fs.readFile(path.join(q,'cancel',run.requestId+'.json'),'utf8'));assert.equal(marker.target_session,session);assert.equal(marker.request_id,run.requestId);
 await respond(q,run.requestId,{id:run.requestId,ok:false,hostSession:session,completedUtc:new Date().toISOString(),execution:{started:true,phase:'dispatch',reason:null},error:{code:'DELETE_REVIEW_OUTCOME_UNKNOWN'},transaction:{outcome:'unknown'}});
 const status=run.receiptOwner.inspect();assert.equal(status.value.status,'unconfirmed');assert.equal(status.value.terminal,false);assert.equal((await fs.readdir(path.join(q,'processing'))).length,1);assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);assert.equal(run.receiptOwner.close().ok,true);
});
test('mismatched host receipt and forged caller confirmation fail closed',async()=>{
 const q=await fixture();await assert.rejects(startInternalDeleteReview({...opts(q),args:{...args,confirmed:true}}));assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);
 const run=await startInternalDeleteReview(opts(q));await claim(q,run.requestId);await respond(q,run.requestId,success(run.requestId,{hostSession:'b'.repeat(32)}));const status=run.receiptOwner.inspect();assert.equal(status.ok,false);assert.equal(status.error.code,'RECEIPT_UNCONFIRMED');assert.equal((await fs.readdir(path.join(q,'processing'))).length,1);run.receiptOwner.close();
});
test('default host and changed access are rejected before publication',async()=>{
 const q=await fixture();await fs.writeFile(path.join(q,'host.json'),JSON.stringify({sessionId:session,pid:123,version:'0.8.9'}));await assert.rejects(startInternalDeleteReview(opts(q)));assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);
 await fs.writeFile(path.join(q,'host.json'),JSON.stringify({sessionId:session,pid:123,version:'0.8.9',startedUtc:'2026-01-01T00:00:00Z',nativeDeleteReviewCandidateVersion:1}));await assert.rejects(startInternalDeleteReview({...opts(q),isCurrent:()=>false}));assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);
});

test('isolated original queue round trip invokes controlled C# host adapter without replay',async()=>{
 const {execFileSync}=await import('node:child_process');let exe=process.env.BUILDX_DELETE_QUEUE_PEER;
 if(!exe){const {randomUUID}=await import('node:crypto');const evidence=path.resolve('artifacts','queue-peer-'+randomUUID());await fs.mkdir(path.dirname(evidence),{recursive:true});execFileSync('powershell.exe',['-NoProfile','-File',path.resolve('tools/build-delete-queue-peer.ps1'),'-EvidenceDirectory',evidence],{encoding:'utf8'});exe=path.join(evidence,'queue-peer.exe');}

 for(const [scenario,wanted] of [['second_no','declined'],['unknown','unconfirmed']]){
  const q=await fixture(),run=await startInternalDeleteReview(opts(q));execFileSync(exe,[q,run.requestId,scenario],{encoding:'utf8'});
  const evidence=run.receiptOwner.inspect();assert.equal(evidence.ok,true);assert.equal(evidence.value.status,wanted);
  assert.equal((await fs.readdir(path.join(q,'processing'))).length,1);assert.equal((await fs.readdir(path.join(q,'outbox'))).length,1);assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);
  if(scenario==='second_no')assert.equal(evidence.value.value.status,'delete_declined');else assert.equal(evidence.value.terminal,false);
  assert.throws(()=>execFileSync(exe,[q,run.requestId,scenario],{stdio:'ignore'}));assert.equal((await fs.readdir(path.join(q,'processing'))).length,1);run.receiptOwner.close();
 }
});

test('original claimed request replacement or host restart never validates a response',async()=>{
 const q=await fixture(),run=await startInternalDeleteReview(opts(q));await claim(q,run.requestId);await respond(q,run.requestId,success(run.requestId));
 const claimed=path.join(q,'processing',run.requestId+'.json');await fs.writeFile(claimed,'tampered');let found=run.receiptOwner.inspect();assert.equal(found.ok,false);assert.equal(found.error.code,'RECEIPT_UNCONFIRMED');
 await fs.writeFile(path.join(q,'host.json'),JSON.stringify({sessionId:'b'.repeat(32),pid:123,version:'0.8.9',startedUtc:'2026-01-01T00:00:00Z',nativeDeleteReviewCandidateVersion:1}));found=run.receiptOwner.inspect();assert.equal(found.value.status,'host_changed');assert.equal(found.value.terminal,false);assert.equal((await fs.readdir(path.join(q,'inbox'))).length,0);run.receiptOwner.close();
});

test('both refusals and rollback previews are terminal without claiming a commit',async()=>{
 for(const [mode,state,expected] of [['commit','preview_declined','declined'],['commit','delete_declined','declined'],['rollback','preview_rolled_back','preview_rolled_back']]){
  const q=await fixture(),run=await startInternalDeleteReview({...opts(q),args:{...args,mode}});await claim(q,run.requestId);
  const patch={mode,status:state,...state==='preview_declined'?{affected:null,preview_expires_utc:null}:{}};await respond(q,run.requestId,success(run.requestId,patch));const checked=run.receiptOwner.inspect();
  assert.equal(checked.value.status,expected);assert.equal(checked.value.outcome,state);assert.equal(checked.value.committed,false);assert.equal(checked.value.terminal,true);run.receiptOwner.close();
 }
});

test('contradictory unknown failure never becomes not-started',async()=>{
 const q=await fixture(),run=await startInternalDeleteReview(opts(q));await claim(q,run.requestId);
 await respond(q,run.requestId,{id:run.requestId,ok:false,hostSession:session,completedUtc:new Date().toISOString(),execution:{started:false,phase:'validation',reason:null},error:{code:'DELETE_REVIEW_OUTCOME_UNKNOWN'}});
 const found=run.receiptOwner.inspect();assert.equal(found.value.status,'unconfirmed');assert.equal(found.value.terminal,false);run.receiptOwner.close();
});
