import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createCabinetWriteGate} from '../../lib/cabinet-write-gate.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const keys=['requestId','requestDigest','requestFileIdentity','directoryIdentity','hostSession','hostPid','hostStartedUtc','accountId','authorizationId'];
const attempt=(id='request-1')=>({requestId:id,requestDigest:hash('native bytes'),requestFileIdentity:'file-id',directoryIdentity:'chain-id',hostSession:'host-1',hostPid:123,hostStartedUtc:'2026-11-01T00:00:00Z',accountId:'account-1',authorizationId:'decision-1'});
const attemptDigest=x=>hash(JSON.stringify(keys.map(k=>x[k])));
function fixture(events=[]){
  let locked=false;const f={events,authorize:true,terminal:true,complete:true,failAppend:false,failRelease:false};
  f.lock={async acquire(){if(locked)throw Error();locked=true;return {async verify(){return locked;},async release(){if(f.failRelease)return false;locked=false;return true;}};}};
  f.journal={async load(){return {complete:f.complete,events:structuredClone(f.events)};},async appendAttempt(value){if(f.failAppend)throw Error();f.events.push({kind:'attempt',value});return true;},async appendResolution(value){f.events.push({kind:'resolution',value});return true;}};
  f.verifier={async authorize(){return f.authorize;},async verifyTerminal(a,proof){return f.terminal&&proof.confirmed?{requestId:a.requestId,attemptDigest:attemptDigest(a),receiptDigest:hash('actual receipt'),decisionId:'ack-1'}:null;}};
  f.gate=()=>createCabinetWriteGate(f);return f;
}

test('records original identity before permitting one publication, only verified terminal resolves',async()=>{
  const f=fixture(),g=f.gate(),a=attempt();assert.deepEqual(g.status(),{closed:false,ready:false,blocked:true,poisoned:null});assert.equal((await g.ready()).blocked,false);
  assert.equal((await g.begin(a)).ok,true);assert.equal(f.events.length,1);assert.deepEqual(f.events[0].value,a);
  assert.equal((await g.begin(attempt('other'))).code,'ATTEMPT_PENDING');
  assert.equal((await g.resolve({confirmed:false})).code,'TERMINAL_UNVERIFIED');
  assert.equal((await g.inspect()).blocked,true);assert.equal((await g.resolve({confirmed:true})).ok,true);
  assert.equal((await g.inspect()).blocked,false);const count=f.events.length;assert.equal((await g.begin(a)).code,'REQUEST_ID_REUSED');assert.equal(f.events.length,count);
  assert.equal((await g.close()).ok,true);assert.equal(g.status().blocked,true);const reopened=f.gate();assert.equal((await reopened.ready()).blocked,false);assert.equal((await reopened.begin(a)).code,'REQUEST_ID_REUSED');assert.equal(f.events.length,count);
  assert.equal((await reopened.begin(attempt('other'))).ok,true);assert.equal((await reopened.close()).ok,true);
});

test('invalid input, unverified authority and forged terminal cannot open gate',async()=>{
  const f=fixture(),g=f.gate();await g.ready();assert.equal((await g.begin({...attempt(),requestDigest:'bad'})).code,'INVALID_ATTEMPT');
  f.authorize=false;assert.equal((await g.begin(attempt())).code,'AUTHORIZATION_UNVERIFIED');assert.equal(f.events.length,0);
  f.authorize=true;await g.begin(attempt());f.verifier.verifyTerminal=async a=>({requestId:'wrong',attemptDigest:attemptDigest(a),receiptDigest:hash('x'),decisionId:'ack'});
  assert.equal((await g.resolve({confirmed:true})).code,'TERMINAL_UNVERIFIED');assert.equal((await g.inspect()).blocked,true);await g.close();
});

test('corrupt/incomplete inventory, write uncertainty and failed cleanup stay closed',async()=>{
  for(const events of [[{kind:'resolution',value:{}}],[{kind:'attempt',value:attempt()},{kind:'attempt',value:attempt('second')}]]){
    const f=fixture(events),g=f.gate();assert.equal((await g.ready()).code,'GATE_UNCONFIRMED');assert.equal((await g.begin(attempt())).code,'GATE_UNCONFIRMED');await g.close();
  }
  const f=fixture(),g=f.gate();f.complete=false;assert.equal((await g.ready()).code,'GATE_UNCONFIRMED');await g.close();
  const h=fixture(),g2=h.gate();await g2.ready();h.failAppend=true;assert.equal((await g2.begin(attempt())).code,'GATE_UNCONFIRMED');assert.equal((await g2.begin(attempt())).code,'GATE_UNCONFIRMED');h.failRelease=true;assert.equal((await g2.close()).code,'LOCK_CLEANUP_UNCONFIRMED');h.failRelease=false;assert.equal((await g2.close()).ok,true);
});

test('lock owner serializes concurrent requests and preserves pending on a new instance',async()=>{
  const f=fixture(),g=f.gate(),other=f.gate();await g.ready();assert.equal((await other.ready()).code,'GATE_UNCONFIRMED');
  const results=await Promise.all([g.begin(attempt('one')),g.begin(attempt('two'))]);assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.filter(x=>x.code==='ATTEMPT_PENDING').length,1);
  await g.close();const restarted=f.gate();assert.equal((await restarted.ready()).blocked,true);assert.equal((await restarted.begin(attempt('three'))).code,'ATTEMPT_PENDING');await restarted.close();
});

test('capacity reserves a resolution before recording the last possible attempt',async()=>{
  const events=[];for(let i=0;i<4999;i++){const a=attempt(`historic-${i}`);events.push({kind:'attempt',value:a},{kind:'resolution',value:{requestId:a.requestId,attemptDigest:attemptDigest(a),receiptDigest:hash('receipt'),decisionId:`ack-${i}`}});}
  const f=fixture(events),g=f.gate();assert.equal((await g.ready()).blocked,false);assert.equal((await g.begin(attempt('last'))).ok,true);assert.equal(f.events.length,9999);
  assert.equal((await g.resolve({confirmed:true})).ok,true);assert.equal(f.events.length,10000);assert.equal((await g.begin(attempt('overflow'))).code,'JOURNAL_CAPACITY');assert.equal(f.events.length,10000);assert.equal((await g.inspect()).blocked,false);await g.close();
  const restarted=f.gate();assert.equal((await restarted.ready()).blocked,false);assert.equal((await restarted.begin(attempt('after-restart'))).code,'JOURNAL_CAPACITY');assert.equal(f.events.length,10000);await restarted.close();
});

test('isolated child exits after prepublication record and new process sees blocker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cabinet-gate-'));const file=path.join(root,'journal.json');fs.writeFileSync(file,'[]');
  try{
    const module=pathToFileURL(path.resolve('lib/cabinet-write-gate.mjs')).href;
    const code=`import fs from 'node:fs';import {createCabinetWriteGate} from ${JSON.stringify(module)};const file=process.argv[1],attempt=JSON.parse(process.argv[2]);const lock={async acquire(){return {async verify(){return true},async release(){return true}}}};const journal={async load(){return {complete:true,events:JSON.parse(fs.readFileSync(file,'utf8'))}},async appendAttempt(value){const events=JSON.parse(fs.readFileSync(file,'utf8'));events.push({kind:'attempt',value});fs.writeFileSync(file,JSON.stringify(events));return true},async appendResolution(){return false}};const verifier={async authorize(){return true},async verifyTerminal(){return null}};const gate=createCabinetWriteGate({lock,journal,verifier});await gate.ready();const result=await gate.begin(attempt);if(!result.ok)process.exit(2);process.exit(17);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code,file,JSON.stringify(attempt())],{encoding:'utf8'});assert.equal(child.status,17,child.stderr);
    const f=fixture(JSON.parse(fs.readFileSync(file,'utf8'))),g=f.gate();const state=await g.ready();assert.equal(state.blocked,true);assert.equal(state.attempt.requestId,'request-1');assert.equal((await g.begin(attempt('again'))).code,'ATTEMPT_PENDING');await g.close();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
