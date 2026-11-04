import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildxAuth, BUILDX_AUTH_LIMITS } from './lib/buildx-auth.mjs';

const baseUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const key = 'sb_publishable_abcdefghijklmnopqrstuvwxyz';
const user = { id: '12345678-1234-1234-1234-123456789abc', email: 'one@example.test',
  user_metadata: { admin: true }, app_metadata: { subscription: 'paid' }, role: 'service_role' };
const other = { id: 'abcdef12-1234-1234-1234-123456789abc', email: 'two@example.test' };
const at = 2000000000000;
const tokens = { access_token: 'access-token-fixture', refresh_token: 'refresh-token-fixture', token_type: 'bearer', expires_in: 3600,
  user: other };
const response = (value, status = 200) => new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(handler, extra = {}) {
  const calls = [];
  const provider = createBuildxAuth({ url: baseUrl, publishableKey: key, now: () => at,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler ? handler(url, init, calls) : response(url.includes('/user') ? user : tokens); }, ...extra });
  return { provider, calls };
}
const login = provider => provider.signIn('one@example.test', 'not-a-real-password');

test('configuration permits only a hosted Supabase HTTPS origin and a publishable key', () => {
  for (const url of ['http://abcdefghijklmnopqrst.supabase.co', 'https://localhost', baseUrl + '/auth/v1', baseUrl + '?secret=1',
    'https://user:password@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co:4431', 'https://abcdefghijklmnopqrst.supabase.co.evil.test']) {
    assert.throws(() => createBuildxAuth({ url, publishableKey: key }), { code: 'AUTH_CONFIG_INVALID' });
  }
  for (const publishableKey of ['sb_secret_should-not-accept', 'eyJhbGci.service_role.token', '', 'service_role'])
    assert.throws(() => createBuildxAuth({ url: baseUrl, publishableKey }), { code: 'AUTH_CONFIG_INVALID' });
  assert.throws(() => createBuildxAuth({ url: baseUrl, publishableKey: key, arbitrary: true }), { code: 'AUTH_CONFIG_INVALID' });
});

test('configuration is captured once; later mutation cannot redirect credentials', async () => {
  const calls = []; const config = { url: baseUrl, publishableKey: key, now: () => at,
    fetchImpl: async url => { calls.push(url); return response(url.includes('/user') ? user : tokens); } };
  const provider = createBuildxAuth(config); config.url = 'https://evil.test'; config.publishableKey = 'sb_secret_bad';
  assert.equal((await login(provider)).ok, true); assert.ok(calls.every(url => url.startsWith(baseUrl + '/auth/v1/'))); provider.close();
});

test('password sign-in is freshly verified; only public DTO and opaque local handle leave owner', async () => {
  const { provider, calls } = fixture(); const result = await login(provider);
  assert.equal(result.ok, true); assert.equal(result.value.state, 'signed_in');
  assert.deepEqual(result.value.user, { id: user.id, email: user.email });
  assert.match(result.value.sessionId, /^[\da-f-]{36}$/u); assert.equal(result.value.expiresAt, at + 3600000);
  assert.equal(calls[0].url, baseUrl + '/auth/v1/token?grant_type=password');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'one@example.test', password: 'not-a-real-password' });
  assert.equal(calls[1].url, baseUrl + '/auth/v1/user'); assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + tokens.access_token);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(result), /access-token|refresh-token|user_metadata|app_metadata|service_role|password/u);
  result.value.user.id = other.id; assert.equal((await provider.verifySession(result.value.sessionId)).value.user.id, user.id); provider.close();
});

test('input rejection is bounded and happens before network I/O', async () => {
  const { provider, calls } = fixture();
  for (const [email, password] of [['invalid', 'password'], ['one@example.test', ''], ['one@example.test', 'x'.repeat(1025)],
    ['x'.repeat(320) + '@x.test', 'password'], ['one@example.test', 'a\0password']]) {
    assert.equal((await provider.signIn(email, password)).error.code, 'AUTH_INPUT_INVALID');
  }
  assert.equal((await provider.signUp('one@example.test', 'short')).error.code, 'AUTH_INPUT_INVALID');
  assert.equal(calls.length, 0); provider.close();
});

test('confirmation-required signup never claims new verified user or creates local session', async () => {
  const { provider, calls } = fixture(() => response({ user, session: null }));
  assert.deepEqual(await provider.signUp('one@example.test', 'password'), { ok: true, value: { state: 'confirmation_required' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, baseUrl + '/auth/v1/signup');
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('signup malformed success is rejected; no falsely successful confirmation state', async () => {
  const { provider } = fixture(() => response({}));
  assert.equal((await provider.signUp('one@example.test', 'password')).error.code, 'AUTH_RESPONSE_INVALID'); provider.close();
});

test('provider errors are fixed codes and never expose provider text or credentials', async () => {
  for (const [status, code] of [[400, 'AUTH_INVALID_CREDENTIALS'], [403, 'AUTH_DENIED'], [429, 'AUTH_RATE_LIMITED'], [500, 'AUTH_PROVIDER_UNAVAILABLE']]) {
    const { provider } = fixture(() => response({ message: 'private-provider-text access-token password' }, status));
    const result = await login(provider); assert.equal(result.error.code, code); assert.doesNotMatch(JSON.stringify(result), /private-provider|access-token|password/u); provider.close();
  }
});

test('redirect is forbidden and never followed', async () => {
  const { provider, calls } = fixture(() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
  assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_INVALID'); assert.equal(calls.length, 1); provider.close();
});

test('response byte budget counts actual chunks when content length is missing', async () => {
  const { provider } = fixture(() => new Response('x'.repeat(BUILDX_AUTH_LIMITS.responseBytes + 1)));
  assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_TOO_LARGE'); provider.close();
});

test('oversized declared content length is rejected without reading response', async () => {
  const { provider } = fixture(() => new Response('{}', { headers: { 'content-length': String(BUILDX_AUTH_LIMITS.responseBytes + 1) } }));
  assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_TOO_LARGE'); provider.close();
});

test('invalid UTF-8 and non-object success replies fail closed', async () => {
  for (const reply of [new Uint8Array([0xff]), '[]', 'not-json']) {
    const { provider } = fixture(() => new Response(reply)); assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_INVALID'); provider.close();
  }
});

test('network failure is sanitized; no automatic replay of password operation', async () => {
  const { provider, calls } = fixture(() => { throw new Error('private email and password'); });
  const result = await login(provider); assert.equal(result.error.code, 'AUTH_PROVIDER_UNAVAILABLE'); assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private email/u); provider.close();
});

test('request cap remains owned after a fetch that ignores timeout abort', async () => {
  const pending = []; const { provider, calls } = fixture(() => { const item = deferred(); pending.push(item); return item.promise; }, { requestTimeoutMs: 5 });
  const results = await Promise.all(Array.from({ length: 4 }, () => login(provider)));
  assert.ok(results.every(result => result.error.code === 'AUTH_TIMEOUT'));
  assert.equal(provider.diagnostics().pendingRequests, 4); assert.equal((await login(provider)).error.code, 'AUTH_BUSY'); assert.equal(calls.length, 4);
  for (const item of pending) item.resolve(response(tokens)); await tick(); await tick();
  assert.equal(provider.diagnostics().pendingRequests, 0); assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('local session capacity rejects before provider mutation', async () => {
  const { provider, calls } = fixture();
  for (let i = 0; i < BUILDX_AUTH_LIMITS.sessions; i++) assert.equal((await login(provider)).ok, true);
  const before = calls.length; assert.equal((await login(provider)).error.code, 'AUTH_CAPACITY'); assert.equal(calls.length, before); provider.close();
});

test('fresh session verification checks provider again and rejects user identity drift', async () => {
  let currentUser = user; const { provider } = fixture(url => response(url.includes('/user') ? currentUser : tokens));
  const signed = await login(provider); currentUser = other;
  assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_SESSION_CHANGED');
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('known expired access session is removed before network verification', async () => {
  let instant = at; const { provider, calls } = fixture(undefined, { now: () => instant });
  const signed = await login(provider); const count = calls.length; instant += 3600000;
  assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_SESSION_EXPIRED'); assert.equal(calls.length, count); provider.close();
});

test('expiration during provider verification cannot authorize late result', async () => {
  let instant = at; const { provider } = fixture((url, init, calls) => {
    if (calls.length === 3) instant += 3600000;
    return response(url.includes('/user') ? user : tokens);
  }, { now: () => instant });
  const signed = await login(provider); assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_SESSION_EXPIRED'); provider.close();
});

test('401 verification invalidates retained local session', async () => {
  const { provider } = fixture((url, init, calls) => calls.length === 3 ? response({ message: 'private' }, 401) : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_SESSION_INVALID');
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('release during pending verification prevents late success from restoring identity', async () => {
  const wait = deferred(); const { provider } = fixture((url, init, calls) => calls.length === 3 ? wait.promise : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); const verifying = provider.verifySession(signed.value.sessionId);
  provider.release(signed.value.sessionId); wait.resolve(response(user));
  assert.equal((await verifying).error.code, 'AUTH_SESSION_CHANGED'); assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('refresh rotates tokens in owner and rechecks same identity', async () => {
  const rotated = { ...tokens, access_token: 'rotated-access-fixture', refresh_token: 'rotated-refresh-fixture' };
  const { provider, calls } = fixture(url => response(url.includes('/user') ? user : url.includes('refresh_token') ? rotated : tokens));
  const signed = await login(provider); const result = await provider.refresh(signed.value.sessionId);
  assert.equal(result.ok, true); assert.equal(result.value.sessionId, signed.value.sessionId);
  assert.deepEqual(JSON.parse(calls[2].init.body), { refresh_token: tokens.refresh_token });
  assert.equal(calls[3].init.headers.Authorization, 'Bearer rotated-access-fixture');
  assert.doesNotMatch(JSON.stringify(result), /rotated-|access_token|refresh_token/u); provider.close();
});

test('refresh cannot switch user and failed rotation discards old local authorization', async () => {
  const { provider } = fixture((url, init, calls) => response(url.includes('/user') ? calls.length > 3 ? other : user : tokens));
  const signed = await login(provider); assert.equal((await provider.refresh(signed.value.sessionId)).error.code, 'AUTH_SESSION_CHANGED');
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('signout explicitly targets only local provider session', async () => {
  const { provider, calls } = fixture(url => url.includes('/logout') ? new Response(null, { status: 204 }) : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); assert.deepEqual(await provider.signOut(signed.value.sessionId), { ok: true, value: { locallySignedOut: true, remoteRevoked: true } });
  assert.equal(calls[2].url, baseUrl + '/auth/v1/logout?scope=local'); assert.equal(calls[2].init.method, 'POST');
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('remote signout failure still removes local session and explicitly preserves uncertainty', async () => {
  const { provider } = fixture(url => url.includes('/logout') ? response({ private: true }, 500) : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); const result = await provider.signOut(signed.value.sessionId);
  assert.equal(result.error.code, 'AUTH_REMOTE_SIGNOUT_UNKNOWN'); assert.equal(result.error.locallySignedOut, true); assert.equal(result.error.remoteRevoked, null);
  assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('close during sign-in prevents late session issuance, aborts pending requests and never logs out other clients', async () => {
  const wait = deferred(); const { provider, calls } = fixture(() => wait.promise);
  const signing = login(provider); const result = provider.close(); assert.equal(result.value.retainedSessions, 0);
  assert.equal(result.value.closed, false); assert.equal(result.value.pendingRequests, 1);
  assert.equal(calls[0].init.signal.aborted, true); wait.resolve(response(tokens));
  assert.equal((await signing).error.code, 'AUTH_CLOSED'); assert.equal(provider.diagnostics().retainedSessions, 0);
  assert.equal(calls.length, 1); assert.equal((await login(provider)).error.code, 'AUTH_CLOSED');
  assert.equal(provider.close().value.closed, true);
});

test('unavailable provider denies this verification but does not fabricate revocation', async () => {
  const { provider } = fixture((url, init, calls) => calls.length === 3 ? response({}, 503) : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_PROVIDER_UNAVAILABLE');
  assert.equal(provider.diagnostics().retainedSessions, 1); assert.equal((await provider.verifySession(signed.value.sessionId)).ok, true); provider.close();
});

test('refresh overlap is rejected, and release during rotation prevents late account resurrection', async () => {
  const wait = deferred(); const { provider } = fixture((url, init, calls) => calls.length === 3 ? wait.promise : response(url.includes('/user') ? user : tokens));
  const signed = await login(provider); const rotating = provider.refresh(signed.value.sessionId);
  assert.equal((await provider.refresh(signed.value.sessionId)).error.code, 'AUTH_BUSY');
  assert.equal((await provider.verifySession(signed.value.sessionId)).error.code, 'AUTH_BUSY');
  provider.release(signed.value.sessionId); wait.resolve(response(tokens));
  assert.equal((await rotating).error.code, 'AUTH_SESSION_CHANGED'); assert.equal(provider.diagnostics().retainedSessions, 0); provider.close();
});

test('malformed expiry is rejected and earlier absolute expiry wins', async () => {
  for (const extras of [{ expires_in: 0 }, { expires_in: '3600' }, { expires_in: Number.MAX_SAFE_INTEGER }, { expires_at: at / 1000 - 1 }]) {
    const { provider } = fixture(() => response({ ...tokens, ...extras }));
    assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_INVALID'); provider.close();
  }
  const { provider } = fixture(url => response(url.includes('/user') ? user : { ...tokens, expires_at: at / 1000 + 60 }));
  assert.equal((await login(provider)).value.expiresAt, at + 60000); provider.close();
});

test('invalid trusted clock values still preserve public Result failure contract', async () => {
  const { provider } = fixture(undefined, { now: () => NaN });
  assert.equal((await login(provider)).error.code, 'AUTH_RESPONSE_INVALID');
  assert.equal((await provider.verify('test-access-fixture')).error.code, 'AUTH_RESPONSE_INVALID'); provider.close();
});
