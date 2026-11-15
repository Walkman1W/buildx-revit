import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexConfirmation } from '../lib/codex-confirmation.mjs';

const initial = Date.parse('2026-10-25T19:45:00.000Z');
function fixture(required = true) {
  let now = initial; const invalidations = [];
  const owner = createCodexConfirmation({ required, now: () => now, onInvalidate: reason => invalidations.push(reason) });
  const facts = (overrides = {}) => ({ scope: 'model', clientId: 'browser-one',
    buildx: { sessionId: 'private-internal-session', userId: 'private-user-identifier', generation: 1, verified: true, expiresAt: now + 3600000 },
    codex: { connectionGeneration: 2, accountRevision: 3, observationSequence: 10, observedAt: new Date(now).toISOString(), status: 'verified', type: 'chatgpt', ready: true },
    ...overrides });
  const bind = () => { const prepared = owner.prepare(facts()); assert.equal(prepared.ok, true);
    const next = facts(); next.codex.observationSequence++; assert.equal(owner.confirm(prepared.value.challengeId, next).ok, true); return next; };
  return { owner, facts, invalidations, bind, advance: delta => { now += delta; }, now: () => now };
}
const pii = /private-internal-session|private-user-identifier|browser-one|challengeId|email|password|access_token|refresh_token/;

test('research without required BuildX identity never claims an account binding', () => {
  const f = fixture(false);
  assert.equal(f.owner.status(null).phase, 'not_applicable'); assert.equal(f.owner.status(f.facts()).localConnectionConfirmed, false);
  assert.equal(f.owner.prepare(f.facts()).ok, false); assert.equal(f.invalidations.length, 0); f.owner.close();
});

test('source workspace facts cannot create a model confirmation', () => {
  const f = fixture(); const source = f.facts({ scope: 'source-development' });
  assert.equal(f.owner.prepare(source).ok, false); assert.equal(f.owner.status(source).localConnectionConfirmed, false); f.owner.close();
});

test('prepare issues only one bounded local challenge and no PII in public status', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); assert.equal(prepared.ok, true);
  assert.match(prepared.value.challengeId, /^[a-f0-9-]{36}$/); assert.equal(prepared.value.expiresAt, initial + 300000);
  assert.deepEqual(Object.keys(prepared.value).sort(), ['challengeId', 'confirmation', 'expiresAt']);
  assert.doesNotMatch(JSON.stringify(prepared.value.confirmation), pii);
  assert.doesNotMatch(JSON.stringify(f.owner.status(f.facts())), pii); assert.equal(f.invalidations.length, 0); f.owner.close();
});

test('explicit confirmation needs a newer successful observation and exposes no stable account ID', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts());
  assert.equal(f.owner.confirm(prepared.value.challengeId, f.facts()).error.code, 'CONFIRMATION_FRESH_OBSERVATION_REQUIRED');
  const newer = f.facts(); newer.codex.observationSequence++;
  const result = f.owner.confirm(prepared.value.challengeId, newer); assert.equal(result.ok, true);
  assert.equal(result.value.confirmation.localConnectionConfirmed, true); assert.equal(result.value.confirmation.stableAccountId, null);
  assert.equal(result.value.confirmation.workspaceId, null); assert.doesNotMatch(JSON.stringify(result), pii); f.owner.close();
});

test('the issuing client must confirm, but confirmed installation status is shared with authorized tabs', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); const newer = f.facts({ clientId: 'browser-two' }); newer.codex.observationSequence++;
  assert.equal(f.owner.confirm(prepared.value.challengeId, newer).error.code, 'CONFIRMATION_CLIENT_CHANGED');
  newer.clientId = 'browser-one'; assert.equal(f.owner.confirm(prepared.value.challengeId, newer).ok, true);
  assert.equal(f.owner.status({ ...newer, clientId: 'installation-status' }).localConnectionConfirmed, true); f.owner.close();
});

test('ordinary challenge replacement does not invalidate context or leave old nonce usable', () => {
  const f = fixture(); const first = f.owner.prepare(f.facts()); const second = f.owner.prepare(f.facts());
  assert.notEqual(first.value.challengeId, second.value.challengeId); assert.equal(f.invalidations.length, 0);
  const next = f.facts(); next.codex.observationSequence++;
  assert.equal(f.owner.confirm(first.value.challengeId, next).error.code, 'CONFIRMATION_CHALLENGE_INVALID');
  assert.equal(f.owner.confirm(second.value.challengeId, next).ok, true); f.owner.close();
});

test('challenge expires at its deadline without accepting a late fresh observation', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); f.advance(300000);
  const fresh = f.facts(); fresh.codex.observationSequence++;
  assert.equal(f.owner.confirm(prepared.value.challengeId, fresh).error.code, 'CONFIRMATION_CHALLENGE_INVALID');
  assert.equal(f.owner.status(fresh).localConnectionConfirmed, false); f.owner.close();
});

test('prepare and confirm require recent observation and cannot use a future or malformed timestamp', () => {
  const f = fixture(); const old = f.facts(); f.advance(300001);
  assert.equal(f.owner.prepare(old).error.code, 'CONFIRMATION_OBSERVATION_REQUIRED');
  for (const observedAt of ['not-a-date', new Date(f.now() + 1).toISOString(), 123, {}]) {
    const malformed = f.facts(); malformed.codex.observedAt = observedAt;
    assert.equal(f.owner.prepare(malformed).ok, false);
  }
  f.owner.close();
});

test('same-key confirmed status survives observation age and same-session BuildX renewal', () => {
  const f = fixture(); const bound = f.bind(); f.advance(300001);
  bound.buildx.expiresAt = f.now() + 3600000;
  assert.equal(f.owner.status(bound).localConnectionConfirmed, true); assert.equal(f.invalidations.length, 0);
  assert.equal(f.owner.prepare(bound).error.code, 'CONFIRMATION_OBSERVATION_REQUIRED'); f.owner.close();
});

test('normal Codex checking suspends readiness without retiring confirmed proof or context', () => {
  const f = fixture(); const bound = f.bind(); const checking = structuredClone(bound);
  checking.codex.status = 'checking'; checking.codex.ready = false;
  assert.equal(f.owner.status(checking).phase, 'checking'); assert.equal(f.owner.status(checking).localConnectionConfirmed, false);
  assert.equal(f.owner.prepare(checking).error.code, 'CONFIRMATION_CHECKING');
  assert.equal(f.invalidations.length, 0); assert.equal(f.owner.status(bound).localConnectionConfirmed, true); f.owner.close();
});

test('same owned BuildX session temporarily unverified does not become an observed identity change', () => {
  const f = fixture(); const bound = f.bind(); const pending = structuredClone(bound); pending.buildx.verified = false;
  assert.equal(f.owner.status(pending).phase, 'checking'); assert.equal(f.invalidations.length, 0);
  assert.equal(f.owner.prepare(pending).error.code, 'CONFIRMATION_CHECKING');
  assert.equal(f.owner.status(bound).localConnectionConfirmed, true); assert.equal(f.invalidations.length, 0); f.owner.close();
});

test('pending challenge remains recoverable while either identity owner is temporarily checking', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); const pending = f.facts(); pending.buildx.verified = false; pending.codex.observationSequence++;
  assert.equal(f.owner.confirm(prepared.value.challengeId, pending).error.code, 'CONFIRMATION_CHECKING');
  assert.equal(f.invalidations.length, 0); pending.buildx.verified = true;
  assert.equal(f.owner.confirm(prepared.value.challengeId, pending).ok, true); f.owner.close();
});

test('unknown observation pauses rather than fabricating an account-switch observation', () => {
  const f = fixture(); const bound = f.bind(); const unknown = structuredClone(bound);
  unknown.codex.status = 'unknown'; unknown.codex.ready = false; unknown.codex.type = null;
  assert.equal(f.owner.status(unknown).localConnectionConfirmed, false); assert.equal(f.invalidations.length, 0);
  assert.equal(f.owner.status(bound).localConnectionConfirmed, true); f.owner.close();
});

test('each real identity-key change retires proof exactly once and does not restore on old challenge', () => {
  for (const change of [f => f.buildx.sessionId += '-new', f => f.buildx.userId += '-new', f => f.buildx.generation++,
    f => f.codex.connectionGeneration++, f => f.codex.accountRevision++]) {
    const f = fixture(); const bound = f.bind(); const next = structuredClone(bound); change(next);
    assert.equal(f.owner.status(next).localConnectionConfirmed, false); assert.equal(f.invalidations.length, 1);
    f.owner.status(next); assert.equal(f.invalidations.length, 1); f.owner.close();
  }
});

test('explicit account invalidation retires old confirmation but unknown alone does not', () => {
  const f = fixture(); const bound = f.bind(); bound.codex.status = 'invalidated'; bound.codex.type = null; bound.codex.ready = false;
  assert.equal(f.owner.status(bound).phase, 'unavailable'); assert.deepEqual(f.invalidations, ['codex_changed']);
  f.owner.status(bound); assert.equal(f.invalidations.length, 1); f.owner.close();
});

test('BuildX expiry is checked synchronously even before delayed timer processing', () => {
  const f = fixture(); const bound = f.bind(); f.advance(3600000);
  assert.equal(f.owner.status(bound).localConnectionConfirmed, false); assert.deepEqual(f.invalidations, ['buildx_changed']);
  f.owner.status(bound); assert.equal(f.invalidations.length, 1); f.owner.close();
});

test('explicit invalidation removes pending nonce, repeated invalidation is idempotent', () => {
  for (const reason of ['buildx_changed', 'connection_changed', 'codex_changed', 'service_closed']) {
    const f = fixture(); const prepared = f.owner.prepare(f.facts()); f.owner.invalidate(reason); f.owner.invalidate(reason);
    assert.deepEqual(f.invalidations, [reason]); const fresh = f.facts(); fresh.codex.observationSequence++;
    assert.equal(f.owner.confirm(prepared.value.challengeId, fresh).error.code, 'CONFIRMATION_CHALLENGE_INVALID'); f.owner.close();
  }
  const f = fixture(); assert.throws(() => f.owner.invalidate('caller supplied private data'), /Invalid/); f.owner.close();
});

test('close blocks late confirmation and cannot be reopened using retained facts', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); assert.deepEqual(f.owner.close(), { closed: true });
  const newer = f.facts(); newer.codex.observationSequence++;
  assert.equal(f.owner.confirm(prepared.value.challengeId, newer).error.code, 'CONFIRMATION_CLOSED');
  assert.equal(f.owner.prepare(newer).error.code, 'CONFIRMATION_CLOSED'); assert.equal(f.owner.status(newer).phase, 'closed');
  f.owner.close(); assert.deepEqual(f.invalidations, ['service_closed']);
});

test('unsupported and malformed facts cannot grant readiness or echo private source data', () => {
  const f = fixture();
  for (const value of [null, {}, [], f.facts({ buildx: null }), f.facts({ codex: null }),
    f.facts({ clientId: 'private invalid client' }), f.facts({ codex: { ...f.facts().codex, connectionGeneration: '2' } }),
    f.facts({ buildx: { ...f.facts().buildx, verified: 'true' } })]) {
    assert.equal(f.owner.prepare(value).ok, false); assert.equal(f.owner.status(value).localConnectionConfirmed, false);
    assert.doesNotMatch(JSON.stringify(f.owner.status(value)), pii);
  }
  const getter = { get scope() { throw new Error('private-exception'); } };
  assert.equal(f.owner.prepare(getter).ok, false); assert.doesNotMatch(JSON.stringify(f.owner.status(getter)), /private-exception/); f.owner.close();
});

test('metadata and display fields cannot substitute for identity proof or mutate captured facts', () => {
  const f = fixture(); const facts = f.facts(); facts.codex.email = 'private@example.test'; facts.codex.stableAccountId = 'forged-stable-id';
  facts.buildx.role = 'admin'; const prepared = f.owner.prepare(facts); facts.buildx.sessionId = 'changed-after-prepare';
  const newer = f.facts(); newer.codex.observationSequence++;
  const confirmed = f.owner.confirm(prepared.value.challengeId, newer); assert.equal(confirmed.ok, true);
  assert.doesNotMatch(JSON.stringify(confirmed), /private@example|forged-stable|admin|changed-after/); assert.equal(confirmed.value.confirmation.stableAccountId, null); f.owner.close();
});

test('a newer sequence with a pre-challenge observation is not fresh confirmation', () => {
  const f = fixture(); const prepared = f.owner.prepare(f.facts()); const older = f.facts();
  older.codex.observationSequence++; older.codex.observedAt = new Date(initial - 1).toISOString();
  assert.equal(f.owner.confirm(prepared.value.challengeId, older).error.code, 'CONFIRMATION_FRESH_OBSERVATION_REQUIRED'); f.owner.close();
});
