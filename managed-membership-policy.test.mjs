import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFeatureEntitlement, decideManagedInference } from './lib/managed-membership-policy.mjs';

const active = { status: 'active', expiresAt: 1001 };
const account = { status: 'active' };
const now = 1000;

test('existing features default to free without membership or credits', () => {
  assert.deepEqual(decideFeatureEntitlement({ featureId: 'revit.query', now }), { allowed: true, reason: 'free_feature' });
  assert.deepEqual(decideFeatureEntitlement({ featureId: 'revit.query', premiumFeatures: ['future.report'], now }), { allowed: true, reason: 'free_feature' });
});

test('explicit premium features require an unexpired membership', () => {
  const args = { featureId: 'future.report', premiumFeatures: ['future.report'], now };
  assert.equal(decideFeatureEntitlement({ ...args, membership: active }).allowed, true);
  assert.equal(decideFeatureEntitlement(args).reason, 'premium_membership_inactive');
  assert.equal(decideFeatureEntitlement({ ...args, membership: { ...active, expiresAt: now } }).reason, 'premium_membership_expired');
  assert.equal(decideFeatureEntitlement({ ...args, membership: { status: 'active' } }).reason, 'premium_membership_invalid');
});

test('managed inference requires account, membership and independent positive credits', () => {
  const args = { account, membership: active, credits: { available: 1 }, now };
  assert.deepEqual(decideManagedInference(args), { allowed: true, reason: 'eligible' });
  assert.equal(decideManagedInference({ ...args, account: { status: 'disabled' } }).reason, 'account_inactive');
  assert.equal(decideManagedInference({ ...args, membership: { ...active, expiresAt: now } }).reason, 'membership_expired');
  assert.equal(decideManagedInference({ ...args, credits: { available: 0 } }).reason, 'credits_exhausted');
  for (const available of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(decideManagedInference({ ...args, credits: { available } }).reason, 'credits_invalid');
  }
});

test('feature access and inference quota do not confer Revit permissions', () => {
  assert.equal(decideFeatureEntitlement({ featureId: 'future.report', premiumFeatures: ['future.report'], membership: active, credits: { available: 0 }, now }).allowed, true);
  assert.equal(decideFeatureEntitlement({ featureId: 'revit.write', now, revitPermission: false }).allowed, true);
});

test('invalid feature policy is rejected rather than silently granting access', () => {
  assert.throws(() => decideFeatureEntitlement({ featureId: 'x', premiumFeatures: null }), TypeError);
  assert.throws(() => decideFeatureEntitlement({ featureId: 'x', premiumFeatures: [''] }), TypeError);
  assert.throws(() => decideFeatureEntitlement({ featureId: '' }), TypeError);
});
