import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedPanelInference} from './lib/managed-panel-inference.mjs';
const account={id:'u'},connection={id:'c'};
function fixture(overrides={}){
  const calls=[];let valid=true;
  const owner=createManagedPanelInference({isCurrent:()=>valid,openTurn:async()=>({turnId:'turn',expiresAt:100}),finishTurn:async value=>{calls.push(value);return {closed:true};},now:()=>1,...overrides});
  return {owner,calls,deny:()=>valid=false};
}
const begin=owner=>owner.beginTurn({account,connection,requestGrant:async turnId=>({turnId,token:'fixture',expiresAt:90})});
test('one turn serves grants and closes once',async()=>{
  const {owner,calls}=fixture();assert.equal(owner.isIdleForModeSwitch(),true);
  const lease=await begin(owner);assert.ok(Object.isFrozen(lease));
  assert.equal(owner.isIdleForModeSwitch(),false);
  assert.deepEqual(await owner.getCloudAuthorization(),{turnId:'turn',token:'fixture',expiresAt:90});
  await assert.rejects(begin(owner));assert.deepEqual(await lease.close(),{closed:true});assert.deepEqual(await lease.close(),{closed:true});assert.equal(calls.length,1);
  assert.equal(owner.isIdleForModeSwitch(),true);
  const next=await begin(owner);await next.close();assert.deepEqual(await owner.close(),{closed:true});
  assert.equal(owner.isIdleForModeSwitch(),false);
});
test('identity revocation during grant discards it',async()=>{
  const {owner,deny}=fixture();let release;const grant=new Promise(r=>release=r);
  const lease=await owner.beginTurn({account,connection,requestGrant:()=>grant});
  const pending=owner.getCloudAuthorization();await new Promise(r=>setImmediate(r));deny();release({turnId:'turn',token:'fixture'});
  await assert.rejects(pending);await lease.close();
});
test('abort closes turn and failed close blocks overlap without replay',async()=>{
  let calls=0;const {owner}=fixture({finishTurn:async()=>{calls++;throw Error('unknown');}});const controller=new AbortController();
  const lease=await owner.beginTurn({account,connection,requestGrant:async()=>({turnId:'turn',token:'fixture'}),signal:controller.signal});controller.abort();
  assert.deepEqual(await lease.close(),{closed:false});assert.equal(owner.isIdleForModeSwitch(),false);
  assert.deepEqual(await owner.close(),{closed:false});assert.equal(calls,1);await assert.rejects(begin(owner));
});
test('abort while opening waits for and closes that same turn',async()=>{
  let release;const pendingOpen=new Promise(r=>release=r);const {owner,calls}=fixture({openTurn:()=>pendingOpen});const controller=new AbortController();
  const start=owner.beginTurn({account,connection,requestGrant:()=>{},signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();release({turnId:'turn',expiresAt:100});
  await assert.rejects(start);assert.deepEqual(await owner.close(),{closed:true});assert.deepEqual(calls,[{account,turnId:'turn'}]);
});

test('known rejected open releases slot; unconfirmed close stays blocked',async()=>{
  let reject=true;const {owner}=fixture({openTurn:async()=>reject?null:{turnId:'turn',expiresAt:100},finishTurn:async()=>({closed:false})});
  await assert.rejects(begin(owner));assert.equal(owner.isIdleForModeSwitch(),true);
  reject=false;const lease=await begin(owner);assert.deepEqual(await lease.close(),{closed:false});await assert.rejects(begin(owner));
});

test('an unconfirmed open retains the original slot and blocks mode retirement',async()=>{
  const {owner}=fixture({openTurn:async()=>{throw Error('unknown');}});
  await assert.rejects(begin(owner));
  assert.equal(owner.isIdleForModeSwitch(),false);
  await assert.rejects(begin(owner));
  assert.deepEqual(await owner.close(),{closed:false});
});
