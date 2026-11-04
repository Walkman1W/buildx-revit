import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {EventEmitter} from 'node:events';
import {createApprovedTerminal,createTerminalGate} from './lib/approved-terminal-gate.mjs';

const original={userId:'test-user',sessionId:'test-session',threadId:'test-thread',turnId:'test-turn',generation:1,revision:1};
async function missing(file){try{await stat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function completed(gate,scope,approvalId){
  for(let i=0;i<200;i++){
    const state=gate.status({scope,approvalId});
    assert.equal(state.ok,true);
    if(state.value.state==='completed')return state.value;
    if(state.value.state==='unknown')throw new Error(`Child outcome unknown: ${state.value.reason}`);
    await delay(20);
  }
  throw new Error('Child did not finish in time');
}

test('real child starts only after a matching one-use approval and reports its real output',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'buildx-approved-terminal-'));
  const marker=path.join(dir,'approved-marker.txt');
  const gate=createApprovedTerminal({currentScope:()=>original});
  try{
    const proposed=gate.propose({scope:original,requestId:'real-allow',executable:process.execPath,cwd:dir,
      args:['-e',"require('node:fs').writeFileSync(process.argv[1],'approved'); console.log('finished');",marker]});
    assert.equal(proposed.ok,true);
    await delay(100);
    assert.equal(await missing(marker),true);
    assert.equal(gate.respond({scope:original,approvalId:proposed.value.approvalId,expectedDigest:'invalid',decision:'accept'}).error.code,'APPROVAL_INVALID');
    assert.equal(await missing(marker),true);
    const decision={scope:original,approvalId:proposed.value.approvalId,expectedDigest:proposed.value.digest,decision:'accept'};
    assert.equal(gate.respond(decision).ok,true);
    assert.equal(gate.respond(decision).error.code,'ALREADY_SETTLED');
    const result=await completed(gate,original,proposed.value.approvalId);
    assert.equal(result.output.exitCode,0);
    assert.match(result.output.stdout,/finished/);
    assert.equal(await readFile(marker,'utf8'),'approved');
  }finally{await gate.close();await rm(dir,{recursive:true,force:true});}
});

test('declined and invalidated real commands do not start',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'buildx-approved-terminal-'));
  const marker=path.join(dir,'denied-marker.txt');
  let scope={...original};const gate=createApprovedTerminal({currentScope:()=>scope});
  try{
    const request=id=>gate.propose({scope,requestId:id,executable:process.execPath,cwd:dir,
      args:['-e',"require('node:fs').writeFileSync(process.argv[1],'ran');",marker]});
    const denied=request('deny');assert.equal(denied.ok,true);
    assert.equal(gate.respond({scope,approvalId:denied.value.approvalId,expectedDigest:denied.value.digest,decision:'decline'}).ok,true);
    assert.equal(gate.respond({scope,approvalId:denied.value.approvalId,expectedDigest:denied.value.digest,decision:'accept'}).error.code,'ALREADY_SETTLED');
    const stale=request('stale');assert.equal(stale.ok,true);const oldScope=scope;scope={...scope,revision:2};gate.invalidate();
    assert.equal(gate.respond({scope:oldScope,approvalId:stale.value.approvalId,expectedDigest:stale.value.digest,decision:'accept'}).error.code,'SCOPE_CHANGED');
    await delay(100);assert.equal(await missing(marker),true);
  }finally{await gate.close();await rm(dir,{recursive:true,force:true});}
});

test('release frees capacity without allowing replay and keeps a bounded request history',async()=>{
  const gate=createTerminalGate({currentScope:()=>original,spawn:()=>{throw new Error('should not start');},maxJobs:1,maxRequests:2});
  const request=id=>gate.propose({scope:original,requestId:id,executable:process.execPath,cwd:process.cwd(),args:[]});
  const a=request('a');assert.equal(a.ok,true);
  assert.equal(gate.release({scope:original,approvalId:a.value.approvalId}).error.code,'NOT_SETTLED');
  assert.equal(gate.respond({scope:original,approvalId:a.value.approvalId,expectedDigest:a.value.digest,decision:'decline'}).ok,true);
  assert.equal(request('b').error.code,'CAPACITY');
  assert.equal(gate.release({scope:original,approvalId:a.value.approvalId}).ok,true);
  assert.equal(request('a').error.code,'DUPLICATE_REQUEST');
  const b=request('b');assert.equal(b.ok,true);
  gate.respond({scope:original,approvalId:b.value.approvalId,expectedDigest:b.value.digest,decision:'decline'});
  assert.equal(gate.release({scope:original,approvalId:b.value.approvalId}).ok,true);
  assert.equal(request('c').error.code,'REQUEST_HISTORY_FULL');
  assert.equal((await gate.close()).ok,true);
});

test('failed cleanup retains the owned child and prevents result release until close',async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();let kills=0;
  child.kill=()=>{kills++;return false;};
  const gate=createTerminalGate({currentScope:()=>original,spawn:()=>child,maxJobs:1,cleanupWaitMs:5});
  const p=gate.propose({scope:original,requestId:'pending-cleanup',executable:process.execPath,cwd:process.cwd(),args:[]});
  const decision={scope:original,approvalId:p.value.approvalId,expectedDigest:p.value.digest,decision:'accept'};
  assert.equal(gate.respond(decision).ok,true);
  assert.equal(gate.cancel({scope:original,approvalId:p.value.approvalId}).ok,true);
  assert.equal((await gate.retryCleanup(p.value.approvalId)).error.code,'CLEANUP_PENDING');
  assert.ok(kills>=2);
  assert.equal(gate.release({scope:original,approvalId:p.value.approvalId}).error.code,'NOT_SETTLED');
  assert.equal((await gate.close()).error.code,'CLEANUP_PENDING');
  child.emit('close',null,'SIGTERM');
  assert.equal((await gate.retryCleanup(p.value.approvalId)).ok,true);
  assert.equal(gate.release({scope:original,approvalId:p.value.approvalId}).ok,true);
  assert.equal((await gate.close()).ok,true);
});

test('output stream errors interrupt the child and retain an unknown outcome',async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();let kills=0;
  child.kill=()=>{kills++;return true;};
  const gate=createTerminalGate({currentScope:()=>original,spawn:()=>child});
  const p=gate.propose({scope:original,requestId:'stream-error',executable:process.execPath,cwd:process.cwd(),args:[]});
  gate.respond({scope:original,approvalId:p.value.approvalId,expectedDigest:p.value.digest,decision:'accept'});
  child.stdout.emit('error',new Error('broken stream'));
  assert.equal(kills,1);
  assert.equal(gate.status({scope:original,approvalId:p.value.approvalId}).value.outcome,'unknown');
  child.emit('close',null,'SIGTERM');
  assert.equal(gate.status({scope:original,approvalId:p.value.approvalId}).value.reason,'output_error');
  assert.equal((await gate.close()).ok,true);
});
