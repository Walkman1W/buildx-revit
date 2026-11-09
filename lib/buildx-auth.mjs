import { randomUUID } from 'node:crypto';

// This owner holds Supabase tokens only in memory. Its public results never
// contain passwords, provider response bodies, access tokens or refresh tokens.
export const BUILDX_AUTH_LIMITS = Object.freeze({ sessions: 24, requests: 4,
  responseBytes: 128 * 1024, tokenBytes: 16 * 1024, requestTimeoutMs: 8000 });
const messages = Object.freeze({
  AUTH_CONFIG_INVALID: 'BuildX账号配置无效。', AUTH_INPUT_INVALID: '请检查邮箱和密码格式。',
  AUTH_BUSY: '账号服务繁忙，请稍后重试。', AUTH_CAPACITY: '本地账号会话已达上限，请先退出旧会话。',
  AUTH_CLOSED: '本地账号服务已关闭。', AUTH_SESSION_INVALID: '账号会话无效，请重新登录。',
  AUTH_SESSION_EXPIRED: '账号会话已过期，请重新登录或刷新。', AUTH_SESSION_CHANGED: '账号会话已变化，请重新核对。',
  AUTH_INVALID_CREDENTIALS: '登录未完成，请检查账号、密码及邮箱确认状态。',
  AUTH_RATE_LIMITED: '账号请求过于频繁，请稍后重试。', AUTH_DENIED: '账号服务拒绝了请求。',
  AUTH_PROVIDER_UNAVAILABLE: '暂时无法连接账号服务。', AUTH_PROVIDER_REJECTED: '账号请求未完成。',
  AUTH_RESPONSE_INVALID: '账号服务回执无法核对。', AUTH_RESPONSE_TOO_LARGE: '账号服务回执超过限制。',
  AUTH_CANCELLED: '账号请求已取消。', AUTH_INFERENCE_UNCONFIGURED: 'BuildX 托管推理授权服务未配置。',
  AUTH_TIMEOUT: '账号服务响应超时，请核对当前登录状态。', AUTH_REMOTE_SIGNOUT_UNKNOWN: '本地已退出，远端注销结果尚未确认。',
});
const ok = value => ({ ok: true, value });
const fail = (code, extra = {}) => ({ ok: false, error: { code, message: messages[code], ...extra } });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const tokenValid = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= BUILDX_AUTH_LIMITS.tokenBytes && !/[\s\x00-\x1f\x7f]/u.test(value);
const sessionKeyValid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value);
const emailValid = value => typeof value === 'string' && Buffer.byteLength(value) <= 320 &&
  /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/u.test(value);
const passwordValid = (value, minimum = 1) => typeof value === 'string' && value.length >= minimum &&
  Buffer.byteLength(value) <= 1024 && !value.includes('\0');
const publicUser = user => {
  if (!record(user) || typeof user.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(user.id)) return null;
  if (user.email !== undefined && user.email !== null && !emailValid(user.email)) return null;
  // User-editable metadata, provider roles and app metadata are deliberately
  // absent. Authentication alone never grants a paid BuildX entitlement.
  return Object.freeze({ id: user.id, email: user.email ?? null });
};

export function createBuildxAuth(configuration) {
  let origin, inferenceGrantOrigin, key, fetcher, now, timeoutMs;
  try {
    if (!record(configuration) || Reflect.ownKeys(configuration).some(name =>
      !['url', 'publishableKey', 'fetchImpl', 'now', 'requestTimeoutMs', 'inferenceGrantOrigin'].includes(name))) throw new Error();
    const rawUrl = configuration.url;
    key = configuration.publishableKey;
    fetcher = configuration.fetchImpl ?? globalThis.fetch;
    now = configuration.now ?? Date.now;
    timeoutMs = configuration.requestTimeoutMs ?? BUILDX_AUTH_LIMITS.requestTimeoutMs;
    const parsed = new URL(rawUrl);
    if (typeof rawUrl !== 'string' || parsed.protocol !== 'https:' ||
      !/^[a-z0-9]{20}\.supabase\.co$/u.test(parsed.hostname) || parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,256}$/u.test(key) || typeof fetcher !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error();
    origin = parsed.origin;
    // Set by trusted application composition. Browser requests cannot select
    // a grant origin or route, and the existing account config leaves it off.
    const rawGrantOrigin = configuration.inferenceGrantOrigin;
    if (rawGrantOrigin !== undefined) {
      const grant = new URL(rawGrantOrigin);
      if (typeof rawGrantOrigin !== 'string' || grant.protocol !== 'https:' ||
          !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/u.test(grant.hostname) || grant.port ||
          grant.username || grant.password || grant.search || grant.hash || grant.pathname !== '/') throw new Error();
      inferenceGrantOrigin = grant.origin;
    }
  } catch { const error = new Error(messages.AUTH_CONFIG_INVALID); error.code = 'AUTH_CONFIG_INVALID'; throw error; }

  const sessions = new Map();
  const pending = new Set();
  let closed = false, reservations = 0;
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('clock');
    return value;
  };
  const view = session => ({ sessionId: session.id, user: { ...session.user }, expiresAt: session.expiresAt,
    verifiedAt: session.verifiedAt });
  const current = (session, version) => !closed && sessions.get(session.id) === session && session.version === version;
  const discard = session => { session.version++; session.accessToken = null; session.refreshToken = null; sessions.delete(session.id); };
  const compactExpired = () => { const at = clock(); for (const value of sessions.values()) if (at >= value.expiresAt) discard(value); };

  async function http(route, { method = 'GET', body, accessToken, credentialOperation = false, empty = false, api = 'auth', signal } = {}) {
    if (closed) return fail('AUTH_CLOSED');
    if (signal?.aborted) return fail('AUTH_CANCELLED');
    if (pending.size >= BUILDX_AUTH_LIMITS.requests) return fail('AUTH_BUSY');
    const isGrant = api === 'inference';
    const target = isGrant ? inferenceGrantOrigin + route : origin + (api === 'rest' ? '/rest/v1' : '/auth/v1') + route;
    const controller = new AbortController();
    const request = { controller };
    pending.add(request);
    let timedOut = false, timer, cancel;
    const cancelled = signal && new Promise(resolve => {
      cancel = () => { controller.abort(); resolve(fail('AUTH_CANCELLED')); };
      signal.addEventListener('abort', cancel, {once:true});
      if (signal.aborted) cancel();
    });
    // Keep the exact pending request until the underlying operation settles,
    // even when a broken/injected fetch ignores abort. Capacity cannot silently
    // be reused for an unbounded number of abandoned requests.
    const operation = (async () => {
      let reader, response;
      try {
        if (controller.signal.aborted) return fail('AUTH_CANCELLED');
        response = await fetcher(target, { method, redirect: 'error', signal: controller.signal,
          headers: { ...(isGrant ? {} : {apikey:key}), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (closed) return fail('AUTH_CLOSED');
        if (!response || response.redirected || !Number.isInteger(response.status) || response.status < 100 || response.status > 599)
          return fail('AUTH_RESPONSE_INVALID');
        if (response.status >= 300 && response.status <= 399) return fail('AUTH_RESPONSE_INVALID');
        if (response.status < 200 || response.status > 299) {
          try { await response.body?.cancel(); } catch { /* fixed error below, never retain provider text */ }
          if (response.status === 429) return fail('AUTH_RATE_LIMITED');
          if (response.status === 403) return fail('AUTH_DENIED');
          if (credentialOperation && [400, 401, 422].includes(response.status)) return fail('AUTH_INVALID_CREDENTIALS');
          if (response.status === 401) return fail('AUTH_SESSION_INVALID');
          return fail(response.status >= 500 ? 'AUTH_PROVIDER_UNAVAILABLE' : 'AUTH_PROVIDER_REJECTED');
        }
        if (empty) { try { await response.body?.cancel(); } catch { return fail('AUTH_RESPONSE_INVALID'); } return ok(null); }
        const contentLength = response.headers?.get('content-length');
        if (contentLength !== null && contentLength !== undefined &&
          (!/^\d+$/u.test(contentLength) || Number(contentLength) > BUILDX_AUTH_LIMITS.responseBytes)) {
          try { await response.body?.cancel(); } catch { /* bounded rejection remains */ }
          return fail('AUTH_RESPONSE_TOO_LARGE');
        }
        if (!response.body || typeof response.body.getReader !== 'function') return fail('AUTH_RESPONSE_INVALID');
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (closed || controller.signal.aborted) return fail(closed ? 'AUTH_CLOSED' : signal?.aborted ? 'AUTH_CANCELLED' : 'AUTH_TIMEOUT');
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return fail('AUTH_RESPONSE_INVALID');
          size += chunk.value.byteLength;
          if (size > BUILDX_AUTH_LIMITS.responseBytes) return fail('AUTH_RESPONSE_TOO_LARGE');
          chunks.push(chunk.value);
        }
        const bytes = Buffer.concat(chunks, size);
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('AUTH_RESPONSE_INVALID'); }
        return record(value) ? ok(value) : fail('AUTH_RESPONSE_INVALID');
      } catch {
        return fail(closed ? 'AUTH_CLOSED' : signal?.aborted ? 'AUTH_CANCELLED' : timedOut || controller.signal.aborted ? 'AUTH_TIMEOUT' : 'AUTH_PROVIDER_UNAVAILABLE');
      } finally {
        if (reader) { try { await reader.cancel(); } catch { /* abort still owns cancellation */ } try { reader.releaseLock(); } catch { /* no additional data retained */ } }
        else { try { await response?.body?.cancel(); } catch { /* abort still owns cancellation */ } }
        pending.delete(request);
      }
    })();
    const deadline = new Promise(resolve => { timer = setTimeout(() => {
      timedOut = true; controller.abort(); resolve(fail('AUTH_TIMEOUT'));
    }, timeoutMs); });
    try { return await Promise.race(cancelled ? [operation, deadline, cancelled] : [operation, deadline]); }
    finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
  }

  async function verify(accessToken) {
    if (!tokenValid(accessToken)) return fail('AUTH_SESSION_INVALID');
    const reply = await http('/user', { accessToken });
    if (!reply.ok) return reply;
    const user = publicUser(reply.value);
    return user ? ok({ user: { ...user }, verifiedAt: clock() }) : fail('AUTH_RESPONSE_INVALID');
  }

  function credentials(value) {
    const at = clock();
    if (!record(value) || value.token_type?.toLowerCase() !== 'bearer' || !tokenValid(value.access_token) ||
      !tokenValid(value.refresh_token) || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0) return null;
    let expiresAt = at + value.expires_in * 1000;
    if (!Number.isSafeInteger(expiresAt)) return null;
    if (value.expires_at !== undefined) {
      if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0 || !Number.isSafeInteger(value.expires_at * 1000)) return null;
      expiresAt = Math.min(expiresAt, value.expires_at * 1000);
    }
    if (expiresAt <= at) return null;
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt };
  }

  async function authenticate(email, password, signup) {
    if (closed) return fail('AUTH_CLOSED');
    if (!emailValid(email) || !passwordValid(password, signup ? 6 : 1)) return fail('AUTH_INPUT_INVALID');
    compactExpired();
    if (sessions.size + reservations >= BUILDX_AUTH_LIMITS.sessions) return fail('AUTH_CAPACITY');
    reservations++;
    try {
      const response = await http(signup ? '/signup' : '/token?grant_type=password', {
        method: 'POST', body: { email, password }, credentialOperation: true });
      if (!response.ok) return response;
      if (closed) return fail('AUTH_CLOSED');
      if (signup && !response.value.access_token) {
        // Hosted email-confirmation signup can deliberately obscure whether a
        // user already exists. Do not report a newly created/verified identity.
        return publicUser(response.value.user ?? response.value) ? ok({ state: 'confirmation_required' }) : fail('AUTH_RESPONSE_INVALID');
      }
      const tokens = credentials(response.value);
      if (!tokens) return fail('AUTH_RESPONSE_INVALID');
      const checked = await verify(tokens.accessToken);
      if (!checked.ok) return checked;
      if (closed) return fail('AUTH_CLOSED');
      const session = { id: randomUUID(), ...tokens, user: Object.freeze(checked.value.user),
        verifiedAt: checked.value.verifiedAt, version: 0, busy: false };
      sessions.set(session.id, session);
      return ok({ state: 'signed_in', ...view(session) });
    } catch { return fail('AUTH_RESPONSE_INVALID'); }
    finally { reservations--; }
  }

  async function verifySession(sessionId) {
    if (closed) return fail('AUTH_CLOSED');
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return fail('AUTH_SESSION_INVALID');
    if (clock() >= session.expiresAt) { discard(session); return fail('AUTH_SESSION_EXPIRED'); }
    if (session.busy) return fail('AUTH_BUSY');
    const version = session.version;
    const checked = await verify(session.accessToken);
    if (!current(session, version)) return fail('AUTH_SESSION_CHANGED');
    if (!checked.ok) {
      if (['AUTH_SESSION_INVALID', 'AUTH_DENIED'].includes(checked.error.code)) discard(session);
      return checked;
    }
    if (clock() >= session.expiresAt) { discard(session); return fail('AUTH_SESSION_EXPIRED'); }
    if (checked.value.user.id !== session.user.id) { discard(session); return fail('AUTH_SESSION_CHANGED'); }
    session.user = Object.freeze(checked.value.user); session.verifiedAt = checked.value.verifiedAt;
    return ok({ state: 'signed_in', ...view(session) });
  }

  async function refresh(sessionId) {
    if (closed) return fail('AUTH_CLOSED');
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return fail('AUTH_SESSION_INVALID');
    if (session.busy) return fail('AUTH_BUSY');
    session.busy = true; const version = ++session.version;
    try {
      const response = await http('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refreshToken } });
      if (!current(session, version)) return fail('AUTH_SESSION_CHANGED');
      if (!response.ok) { discard(session); return response; }
      const tokens = credentials(response.value);
      if (!tokens) { discard(session); return fail('AUTH_RESPONSE_INVALID'); }
      const checked = await verify(tokens.accessToken);
      if (!current(session, version)) return fail('AUTH_SESSION_CHANGED');
      if (!checked.ok) { discard(session); return checked; }
      if (checked.value.user.id !== session.user.id) { discard(session); return fail('AUTH_SESSION_CHANGED'); }
      Object.assign(session, tokens, { user: Object.freeze(checked.value.user), verifiedAt: checked.value.verifiedAt });
      return ok({ state: 'signed_in', ...view(session) });
    } catch { if (current(session, version)) discard(session); return fail('AUTH_RESPONSE_INVALID'); }
    finally { session.busy = false; }
  }

  function release(sessionId) {
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (session) discard(session);
    return ok({ locallySignedOut: true, remoteRevoked: false });
  }

  async function signOut(sessionId) {
    if (closed) return fail('AUTH_CLOSED', { locallySignedOut: true, remoteRevoked: false });
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return ok({ locallySignedOut: true, remoteRevoked: false });
    const accessToken = session.accessToken;
    discard(session); // Local access ends before network I/O, including failures.
    const response = await http('/logout?scope=local', { method: 'POST', accessToken, empty: true });
    return response.ok ? ok({ locallySignedOut: true, remoteRevoked: true }) :
      fail('AUTH_REMOTE_SIGNOUT_UNKNOWN', { locallySignedOut: true, remoteRevoked: null });
  }

  // Only fixed RPCs receive a token owned by this adapter. The result is
  // checked again against the same session after I/O, never trusted from UI.
  async function license(sessionId, code) {
    if (closed) return fail('AUTH_CLOSED');
    if (code !== undefined && (typeof code !== 'string' || !/^[0-9a-f]{64}$/u.test(code))) return fail('AUTH_INPUT_INVALID');
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return fail('AUTH_SESSION_INVALID');
    if (clock() >= session.expiresAt) { discard(session); return fail('AUTH_SESSION_EXPIRED'); }
    if (session.busy) return fail('AUTH_BUSY');
    const version = session.version;
    const checked = await verify(session.accessToken);
    if (!current(session, version) || clock() >= session.expiresAt) return fail('AUTH_SESSION_CHANGED');
    if (!checked.ok) return checked;
    if (checked.value.user.id !== session.user.id) { discard(session); return fail('AUTH_SESSION_CHANGED'); }
    const result = await http(code === undefined ? '/rpc/buildx_license_status' : '/rpc/buildx_redeem_invite',
      { api: 'rest', method: 'POST', accessToken: session.accessToken, body: code === undefined ? {} : { invite_code: code } });
    if (!current(session, version) || clock() >= session.expiresAt) return fail('AUTH_SESSION_CHANGED');
    if (!result.ok) return result;
    const value = result.value;
    if (!['unactivated', 'trial', 'active', 'expired', 'disabled'].includes(value.status) ||
      ![value.startsAt, value.endsAt].every(x => x === null || typeof x === 'string' && Number.isFinite(Date.parse(x))))
      return fail('AUTH_RESPONSE_INVALID');
    return ok({ status: value.status, startsAt: value.startsAt, endsAt: value.endsAt });
  }

  // Only the local runtime owner calls this method. The cloud endpoint must
  // verify the access token and independently bind the requested turn.
  async function requestInferenceGrant(sessionId, turnId, signal) {
    if (closed) return fail('AUTH_CLOSED');
    if (!inferenceGrantOrigin) return fail('AUTH_INFERENCE_UNCONFIGURED');
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(turnId) ||
        signal !== undefined && !(signal instanceof AbortSignal)) return fail('AUTH_INPUT_INVALID');
    if (signal?.aborted) return fail('AUTH_CANCELLED');
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return fail('AUTH_SESSION_INVALID');
    if (clock() >= session.expiresAt) { discard(session); return fail('AUTH_SESSION_EXPIRED'); }
    if (session.busy) return fail('AUTH_BUSY');
    const version = session.version;
    const result = await http('/v1/managed/grants', {api:'inference',method:'POST',accessToken:session.accessToken,body:{turnId},signal});
    if (signal?.aborted) return fail('AUTH_CANCELLED');
    const at = clock();
    if (!current(session, version) || at >= session.expiresAt) return fail('AUTH_SESSION_CHANGED');
    if (!result.ok) return result;
    const grant = result.value;
    if (typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) ||
        grant.token === session.accessToken || grant.token === session.refreshToken || grant.turnId !== turnId ||
        !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= at ||
        grant.expiresAt > Math.min(session.expiresAt, at + 120_000)) return fail('AUTH_RESPONSE_INVALID');
    return ok(Object.freeze({token:grant.token,turnId,expiresAt:grant.expiresAt}));
  }

  // Turn results belong to the exact login session that initiated them. A
  // cancelled or timed-out request may still have changed remote state.
  async function inferenceTurn(sessionId, turnId, signal, finish) {
    if (closed) return fail('AUTH_CLOSED');
    if (!inferenceGrantOrigin) return fail('AUTH_INFERENCE_UNCONFIGURED');
    if (signal !== undefined && !(signal instanceof AbortSignal) ||
        finish && (typeof turnId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(turnId))) return fail('AUTH_INPUT_INVALID');
    if (signal?.aborted) return fail('AUTH_CANCELLED');
    const session = sessionKeyValid(sessionId) ? sessions.get(sessionId) : null;
    if (!session) return fail('AUTH_SESSION_INVALID');
    if (clock() >= session.expiresAt) { discard(session); return fail('AUTH_SESSION_EXPIRED'); }
    if (session.busy) return fail('AUTH_BUSY');
    const version = session.version;
    const result = await http(finish ? '/v1/managed/turns/finish' : '/v1/managed/turns/open',
      {api:'inference',method:'POST',accessToken:session.accessToken,body:finish ? {turnId} : {},signal});
    if (signal?.aborted) return fail('AUTH_CANCELLED');
    const at = clock();
    if (!current(session, version) || at >= session.expiresAt) return fail('AUTH_SESSION_CHANGED');
    if (!result.ok) return result;
    if (finish) return result.value.closed === true ? ok(Object.freeze({closed:true})) : fail('AUTH_RESPONSE_INVALID');
    const value = result.value;
    if (typeof value.turnId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.turnId) ||
        value.turnId === session.accessToken || value.turnId === session.refreshToken ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= at || value.expiresAt > session.expiresAt)
      return fail('AUTH_RESPONSE_INVALID');
    return ok(Object.freeze({turnId:value.turnId,expiresAt:value.expiresAt}));
  }

  function close() {
    closed = true;
    for (const session of [...sessions.values()]) discard(session);
    for (const request of pending) request.controller.abort();
    return ok({ closed: pending.size === 0, acceptingRequests: false, retainedSessions: 0,
      pendingRequests: pending.size, remoteRevoked: false });
  }

  const protect = async operation => { try { return await operation(); } catch { return fail('AUTH_RESPONSE_INVALID'); } };
  return Object.freeze({ signUp: (email, password) => protect(() => authenticate(email, password, true)),
    signIn: (email, password) => protect(() => authenticate(email, password, false)),
    verify: accessToken => protect(() => verify(accessToken)), verifySession: sessionId => protect(() => verifySession(sessionId)),
    requestInferenceGrant: (sessionId, turnId, {signal} = {}) => protect(() => requestInferenceGrant(sessionId, turnId, signal)),
    openInferenceTurn: (sessionId, {signal} = {}) => protect(() => inferenceTurn(sessionId, null, signal, false)),
    finishInferenceTurn: (sessionId, turnId, {signal} = {}) => protect(() => inferenceTurn(sessionId, turnId, signal, true)),
    licenseStatus: sessionId => protect(() => license(sessionId)), redeemInvite: (sessionId, code) => protect(() => license(sessionId, code)),
    refresh: sessionId => protect(() => refresh(sessionId)), signOut: sessionId => protect(() => signOut(sessionId)), release, close,
    diagnostics: () => ({ closed, retainedSessions: sessions.size, pendingRequests: pending.size, reservations }),
  });
}
