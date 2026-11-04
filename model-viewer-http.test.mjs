import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';

test('viewer retains an unknown capture receipt and requires an explicit check before retry',async t=>{
  let count=0,closed=0,checked=0;
  const receipt=Object.freeze({inspect:async()=>{checked++;return {ok:true,value:{status:'received',canCheckAgain:false,message:'receipt found'}};},close:async()=>{closed++;return {ok:true,value:{closed:true}};}});
  const viewer=Object.freeze({
    async refresh(){count++;if(count===1){const result={ok:false,error:{code:'CAPTURE_REQUEST_FAILED',outcome:'unconfirmed'},evidence:{requestIds:['receipt-1']}};Object.defineProperty(result,'receiptOwner',{value:receipt});return result;}return {ok:true,value:{snapshotId:'snapshot-1'}};},
    async status(){return {ok:true,value:{state:'freshness_unknown'}};},get(id){return {ok:id==='snapshot-1',value:{snapshotId:id}};},locate(){return {ok:true,value:{}};}
  });
  const f=await createModelWorkspaceFixture({viewerService:viewer});t.after(()=>f.close());
  const login=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=login.cookie;
  const call=(action,parameters={})=>f.post('model-viewer',{action,parameters},cookie);
  const firstId=randomUUID(),secondId=randomUUID();
  const first=await call('refresh',{requestId:firstId});assert.equal(first.body.error.outcome,'unconfirmed');
  assert.equal((await call('refresh',{requestId:secondId})).status,409);assert.equal(count,1);
  assert.equal((await call('check',{requestId:firstId})).status,200);assert.equal(checked,1);assert.equal(closed,1);
  assert.equal((await call('refresh',{requestId:secondId})).status,200);assert.equal(count,2);
  assert.equal((await call('refresh',{requestId:secondId})).status,409);assert.equal(count,2);
  const checkedSuccess=await call('check',{requestId:secondId});assert.equal(checkedSuccess.body.value.status,'received');assert.equal(checkedSuccess.body.value.snapshotId,'snapshot-1');
  assert.equal((await call('status')).body.value.state,'freshness_unknown');
  assert.equal((await call('get',{snapshotId:'snapshot-1'})).body.value.snapshotId,'snapshot-1');
  assert.equal((await call('get',{snapshotId:'snapshot-1',rootPath:'C:\\'})).status,400);
});

test('unknown receipt survives sign-out and only the same verified user can inspect it',async t=>{
  let closed=0;const receipt=Object.freeze({inspect:async()=>({ok:true,value:{status:'received',canCheckAgain:false}}),close:async()=>{closed++;return {ok:true,value:{closed:true}};}});
  const service=Object.freeze({async refresh(){const result={ok:false,error:{outcome:'unconfirmed'}};Object.defineProperty(result,'receiptOwner',{value:receipt});return result;},async status(){return {ok:true,value:{state:'empty'}};},get(){return {ok:false};},locate(){return {ok:false};}});
  const f=await createModelWorkspaceFixture({viewerService:service});t.after(()=>f.close());
  const login=async email=>(await f.post('account/sign-in',{email,password:'fixture-password'})).cookie;
  let cookie=await login('demo@example.invalid');const requestId=randomUUID();
  await f.post('model-viewer',{action:'refresh',parameters:{requestId}},cookie);
  assert.equal((await f.post('account/sign-out',{},cookie)).status,200);assert.equal(closed,0);
  cookie=await login('other@example.invalid');assert.equal((await f.post('model-viewer',{action:'check',parameters:{requestId}},cookie)).status,409);
  await f.post('account/sign-out',{},cookie);cookie=await login('demo@example.invalid');
  assert.equal((await f.post('model-viewer',{action:'check',parameters:{requestId}},cookie)).status,200);assert.equal(closed,1);
});

test('account switching and server close wait for an in-flight capture and retain late cleanup',async t=>{
  let finish,started;const entered=new Promise(resolve=>{started=resolve;});let closed=0;
  const receipt=Object.freeze({inspect:async()=>({ok:true,value:{status:'pending',canCheckAgain:true}}),close:async()=>{closed++;return {ok:true,value:{closed:true}};}});
  const service=Object.freeze({refresh:()=>{started();return new Promise(resolve=>{finish=()=>{const result={ok:false,error:{outcome:'unconfirmed'}};Object.defineProperty(result,'receiptOwner',{value:receipt});resolve(result);};});},async status(){return {ok:true,value:{state:'empty'}};},get(){return {ok:false};},locate(){return {ok:false};}});
  const f=await createModelWorkspaceFixture({viewerService:service});t.after(()=>f.close());
  const cookie=(await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'})).cookie;
  const operation=f.post('model-viewer',{action:'refresh',parameters:{requestId:randomUUID()}},cookie);await entered;
  assert.equal((await f.post('account/sign-out',{},cookie)).status,409);
  let stopped=false;const shutdown=f.app.close().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,25));assert.equal(stopped,false);
  finish();await operation;await shutdown;assert.equal(closed,1);
});

test('binding a different project invalidates the previously linked viewer snapshot',async t=>{
  const os=await import('node:os'),path=await import('node:path'),fs=await import('node:fs/promises');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-viewer-project-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const service=Object.freeze({async refresh(){return {ok:true,value:{snapshotId:'one'}};},async status(){return {ok:true,value:{state:'freshness_unknown',snapshotId:'one'}};},get(){return {ok:true,value:{snapshotId:'one'}};},locate(){return {ok:true,value:{}};}});
  const f=await createModelWorkspaceFixture({required:false,viewerService:service});t.after(()=>f.close());
  const bind=id=>f.post('project-knowledge',{action:'bind',parameters:{projectId:id,rootPath:dir}});
  assert.equal((await bind('A')).status,200);
  assert.equal((await f.post('model-viewer',{action:'refresh',parameters:{requestId:randomUUID()}})).status,200);
  assert.equal((await f.post('model-viewer',{action:'status',parameters:{}})).body.value.snapshotId,'one');
  assert.equal((await bind('B')).status,200);
  assert.equal((await f.post('model-viewer',{action:'status',parameters:{}})).body.value.state,'empty');
  assert.equal((await f.post('model-viewer',{action:'get',parameters:{snapshotId:'one'}})).status,409);
});
