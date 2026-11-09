import assert from 'node:assert/strict';
import {mkdtemp, rm, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {openManagedInferenceLedger} from './lib/managed-inference-ledger.mjs';

const now = 10_000;
const options = {
  reserveCredits:() => 40,
  creditsForUsage:({totalTokens}) => totalTokens,
  now:() => now
};
const args = (requestId, accountId = 'test-user') => ({
  requestId, model:'fixture', inputBytes:1024, maxOutputTokens:10, authorizationDecision:{accountId, turnId:'turn-one'}
});
const usage = {inputTokens:17, outputTokens:9, totalTokens:26};
function settle(owner, requestId, context, responseId, observed = usage) {
  owner.finish({requestId, context, state:'settled', responseId, usage:observed});
}

test('reservations, settlement and upstream response deduplication survive reopening', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buildx-ledger-'));
  let first, second;
  t.after(async () => {
    first?.close();
    second?.close();
    // The only file created in this uniquely owned directory is the database.
    await rm(path.join(dir,'pilot.sqlite'), {force:true});
    await rmdir(dir);
  });
  const filename = path.join(dir,'pilot.sqlite');
  first = openManagedInferenceLedger({filename, ...options});
  first.grantTrial({accountId:'test-user', expiresAt:now+100, credits:100});
  const owner = first.accountingOwner;
  const a = owner.begin(args('r1'));
  const b = owner.begin(args('r2'));
  assert.throws(() => owner.begin(args('r3')), {code:'MANAGED_INFERENCE_DENIED'});
  assert.deepEqual(first.balance('test-user'), {expiresAt:now+100, held:80, charged:0, available:20});
  settle(owner,'r1',a,'resp-one');
  settle(owner,'r1',a,'resp-one');
  first.close();
  first = null;

  second = openManagedInferenceLedger({filename, ...options});
  settle(second.accountingOwner,'r2',b,'resp-one');
  assert.deepEqual(second.balance('test-user'), {expiresAt:now+100, held:0, charged:26, available:74});
  assert.deepEqual(second.requestsForTurn('test-user','turn-one').map(row => row.state), ['settled','duplicate_response']);
  assert.deepEqual(second.requestsForTurn('other-user','turn-one'), []);
});

test('unknown or over-reservation results keep their hold; verified non-dispatch releases it', () => {
  const ledger = openManagedInferenceLedger({filename:':memory:', ...options});
  try {
    ledger.grantTrial({accountId:'test-user', expiresAt:now+100, credits:100});
    const owner = ledger.accountingOwner;
    const a = owner.begin(args('r1'));
    const b = owner.begin(args('r2'));
    settle(owner,'r1',a,'resp-one',{inputTokens:41,outputTokens:2,totalTokens:43});
    owner.finish({requestId:'r1', context:a, state:'not_dispatched'});
    owner.finish({requestId:'r2', context:b, state:'not_dispatched'});
    assert.throws(() => settle(owner,'r1','other-user','resp-one'), {code:'MANAGED_INFERENCE_DENIED'});
    assert.equal(ledger.balance('test-user').available,60);
    assert.deepEqual(ledger.requestsForTurn('test-user','turn-one').map(row => row.state), ['pending_reconciliation','not_dispatched']);
    settle(owner,'r1',a,'resp-one');
    assert.equal(ledger.balance('test-user').available,74);
  } finally { ledger.close(); }
});

test('expired, missing and exhausted trial accounts fail closed', () => {
  let current = now;
  const ledger = openManagedInferenceLedger({filename:':memory:', ...options, now:() => current});
  try {
    ledger.grantTrial({accountId:'test-user', expiresAt:now+100, credits:100});
    ledger.grantTrial({accountId:'empty-user', expiresAt:now+1000, credits:0});
    current += 100;
    for (const id of ['test-user','empty-user','missing-user']) {
      assert.throws(() => ledger.accountingOwner.begin(args('r1',id)), {code:'MANAGED_INFERENCE_DENIED'});
    }
  } finally { ledger.close(); }
});
