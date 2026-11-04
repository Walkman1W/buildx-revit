import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createNativeSourceClient } from './lib/source-native-client.mjs';

const cwd = path.resolve('.');
const executable = path.join(cwd, 'fake-codex.exe');
const target = path.join(cwd, 'source.cs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const initializeResult = { codexHome: cwd, platformFamily: 'windows', platformOs: 'windows', userAgent: 'Codex Ω' };
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 123456;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.requests = [];
    this.ends = 0;
    this.kills = 0;
    this.stdin.write = (line, callback) => {
      const message = JSON.parse(line);
      this.requests.push(message);
      queueMicrotask(() => { callback?.(); this.onRequest?.(message); });
      return true;
    };
    this.stdin.end = () => { this.ends++; this.onEnd(); };
    this.onEnd = () => queueMicrotask(() => this.finish());
    this.onKill = () => queueMicrotask(() => this.finish());
  }
  reply(id, result) { this.send({ id, result }); }
  send(value) { this.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); }
  finish() { this.stdout.emit('end'); this.emit('exit', 0, null); this.emit('close', 0, null); }
  kill() { this.kills++; this.onKill(); return true; }
}
function setup({ onRead, onInitialize, spawn } = {}) {
  const child = new FakeChild();
  const launches = [];
  child.onRequest = message => {
    if (message.method === 'initialize') {
      if (onInitialize) onInitialize(child, message);
      else child.reply(message.id, initializeResult);
    } else if (message.method === 'fs/readFile') onRead?.(child, message);
  };
  const made = createNativeSourceClient({ executable, cwd, spawn: spawn ?? ((...args) => { launches.push(args); return child; }) });
  assert.equal(made.ok, true);
  return { child, client: made.value, launches };
}
const error = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code); };
async function started(options) {
  const value = setup(options);
  assert.deepEqual(await value.client.start(), { ok: true, value: undefined });
  return value;
}

test('factory exposes only the owned read-only lifecycle and rejects ambiguous options', () => {
  for (const options of [null, {}, { executable: 'codex', cwd }, { executable, cwd: '.' },
    { executable, cwd, method: 'command/exec' }, { executable, cwd, spawn: 1 },
    { get executable() { throw new Error('untrusted getter'); }, cwd }])
    error(createNativeSourceClient(options), 'SOURCE_NATIVE_INVALID_OPTIONS');
  assert.deepEqual(Object.keys(setup().client).sort(), ['close', 'diagnostics', 'readFile', 'start']);
});

test('factory snapshots executable, cwd and launch once before caller mutation or repeated getters', async () => {
  const child = new FakeChild();
  const launches = [];
  child.onRequest = request => {
    if (request.method === 'initialize') child.reply(request.id, initializeResult);
  };
  const reads = { executable: 0, cwd: 0, spawn: 0 };
  const values = { executable, cwd, spawn: (...args) => { launches.push(args); return child; } };
  const options = {};
  for (const key of Object.keys(values)) Object.defineProperty(options, key, {
    enumerable: true,
    get() { reads[key]++; return values[key]; },
    set(value) { values[key] = value; },
  });
  const made = createNativeSourceClient(options);
  assert.equal(made.ok, true);
  options.executable = path.join(cwd, 'replacement.exe');
  options.cwd = path.join(cwd, 'replacement-directory');
  options.spawn = () => { throw new Error('replacement launch must not run'); };
  assert.equal((await made.value.start()).ok, true);
  assert.deepEqual(launches, [[executable, ['app-server', '--listen', 'stdio://', '--strict-config'],
    { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]]);
  assert.deepEqual(reads, { executable: 1, cwd: 1, spawn: 1 });
  await made.value.close();
});

test('handshake and file read send only initialize, initialized and fs/readFile', async () => {
  const { client, child, launches } = await started({ onRead: (owned, request) => owned.reply(request.id, { dataBase64: 'eA==' }) });
  assert.deepEqual(launches, [[executable, ['app-server', '--listen', 'stdio://', '--strict-config'],
    { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]]);
  assert.deepEqual(await client.readFile(target, { maxBytes: 1 }), { ok: true, value: { dataBase64: 'eA==' } });
  assert.deepEqual(child.requests.map(value => value.method), ['initialize', 'initialized', 'fs/readFile']);
  assert.deepEqual(child.requests[2].params, { path: target });
  assert.equal(client.diagnostics().pending, false);
  assert.equal((await client.close()).ok, true);
  assert.equal(child.ends, 1);
  assert.equal(child.kills, 0);
});

test('empty file budget zero is supported and invalid requests never reach the transport', async () => {
  const { client, child } = await started({ onRead: (owned, request) => owned.reply(request.id, { dataBase64: '' }) });
  for (const options of [{}, { maxBytes: -1 }, { maxBytes: 524289 }, { maxBytes: 0.1 }, { maxBytes: 5, extra: true }])
    error(await client.readFile(target, options), 'SOURCE_NATIVE_INVALID_READ');
  error(await client.readFile('../outside.cs', { maxBytes: 1 }), 'SOURCE_NATIVE_INVALID_READ');
  assert.deepEqual(await client.readFile(target, { maxBytes: 0 }), { ok: true, value: { dataBase64: '' } });
  assert.equal(child.requests.filter(value => value.method === 'fs/readFile').length, 1);
  await client.close();
});

test('bounded multi-chunk full 512 KiB response and split UTF-8 initialize decode correctly', async () => {
  const encoded = Buffer.alloc(512 * 1024, 120).toString('base64');
  const { client } = await started({
    onInitialize(child, request) {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: initializeResult })}\n`);
      const omega = bytes.indexOf(Buffer.from('Ω'));
      child.stdout.emit('data', bytes.subarray(0, omega + 1));
      child.stdout.emit('data', bytes.subarray(omega + 1));
    },
    onRead(child, request) {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: { dataBase64: encoded } })}\n`);
      for (let start = 0; start < bytes.length; start += 997) child.stdout.emit('data', bytes.subarray(start, start + 997));
    },
  });
  assert.equal((await client.readFile(target, { maxBytes: 512 * 1024 })).value.dataBase64, encoded);
  assert.ok(client.diagnostics().frameLimitBytes < 710_000);
  await client.close();
});

test('frame expansion budget rejects multi-chunk overflow before decode or parse', async () => {
  const { client } = await started({ onRead(child) {
    child.stdout.emit('data', Buffer.alloc(4000, 65));
    child.stdout.emit('data', Buffer.alloc(100, 65));
  } });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_FRAME_BUDGET');
  assert.equal(client.diagnostics().bufferedBytes, 0);
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_NOT_READY');
  await client.close();
});

test('fatal UTF-8, invalid JSON and empty frames each poison the transport', async t => {
  for (const [name, bytes, code] of [
    ['utf8', Buffer.from([0xc0, 0xaf, 10]), 'SOURCE_NATIVE_INVALID_UTF8'],
    ['json', Buffer.from('{bad}\n'), 'SOURCE_NATIVE_INVALID_JSON'],
    ['empty', Buffer.from('\n'), 'SOURCE_NATIVE_EMPTY_FRAME'],
  ]) await t.test(name, async () => {
    const { client } = await started({ onRead: child => child.stdout.emit('data', bytes) });
    error(await client.readFile(target, { maxBytes: 10 }), code);
    await client.close();
  });
});

test('wrong, missing and string response IDs cannot satisfy the owned numeric request', async t => {
  for (const id of [null, 123, '2']) await t.test(String(id), async () => {
    const { client } = await started({ onRead: child => child.send({ ...(id === null ? {} : { id }), result: { dataBase64: '' } }) });
    error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_RESPONSE_ID');
    await client.close();
  });
});

test('response with both result and error is rejected', async () => {
  const { client } = await started({ onRead: (child, request) => child.send({ id: request.id, result: { dataBase64: '' }, error: { code: 1 } }) });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_INVALID_ENVELOPE');
  await client.close();
});

test('server permission requests fail closed and never receive an approval response', async () => {
  const { client, child } = await started({ onRead: owned => owned.send({ id: 9, method: 'item/permissions/requestApproval', params: { secret: 'must-not-leak' } }) });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_SERVER_REQUEST');
  assert.equal(child.requests.length, 3);
  assert.equal(JSON.stringify(client.diagnostics()).includes('must-not-leak'), false);
  await client.close();
});

test('bounded notifications discard payloads; excess count poisons instead of retaining messages', async () => {
  const { client, child } = await started();
  for (let index = 0; index < 65; index++) child.send({ method: 'notice', params: { untrusted: index } });
  assert.equal(client.diagnostics().discardedNotifications, 65);
  assert.equal(client.diagnostics().failureCode, 'SOURCE_NATIVE_NOTIFICATION_BUDGET');
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_NOT_READY');
  await client.close();
});

test('schema-declared emittedAtMs notification after initialized does not poison source reads', async () => {
  const { client, child } = await started({ onRead: (owned, request) => owned.reply(request.id, { dataBase64: '' }) });
  // Native ServerNotification adds emittedAtMs at the envelope boundary. The
  // independent successful fs probe also discarded one post-initialize notice.
  child.send({ method: 'account/updated', emittedAtMs: 1_792_729_060_000,
    params: { authMode: 'chatgpt', planType: null } });
  child.send({ method: 'notice', emittedAtMs: -1, params: {} });
  assert.equal((await client.readFile(target, { maxBytes: 0 })).ok, true);
  assert.equal(client.diagnostics().discardedNotifications, 2);
  assert.equal(client.diagnostics().protocolIssue, null);
  assert.equal(JSON.stringify(client.diagnostics()).includes('authMode'), false);
  await client.close();
});

test('notification timestamp validation and unsupported envelope keys remain fail-closed', async () => {
  for (const extra of [{ emittedAtMs: 0.5 }, { emittedAtMs: '123' },
    { emittedAtMs: Number.MAX_SAFE_INTEGER + 1 }, { futureUnknown: true }]) {
    const { client, child } = await started();
    child.send({ method: 'notice', params: {}, ...extra });
    assert.equal(client.diagnostics().failureCode, 'SOURCE_NATIVE_INVALID_ENVELOPE');
    assert.deepEqual(client.diagnostics().protocolIssue, extra.futureUnknown
      ? { boundary: 'notification', reason: 'unsupported_keys', unknownKeyCount: 1 }
      : { boundary: 'notification', reason: 'emitted_at_ms_shape' });
    assert.equal(JSON.stringify(client.diagnostics()).includes('futureUnknown'), false);
    error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_NOT_READY');
    await client.close();
  }
});

test('RPC errors expose only a fixed category and safe integer code, then allow the next response', async () => {
  let calls = 0;
  const { client } = await started({ onRead(child, request) {
    if (++calls === 1) child.send({ id: request.id, error: { code: -32603, message: 'private account text', data: 'secret' } });
    else child.reply(request.id, { dataBase64: '' });
  } });
  const result = await client.readFile(target, { maxBytes: 0 });
  error(result, 'SOURCE_NATIVE_RPC_ERROR');
  assert.equal(result.error.rpcCode, -32603);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await client.readFile(target, { maxBytes: 0 })).ok, true);
  await client.close();
});

test('file result shape and base64 representation budget are independently enforced', async t => {
  for (const [name, result, code] of [
    ['shape', { dataBase64: 3 }, 'SOURCE_NATIVE_READ_SHAPE'],
    ['length', { dataBase64: 'eA==' }, 'SOURCE_NATIVE_FILE_BUDGET'],
  ]) await t.test(name, async () => {
    const { client } = await started({ onRead: (child, request) => child.reply(request.id, result) });
    error(await client.readFile(target, { maxBytes: 0 }), code);
    await client.close();
  });
});

test('concurrent calls return busy without corrupting the first request', async () => {
  const { client, child } = await started();
  const first = client.readFile(target, { maxBytes: 0 });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_BUSY');
  await flush();
  child.reply(2, { dataBase64: '' });
  assert.equal((await first).ok, true);
  await client.close();
});

test('timeout poisons the session and a late reply cannot become a later request result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, child } = await started();
  const first = client.readFile(target, { maxBytes: 0 });
  t.mock.timers.tick(20_000);
  error(await first, 'SOURCE_NATIVE_TIMEOUT');
  child.reply(2, { dataBase64: '' });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_NOT_READY');
  assert.deepEqual(child.requests.map(value => value.method), ['initialize', 'initialized', 'fs/readFile']);
  await client.close();
});

test('valid response followed by an alien response in the same chunk is not published as success', async () => {
  const { client } = await started({ onRead(child, request) {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result: { dataBase64: '' } })}\n` +
      `${JSON.stringify({ id: 99, result: { secret: 'not-returned' } })}\n`));
  } });
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_RESPONSE_ID');
  await client.close();
});

test('spawn throw and asynchronous child error produce Results without exposing raw errors', async t => {
  await t.test('throw', async () => {
    const { client } = setup({ spawn: () => { throw new Error('credential path'); } });
    error(await client.start(), 'SOURCE_NATIVE_SPAWN_ERROR');
    assert.equal((await client.close()).ok, true);
  });
  await t.test('event', async () => {
    const { client } = setup({ onInitialize: child => child.emit('error', new Error('credential path')) });
    error(await client.start(), 'SOURCE_NATIVE_CHILD_ERROR');
    await client.close();
  });
});

test('initialize response shape, duplicate start and initialization timeout are bounded', async t => {
  await t.test('shape', async () => {
    const { client } = setup({ onInitialize: (child, request) => child.reply(request.id, { platformOs: 'windows' }) });
    error(await client.start(), 'SOURCE_NATIVE_INITIALIZE_SHAPE');
    await client.close();
  });
  await t.test('busy and timeout', async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = setup({ onInitialize() {} });
    const starting = client.start();
    error(await client.start(), 'SOURCE_NATIVE_BUSY');
    t.mock.timers.tick(20_000);
    error(await starting, 'SOURCE_NATIVE_TIMEOUT');
    error(await client.start(), 'SOURCE_NATIVE_NOT_REUSABLE');
    await client.close();
  });
});

test('EOF and exit during requests fail promptly and late stream errors remain handled', async t => {
  for (const [event, code] of [['end', 'SOURCE_NATIVE_STDOUT_EOF'], ['exit', 'SOURCE_NATIVE_CHILD_EXIT']])
    await t.test(event, async () => {
      const { client, child } = await started({ onRead: owned => event === 'end' ? owned.stdout.emit('end') : owned.emit('exit', 1, null) });
      error(await client.readFile(target, { maxBytes: 0 }), code);
      await client.close();
      child.emit('error', new Error('late'));
      child.stdin.emit('error', new Error('late'));
      child.stdout.emit('error', new Error('late'));
      child.stderr.emit('error', new Error('late'));
      assert.equal(client.diagnostics().state, 'closed');
    });
});

test('close rejects active/new requests and waits for final close beyond exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, child } = await started();
  child.onEnd = () => child.emit('exit', 0, null);
  const pending = client.readFile(target, { maxBytes: 0 });
  const closing = client.close();
  error(await pending, 'SOURCE_NATIVE_CLOSING');
  error(await client.readFile(target, { maxBytes: 0 }), 'SOURCE_NATIVE_NOT_READY');
  assert.equal(client.diagnostics().retainedOwnership, true);
  assert.equal(client.diagnostics().closeObserved, false);
  child.emit('close', 0, null);
  assert.equal((await closing).ok, true);
  assert.equal(child.kills, 0);
});

test('cleanup timeout retains owned handle, retries kill through that handle, and accepts late close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, child } = await started();
  child.onEnd = () => {};
  child.onKill = () => { throw new Error('kill not permitted'); };
  const first = client.close();
  t.mock.timers.tick(3000);
  await flush();
  t.mock.timers.tick(3000);
  error(await first, 'SOURCE_NATIVE_CLEANUP_UNCONFIRMED');
  assert.equal(client.diagnostics().retainedOwnership, true);
  assert.equal(child.kills, 1);
  child.onKill = () => child.finish();
  const second = client.close();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal((await second).ok, true);
  assert.equal(child.ends, 1);
  assert.equal(child.kills, 2);
  assert.equal(client.diagnostics().retainedOwnership, false);
});

test('stderr is counted without retained content and graceful cleanup stays idempotent', async () => {
  const { client, child } = await started();
  child.stderr.emit('data', Buffer.from('private diagnostic text'));
  assert.equal(client.diagnostics().stderrBytesDiscarded, 23);
  assert.equal(JSON.stringify(client.diagnostics()).includes('private'), false);
  await client.close();
  await client.close();
  assert.equal(child.ends, 1);
  assert.equal(child.kills, 0);
});
