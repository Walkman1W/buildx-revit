import { randomUUID } from 'node:crypto';

// Explicit local connection intent, never an OpenAI stable-account/workspace
// identity or product entitlement. Only trusted host owners supply facts.
const CHALLENGE_TTL = 5 * 60 * 1000, OBSERVATION_TTL = 5 * 60 * 1000;
const reasons = new Set(['buildx_changed', 'connection_changed', 'codex_changed', 'service_closed']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f]/u.test(value);
// A new, non-secret revision is required for every provider, endpoint, model,
// or credential change. The caller owns creating it and must never derive it
// from a credential. A matching revision is an identity fact, not proof that
// any remote request or model inference succeeded.
const apiRevision = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const same = (left, right) => left && right && left.scope === right.scope && left.sessionId === right.sessionId && left.userId === right.userId &&
  left.generation === right.generation && left.connectionGeneration === right.connectionGeneration && left.accountRevision === right.accountRevision &&
  (right.type === null ? right.status !== 'verified' : left.type === right.type &&
    (right.type !== 'api_key' || left.providerId === right.providerId && left.providerRevision === right.providerRevision && left.model === right.model));
const errorMessages = Object.freeze({
  CONFIRMATION_UNAVAILABLE: '当前没有可确认的 BuildX 与本机 Codex 连接。',
  CONFIRMATION_CHECKING: '本机 Codex 身份正在核验，请完成后再确认。',
  CONFIRMATION_OBSERVATION_REQUIRED: '请先重新读取本机 Codex 连接。',
  CONFIRMATION_CHALLENGE_INVALID: '连接确认请求已失效，请重新读取。',
  CONFIRMATION_CLIENT_CHANGED: '请在发起读取的同一面板完成确认。',
  CONFIRMATION_IDENTITY_CHANGED: '账号或连接已变化，请重新读取并确认。',
  CONFIRMATION_FRESH_OBSERVATION_REQUIRED: '确认需要一次更新的本机 Codex 核验结果。',
  CONFIRMATION_CLOSED: '本机连接确认服务已关闭。',
});
const failure = code => ({ ok: false, error: { code, message: errorMessages[code] } });

export function createCodexConfirmation({ required = false, now = Date.now, onInvalidate = () => {} } = {}) {
  if (typeof required !== 'boolean' || typeof now !== 'function' || typeof onInvalidate !== 'function')
    throw new Error('Invalid local Codex confirmation configuration');
  let challenge = null, confirmation = null, closed = false;
  const clock = () => { const value = now(); if (!integer(value)) throw new Error('Invalid confirmation clock'); return value; };
  const dto = (phase, confirmed = false, type = null) => ({ required, phase, localConnectionConfirmed: confirmed,
    stableAccountId: null, workspaceId: null, message: ({
      not_applicable: '当前模式不声明 BuildX 与 Codex 账号绑定。', unavailable: '请先核验 BuildX 登录和本机 Codex 连接。',
      checking: 'BuildX 或本机 Codex 正在核验，已有确认暂不可用。', observation_required: '本机 Codex 观测已过期，请重新读取连接。',
      confirmation_required: '请读取并明确确认当前本机 Codex 连接。', prepared: '已读取本机连接，请在同一面板明确确认。',
      confirmed: type === 'api_key' ? '已明确确认本机 API 连接配置；模型可用性仍需另行测试。' : '已明确确认本机 Codex 连接；稳定账号与工作区 ID 仍未知。', closed: '本机连接确认已结束。',
    })[phase] });

  function retire(reason) {
    const hadProof = Boolean(challenge || confirmation);
    challenge = null; confirmation = null;
    if (hadProof) onInvalidate(reason);
  }

  function normalize(input, at) {
    try {
      if (!plain(input)) return null;
      const { scope, clientId, buildx: bx, codex: cx } = input;
      if (!['model', 'customer-chat'].includes(scope) || !identifier(clientId) || !plain(bx) || !plain(cx)) return null;
      const fact = { scope, clientId, sessionId: bx.sessionId, userId: bx.userId, generation: bx.generation,
        verified: bx.verified, expiresAt: bx.expiresAt, connectionGeneration: cx.connectionGeneration,
        accountRevision: cx.accountRevision, sequence: cx.observationSequence, observedAt: cx.observedAt,
        status: cx.status, type: cx.type, ready: cx.ready };
      if (!identifier(fact.sessionId) || !identifier(fact.userId) || !integer(fact.generation) ||
        typeof fact.verified !== 'boolean' || !integer(fact.expiresAt) || !integer(fact.connectionGeneration) ||
        !integer(fact.accountRevision) || !integer(fact.sequence) || !['verified', 'checking', 'invalidated', 'unknown'].includes(fact.status) ||
        ![null, 'chatgpt', 'api_key'].includes(fact.type) || typeof fact.ready !== 'boolean') return null;
      if (fact.type === 'api_key') {
        if (!identifier(cx.providerId) || !apiRevision(cx.providerRevision) || !identifier(cx.model)) return null;
        fact.providerId = cx.providerId;
        fact.providerRevision = cx.providerRevision;
        fact.model = cx.model;
      }
      if (fact.observedAt === null || fact.observedAt === undefined) fact.observedMs = null;
      else {
        if (typeof fact.observedAt !== 'string') return null;
        fact.observedMs = Date.parse(fact.observedAt);
        if (!integer(fact.observedMs) || new Date(fact.observedMs).toISOString() !== fact.observedAt || fact.observedMs > at) return null;
      }
      return fact;
    } catch { return null; }
  }

  function evaluate(input) {
    if (!required) return { view: dto('not_applicable'), phase: 'not_applicable' };
    if (closed) return { view: dto('closed'), phase: 'closed' };
    let at; try { at = clock(); } catch { retire('codex_changed'); return { view: dto('unavailable'), phase: 'unavailable' }; }
    if (challenge && at >= challenge.expiresAt) { challenge = null; }
    const fact = normalize(input, at);
    if (!fact) { retire('codex_changed'); return { view: dto('unavailable'), phase: 'unavailable' }; }
    const held = confirmation ?? challenge?.fact;
    if (held && !same(held, fact)) retire(fact.scope !== held.scope ? 'connection_changed' : fact.sessionId !== held.sessionId || fact.userId !== held.userId || fact.generation !== held.generation
      ? 'buildx_changed' : fact.connectionGeneration !== held.connectionGeneration ? 'connection_changed' : 'codex_changed');
    if (fact.expiresAt <= at) { retire('buildx_changed'); return { fact, at, view: dto('unavailable'), phase: 'unavailable' }; }
    if (fact.status === 'invalidated' || (fact.status === 'verified' && !['chatgpt', 'api_key'].includes(fact.type))) {
      retire('codex_changed'); return { fact, at, view: dto('unavailable'), phase: 'unavailable' };
    }
    // A normal fresh read temporarily makes the same live connection unready.
    // Keep proof and context ownership; this is not an observed account change.
    if (!fact.verified || fact.status === 'checking' || fact.status === 'unknown' || !fact.ready)
      return { fact, at, view: dto('checking'), phase: 'checking' };
    if (!fact.sequence || fact.observedMs === null || (!confirmation && at - fact.observedMs > OBSERVATION_TTL))
      return { fact, at, view: dto('observation_required'), phase: 'observation_required' };
    const phase = confirmation ? 'confirmed' : challenge ? 'prepared' : 'confirmation_required';
    return { fact, at, phase, view: dto(phase, phase === 'confirmed', fact.type) };
  }

  function status(facts) { return evaluate(facts).view; }
  function prepare(facts) {
    const state = evaluate(facts);
    if (state.phase === 'closed') return failure('CONFIRMATION_CLOSED');
    if (state.phase === 'checking') return failure('CONFIRMATION_CHECKING');
    if (state.phase === 'observation_required') return failure('CONFIRMATION_OBSERVATION_REQUIRED');
    if (!['confirmation_required', 'prepared', 'confirmed'].includes(state.phase)) return failure('CONFIRMATION_UNAVAILABLE');
    if (state.at - state.fact.observedMs > OBSERVATION_TTL) return failure('CONFIRMATION_OBSERVATION_REQUIRED');
    challenge = { id: randomUUID(), issuedAt: state.at, expiresAt: state.at + CHALLENGE_TTL, fact: { ...state.fact } };
    return { ok: true, value: { challengeId: challenge.id, expiresAt: challenge.expiresAt,
      confirmation: dto(confirmation ? 'confirmed' : 'prepared', Boolean(confirmation), state.fact.type) } };
  }
  function confirm(challengeId, facts) {
    const previous = challenge;
    const state = evaluate(facts);
    if (state.phase === 'closed') return failure('CONFIRMATION_CLOSED');
    if (!previous || challenge !== previous || typeof challengeId !== 'string' || challengeId !== previous.id)
      return failure('CONFIRMATION_CHALLENGE_INVALID');
    if (state.phase === 'checking') return failure('CONFIRMATION_CHECKING');
    if (state.phase === 'observation_required') return failure('CONFIRMATION_OBSERVATION_REQUIRED');
    if (!state.fact || !['prepared', 'confirmed'].includes(state.phase)) return failure('CONFIRMATION_UNAVAILABLE');
    if (state.at - state.fact.observedMs > OBSERVATION_TTL) return failure('CONFIRMATION_OBSERVATION_REQUIRED');
    if (!same(previous.fact, state.fact)) return failure('CONFIRMATION_IDENTITY_CHANGED');
    if (previous.fact.clientId !== state.fact.clientId) return failure('CONFIRMATION_CLIENT_CHANGED');
    if (state.fact.sequence <= previous.fact.sequence || state.fact.observedMs < previous.issuedAt)
      return failure('CONFIRMATION_FRESH_OBSERVATION_REQUIRED');
    confirmation = { scope: state.fact.scope, sessionId: state.fact.sessionId, userId: state.fact.userId, generation: state.fact.generation,
      connectionGeneration: state.fact.connectionGeneration, accountRevision: state.fact.accountRevision, type: state.fact.type,
      ...(state.fact.type === 'api_key' ? {providerId: state.fact.providerId, providerRevision: state.fact.providerRevision, model: state.fact.model} : {}) };
    challenge = null;
    return { ok: true, value: { confirmation: dto('confirmed', true, state.fact.type) } };
  }
  function invalidate(reason) {
    if (!reasons.has(reason)) throw new Error('Invalid local Codex confirmation reason');
    retire(reason);
    return dto(!required ? 'not_applicable' : closed ? 'closed' : 'confirmation_required');
  }
  function close() { closed = true; retire('service_closed'); return { closed: true }; }
  return Object.freeze({ prepare, confirm, status, invalidate, close });
}
