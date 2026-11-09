/** Pure entitlement decisions. Callers must supply trusted server-side facts. */
export function decideFeatureEntitlement({ featureId, premiumFeatures = [], membership, now = Date.now() } = {}) {
  if (typeof featureId !== 'string' || !featureId.trim()) throw new TypeError('featureId is required');
  if (!Array.isArray(premiumFeatures) || premiumFeatures.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('premiumFeatures must be an array of non-empty feature IDs');
  }
  if (!premiumFeatures.includes(featureId)) return { allowed: true, reason: 'free_feature' };
  const status = membershipStatus(membership, now);
  return status === 'active'
    ? { allowed: true, reason: 'premium_membership_active' }
    : { allowed: false, reason: `premium_membership_${status}` };
}

function membershipStatus(membership, now) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a timestamp in milliseconds');
  if (!membership || membership.status !== 'active') return 'inactive';
  if (!Number.isFinite(membership.expiresAt)) return 'invalid';
  return now < membership.expiresAt ? 'active' : 'expired';
}

/** Admission only; reservation and settlement belong to the authoritative ledger. */
export function decideManagedInference({ account, membership, credits, now = Date.now() } = {}) {
  if (!account || account.status !== 'active') return { allowed: false, reason: 'account_inactive' };
  const status = membershipStatus(membership, now);
  if (status !== 'active') return { allowed: false, reason: `membership_${status}` };
  if (!credits || !Number.isSafeInteger(credits.available) || credits.available < 0) {
    return { allowed: false, reason: 'credits_invalid' };
  }
  if (credits.available === 0) return { allowed: false, reason: 'credits_exhausted' };
  return { allowed: true, reason: 'eligible' };
}
