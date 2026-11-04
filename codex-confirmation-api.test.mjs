import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodexConfirmation} from './lib/codex-confirmation.mjs';

const now = Date.parse('2026-10-29T00:00:00.000Z');
const revision = '8a26882e-428c-42af-b9b4-98b8b068fa13';
const revised = '57e028c3-7a87-43fc-9ee5-ebd7b88552f8';
const facts = () => ({scope:'model',clientId:'panel',
  buildx:{sessionId:'local-session',userId:'local-user',generation:1,verified:true,expiresAt:now+600000},
  codex:{connectionGeneration:1,accountRevision:2,observationSequence:3,observedAt:new Date(now).toISOString(),
    status:'verified',type:'api_key',providerId:'custom-provider',providerRevision:revision,model:'vendor/model',ready:true}});
function fixture(){
  const invalidations=[];
  const owner=createCodexConfirmation({required:true,now:()=>now,onInvalidate:reason=>invalidations.push(reason)});
  const bind=()=>{
    const input=facts(),prepared=owner.prepare(input);assert.equal(prepared.ok,true);
    input.codex.observationSequence++;
    const confirmed=owner.confirm(prepared.value.challengeId,input);assert.equal(confirmed.ok,true);
    return {input,confirmed};
  };
  return {owner,bind,invalidations};
}

test('API local-connection consent explicitly does not assert that model inference succeeded',()=>{
  const f=fixture(),{input,confirmed}=f.bind();
  assert.equal(confirmed.value.confirmation.localConnectionConfirmed,true);
  assert.match(confirmed.value.confirmation.message,/模型可用性仍需另行测试/);
  assert.match(f.owner.status(input).message,/模型可用性仍需另行测试/);
  assert.doesNotMatch(JSON.stringify(confirmed),/custom-provider|vendor\/model|local-session|local-user/);
  f.owner.close();
});

test('verified API mode requires a provider, model and non-secret UUID revision',()=>{
  for(const change of [
    c=>delete c.providerId,c=>delete c.providerRevision,c=>delete c.model,
    c=>{c.providerRevision='credential-derived-hash';},c=>{c.providerRevision='';},
    c=>{c.providerId='invalid provider';},c=>{c.model='';},c=>{c.type='unknown-api-mode';}
  ]){
    const f=fixture(),input=facts();change(input.codex);
    assert.equal(f.owner.prepare(input).ok,false);
    assert.equal(f.owner.status(input).localConnectionConfirmed,false);
    f.owner.close();
  }
});

test('API provider, revision, model, connection or account changes retire previous proof',()=>{
  for(const change of [
    c=>{c.providerId='another';},c=>{c.providerRevision=revised;},c=>{c.model='other/model';},
    c=>{c.connectionGeneration++;},c=>{c.accountRevision++;},
    c=>{c.type='chatgpt';delete c.providerId;delete c.providerRevision;delete c.model;}
  ]){
    const f=fixture(),{input}=f.bind(),changed=structuredClone(input);change(changed.codex);
    assert.equal(f.owner.status(changed).localConnectionConfirmed,false);
    assert.equal(f.invalidations.length,1);
    assert.equal(f.owner.status(input).localConnectionConfirmed,false);
    f.owner.close();
  }
});

test('switching from a confirmed ChatGPT account to an API provider cannot reuse consent',()=>{
  const f=fixture(),chat=facts();
  chat.codex.type='chatgpt';delete chat.codex.providerId;delete chat.codex.providerRevision;delete chat.codex.model;
  const p=f.owner.prepare(chat);chat.codex.observationSequence++;
  assert.equal(f.owner.confirm(p.value.challengeId,chat).ok,true);
  assert.equal(f.owner.status(facts()).localConnectionConfirmed,false);
  assert.deepEqual(f.invalidations,['codex_changed']);f.owner.close();
});

test('an unknown temporary observation suspends API consent without fabricating an identity switch',()=>{
  const f=fixture(),{input}=f.bind(),checking=structuredClone(input);
  checking.codex.status='checking';checking.codex.type=null;checking.codex.ready=false;
  delete checking.codex.providerId;delete checking.codex.providerRevision;delete checking.codex.model;
  assert.equal(f.owner.status(checking).phase,'checking');
  assert.equal(f.owner.status(input).localConnectionConfirmed,true);
  assert.equal(f.invalidations.length,0);f.owner.close();
});

test('a replacement API provider during a pending challenge cannot confirm the original',()=>{
  const f=fixture(),input=facts(),prepared=f.owner.prepare(input);
  input.codex.providerRevision=revised;input.codex.observationSequence++;
  assert.equal(f.owner.confirm(prepared.value.challengeId,input).ok,false);
  assert.equal(f.owner.status(input).localConnectionConfirmed,false);
  assert.deepEqual(f.invalidations,['codex_changed']);f.owner.close();
});
