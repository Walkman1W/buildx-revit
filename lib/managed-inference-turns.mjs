import {randomUUID} from 'node:crypto';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

// Both methods belong to the cloud identity service. authenticate resolves a
// login bearer; verifySession reads live status without retaining that bearer.
export function createManagedInferenceTurns({identityOwner, now = Date.now, ttlMs = 300_000, maxActive = 512} = {}) {
  const authenticate = identityOwner && Object.getOwnPropertyDescriptor(identityOwner,'authenticate')?.value;
  const verifySession = identityOwner && Object.getOwnPropertyDescriptor(identityOwner,'verifySession')?.value;
  if (!Object.isFrozen(identityOwner) || typeof authenticate !== 'function' || typeof verifySession !== 'function' ||
      typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000 ||
      !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 4096) {
    throw new TypeError('Invalid managed turn configuration');
  }
  const turns = new Map();
  const bySession = new Map();
  let closed = false;

  function identity(result) {
    if (result?.verified !== true || !id(result.sessionId) || !id(result.accountId) ||
        !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) return null;
    const {sessionId,accountId,expiresAt} = result;
    return {verified:true,sessionId,accountId,expiresAt};
  }

  async function authenticateLive({accessToken,signal} = {}) {
    if (closed || signal?.aborted || typeof accessToken !== 'string' ||
        !/^[A-Za-z0-9_.~+\/=-]{1,16384}$/.test(accessToken)) return null;
    try {
      const result = await authenticate.call(identityOwner,{accessToken,signal});
      return closed || signal?.aborted ? null : identity(result);
    } catch {
      return null;
    }
  }

  function discard(turn) {
    turns.delete(turn.turnId);
    if (bySession.get(turn.sessionId) === turn) bySession.delete(turn.sessionId);
  }

  async function open({accessToken,signal} = {}) {
    const owner = await authenticateLive({accessToken,signal});
    if (!owner || closed || signal?.aborted) return null;
    const at = now();
    for (const turn of turns.values()) if (turn.expiresAt <= at) discard(turn);
    if (turns.size >= maxActive || bySession.has(owner.sessionId) || owner.expiresAt <= at) return null;
    const turnId = randomUUID();
    const expiresAt = Math.min(owner.expiresAt,at + ttlMs);
    const turn = Object.freeze({turnId,expiresAt,accountId:owner.accountId,sessionId:owner.sessionId});
    turns.set(turnId,turn);
    bySession.set(owner.sessionId,turn);
    return Object.freeze({turnId,expiresAt});
  }

  async function resolveTurn({sessionId,turnId,signal} = {}) {
    const turn = turns.get(turnId);
    if (closed || signal?.aborted || !turn || turn.sessionId !== sessionId || turn.expiresAt <= now()) return null;
    try {
      const result = await verifySession.call(identityOwner,{sessionId,accountId:turn.accountId,signal});
      const current = identity(result);
      if (closed || signal?.aborted || turns.get(turnId) !== turn || turn.expiresAt <= now() ||
          !current || current.sessionId !== sessionId || current.accountId !== turn.accountId) return null;
      return {verified:true,...turn,expiresAt:Math.min(turn.expiresAt,current.expiresAt)};
    } catch {
      return null;
    }
  }

  async function finish({accessToken,turnId,signal} = {}) {
    const owner = await authenticateLive({accessToken,signal});
    const turn = turns.get(turnId);
    if (!owner || closed || signal?.aborted || !turn ||
        turn.sessionId !== owner.sessionId || turn.accountId !== owner.accountId) return false;
    discard(turn);
    return true;
  }

  function close() {
    closed = true;
    turns.clear();
    bySession.clear();
  }
  return Object.freeze({open,resolveTurn,finish,close,identityOwner:Object.freeze({authenticate:authenticateLive})});
}
