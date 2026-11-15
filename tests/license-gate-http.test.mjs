import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

test('a revoked licence blocks new turns and steer, while stopping an existing turn remains possible',async t=>{
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,requireLicense:true});t.after(()=>f.close());
  let steers=0;f.codex.steer=async(_thread,turnId)=>{steers++;return {turnId};};
  const signed=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=signed.cookie;
  assert.equal((await f.confirm(cookie)).status,200);
  f.setLicense('disabled');assert.equal((await f.post('turn',{message:'blocked'},cookie)).status,403);assert.equal(f.codex.turns.length,0);
  f.setLicense('trial');assert.equal((await f.post('turn',{message:'start'},cookie)).status,202);
  const conversationId=f.app.snapshot('model-test-client').session.conversationId,turnId=f.codex.turns[0].turnId;
  f.setLicense('disabled');
  const steer=await f.post('steer',{conversationId,turnId,requestId:randomUUID(),message:'do more'},cookie);
  assert.equal(steer.status,403);assert.equal(steers,0);
  assert.equal((await f.post('interrupt',{},cookie)).status,202);assert.equal(f.codex.interrupts.length,1);
});
