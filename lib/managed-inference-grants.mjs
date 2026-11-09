import {createHash, randomBytes} from 'node:crypto';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const denied = Object.freeze({allowed:false});
const digest = token => createHash('sha256').update(token).digest('base64url');

// Single-instance cloud pilot. The resolver must recheck an authenticated
// cloud session and its active turn. Local panel identity is not cloud proof.
export function createManagedInferenceGrants({resolveTurn, model, now = Date.now, ttlMs = 60_000, maxGrants = 512} = {}) {
  if (typeof resolveTurn !== 'function' || typeof now !== 'function' ||
      typeof model !== 'string' || !model.trim() || model.length > 200 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000 ||
      !Number.isSafeInteger(maxGrants) || maxGrants < 1 || maxGrants > 4096) {
    throw new TypeError('Invalid managed inference grant configuration');
  }
  const grants = new Map();
  let closed = false;

  async function verifiedTurn(sessionId, turnId, signal) {
    if (closed || signal?.aborted || !id(sessionId) || !id(turnId)) return null;
    try {
      const result = await resolveTurn({sessionId, turnId, signal});
      if (closed || signal?.aborted || result?.verified !== true ||
          result.sessionId !== sessionId || result.turnId !== turnId ||
          !id(result.accountId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) return null;
      return {accountId:result.accountId, expiresAt:result.expiresAt};
    } catch {
      return null;
    }
  }

  async function issue({sessionId, turnId, accountId, authorizationExpiresAt, signal} = {}) {
    const owner = await verifiedTurn(sessionId, turnId, signal);
    if (!owner || closed || signal?.aborted) return null;
    const at = now();
    for (const [key, grant] of grants) {
      if (grant.expiresAt <= at) grants.delete(key);
    }
    if (grants.size >= maxGrants || accountId !== undefined && accountId !== owner.accountId ||
        authorizationExpiresAt !== undefined && !Number.isSafeInteger(authorizationExpiresAt)) return null;
    const expiresAt = Math.min(owner.expiresAt, authorizationExpiresAt ?? owner.expiresAt, at + ttlMs);
    if (expiresAt <= at) return null;
    const token = randomBytes(32).toString('base64url');
    grants.set(digest(token), {accountId:owner.accountId, sessionId, turnId, expiresAt});
    return Object.freeze({token, turnId, expiresAt});
  }

  async function authorize({authorization, turnId, model:requestedModel, signal} = {}) {
    if (closed || signal?.aborted || requestedModel !== model || typeof authorization !== 'string') return denied;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (!token) return denied;
    const key = digest(token);
    const grant = grants.get(key);
    if (!grant || grant.turnId !== turnId || grant.expiresAt <= now()) return denied;
    const owner = await verifiedTurn(grant.sessionId, grant.turnId, signal);
    // Consume only after the live check. Concurrent presentations can both
    // await it, but at most one can consume this grant and reach the ledger.
    if (closed || signal?.aborted || grants.get(key) !== grant) return denied;
    grants.delete(key);
    if (!owner || owner.accountId !== grant.accountId || grant.expiresAt <= now() || owner.expiresAt <= now()) return denied;
    return Object.freeze({allowed:true, accountId:grant.accountId, turnId:grant.turnId});
  }

  function close() {
    closed = true;
    grants.clear();
  }
  return Object.freeze({issue, authorizationOwner:Object.freeze({authorize}), close});
}
