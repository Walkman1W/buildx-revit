import assert from 'node:assert/strict';
import test from 'node:test';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';

const ownedTurn = Object.freeze({sessionId:'session-one', turnId:'turn-one'});
const facts = Object.freeze({...ownedTurn, accountId:'account-one', verified:true, expiresAt:1100});
const request = grant => ({authorization:'Bearer '+grant.token, turnId:grant.turnId, model:'pilot-model'});
const options = {model:'pilot-model', ttlMs:500, now:() => 1000};

test('grant is bound to a verified cloud session, model and turn, then consumed once', async t => {
  const owner = createManagedInferenceGrants({
    ...options,
    resolveTurn:({sessionId,turnId}) => sessionId===ownedTurn.sessionId&&turnId===ownedTurn.turnId ? facts : null
  });
  t.after(owner.close);
  assert.equal(await owner.issue({...ownedTurn,sessionId:'other-session'}),null);
  const grant = await owner.issue(ownedTurn);
  assert.equal(grant.expiresAt,1100);
  assert.deepEqual(await owner.authorizationOwner.authorize({...request(grant),turnId:'other-turn'}),{allowed:false});
  assert.deepEqual(await owner.authorizationOwner.authorize({...request(grant),model:'other-model'}),{allowed:false});
  const attempts = await Promise.all([
    owner.authorizationOwner.authorize(request(grant)),
    owner.authorizationOwner.authorize(request(grant))
  ]);
  assert.deepEqual(attempts.filter(decision=>decision.allowed),[
    {allowed:true,accountId:'account-one',turnId:'turn-one'}
  ]);
  assert.deepEqual(await owner.authorizationOwner.authorize(request(grant)),{allowed:false});
});

test('live revocation, account replacement and expiry stop dispatch', async t => {
  let identity = facts;
  let at = 1000;
  const owner = createManagedInferenceGrants({...options, now:()=>at, resolveTurn:()=>identity});
  t.after(owner.close);
  const revoked = await owner.issue(ownedTurn);
  const replaced = await owner.issue(ownedTurn);
  const expired = await owner.issue(ownedTurn);
  identity = null;
  assert.deepEqual(await owner.authorizationOwner.authorize(request(revoked)),{allowed:false});
  identity = {...facts,accountId:'account-two'};
  assert.deepEqual(await owner.authorizationOwner.authorize(request(replaced)),{allowed:false});
  identity = {...facts,expiresAt:1200};
  at = 1100;
  assert.deepEqual(await owner.authorizationOwner.authorize(request(expired)),{allowed:false});
});

test('capacity and closure fail closed, expired grants release capacity', async () => {
  let at = 1000;
  const owner = createManagedInferenceGrants({...options,ttlMs:10,maxGrants:1,now:()=>at,resolveTurn:()=>facts});
  const grant = await owner.issue(ownedTurn);
  assert.equal(grant.expiresAt,1010);
  assert.equal(await owner.issue(ownedTurn),null);
  at = 1010;
  const next = await owner.issue(ownedTurn);
  assert.ok(next);
  owner.close();
  assert.equal(await owner.issue(ownedTurn),null);
  assert.deepEqual(await owner.authorizationOwner.authorize(request(next)),{allowed:false});
});
