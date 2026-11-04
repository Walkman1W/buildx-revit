import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';

const MAX_FILE_BYTES = 512 * 1024;
const INITIAL_FRAME_BYTES = 16 * 1024;
const ENVELOPE_BYTES = 4096;
const MAX_MESSAGES = 512;
const MAX_NOTIFICATIONS = 64;
const REQUEST_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 3000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ok = value => ({ ok: true, value });
const fail = (code, rpcCode) => ({ ok: false, error: {
  code, message: 'The internal read-only source transport could not complete this operation.',
  ...(rpcCode === undefined ? {} : { rpcCode }),
} });
const absolute = value => typeof value === 'string' && value.length <= 32767 &&
  !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value) && path.normalize(value) === value;

/**
 * An internal, owned App Server transport, not a filesystem sandbox. Its caller
 * must acquire and revalidate source-policy identities before and after reads.
 * No generic RPC, model turn, account, configuration or command API is exposed.
 */
export function createNativeSourceClient(options) {
  let snapshot;
  try {
    if (!object(options) || Object.keys(options).some(key => !['executable', 'cwd', 'spawn'].includes(key)))
      return fail('SOURCE_NATIVE_INVALID_OPTIONS');
    // Read each caller-owned property once. Validate and launch from that same
    // immutable snapshot, even when the original object changes or has getters.
    snapshot = Object.freeze({ executable: options.executable, cwd: options.cwd, spawn: options.spawn });
  } catch { return fail('SOURCE_NATIVE_INVALID_OPTIONS'); }
  const { executable, cwd, spawn } = snapshot;
  if (!absolute(executable) || !absolute(cwd) || (spawn !== undefined && typeof spawn !== 'function'))
    return fail('SOURCE_NATIVE_INVALID_OPTIONS');
  const launch = spawn ?? spawnChild;
  let state = 'created', child = null, pending = null, nextId = 0;
  let fault = null, protocolIssue = null, cleanupPromise = null, stdinEnded = false, killRequests = 0;
  let exitSeen = false, closeSeen = false, spawnError = false, exit = null;
  let messages = 0, notifications = 0, transportBytes = 0, stderrBytes = 0;
  let frame = Buffer.alloc(INITIAL_FRAME_BYTES), used = 0;
  const closeWaiters = new Set();
  const counter = (value, addition) => Math.min(Number.MAX_SAFE_INTEGER, value + addition);

  function settle(result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve(result);
  }
  function poison(code) {
    fault ??= code;
    if (state !== 'closing' && state !== 'closed') state = 'poisoned';
    used = 0;
    settle(fail(code));
  }
  function invalidEnvelope(boundary, reason, unknownKeyCount) {
    // Fixed diagnostic vocabulary only. Never retain arbitrary keys, methods,
    // parameters, JSON fragments or initialization/account response values.
    protocolIssue ??= { boundary, reason,
      ...(unknownKeyCount === undefined ? {} : { unknownKeyCount: Math.min(unknownKeyCount, 16) }) };
    poison('SOURCE_NATIVE_INVALID_ENVELOPE');
  }
  function receive(line) {
    let decoded, message;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(line); }
    catch { poison('SOURCE_NATIVE_INVALID_UTF8'); return; }
    try { message = JSON.parse(decoded); }
    catch { poison('SOURCE_NATIVE_INVALID_JSON'); return; }
    messages++;
    if (messages > MAX_MESSAGES) { poison('SOURCE_NATIVE_MESSAGE_BUDGET'); return; }
    if (!object(message)) { invalidEnvelope('envelope', 'not_object'); return; }
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
      invalidEnvelope('envelope', 'jsonrpc_version'); return;
    }
    if (Object.hasOwn(message, 'method')) {
      if (Object.hasOwn(message, 'id')) { poison('SOURCE_NATIVE_SERVER_REQUEST'); return; }
      if (typeof message.method !== 'string' || message.method.length > 128) {
        invalidEnvelope('notification', 'method_shape'); return;
      }
      const unknownKeyCount = Object.keys(message)
        .filter(key => !['jsonrpc', 'method', 'params', 'emittedAtMs'].includes(key)).length;
      if (unknownKeyCount) {
        invalidEnvelope('notification', 'unsupported_keys', unknownKeyCount); return;
      }
      // ServerNotification declares an optional int64 timestamp with no minimum.
      // Refuse values JavaScript cannot represent without loss; discard valid
      // values without interpreting them as session or authorization identity.
      if (Object.hasOwn(message, 'emittedAtMs') && !Number.isSafeInteger(message.emittedAtMs)) {
        invalidEnvelope('notification', 'emitted_at_ms_shape'); return;
      }
      notifications++;
      if (notifications > MAX_NOTIFICATIONS) poison('SOURCE_NATIVE_NOTIFICATION_BUDGET');
      return;
    }
    if (!pending || message.id !== pending.id) { poison('SOURCE_NATIVE_RESPONSE_ID'); return; }
    const unknownKeyCount = Object.keys(message).filter(key => !['jsonrpc', 'id', 'result', 'error'].includes(key)).length;
    if (unknownKeyCount) { invalidEnvelope('response', 'unsupported_keys', unknownKeyCount); return; }
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
      invalidEnvelope('response', 'result_error_shape'); return;
    }
    if (Object.hasOwn(message, 'error')) {
      if (!object(message.error) || !Number.isSafeInteger(message.error.code)) {
        poison('SOURCE_NATIVE_INVALID_RPC_ERROR'); return;
      }
      settle(fail('SOURCE_NATIVE_RPC_ERROR', message.error.code));
      return;
    }
    if (pending.kind === 'initialize') {
      const value = message.result;
      if (!object(value) || !absolute(value.codexHome) ||
          !['platformFamily', 'platformOs', 'userAgent'].every(key =>
            typeof value[key] === 'string' && value[key].length <= 1024)) {
        poison('SOURCE_NATIVE_INITIALIZE_SHAPE'); return;
      }
      // Do not retain or expose the server's home, user agent or extension data.
      settle(ok(undefined));
    } else {
      const value = message.result;
      if (!object(value) || typeof value.dataBase64 !== 'string') {
        poison('SOURCE_NATIVE_READ_SHAPE'); return;
      }
      if (value.dataBase64.length > pending.base64Limit) {
        poison('SOURCE_NATIVE_FILE_BUDGET'); return;
      }
      settle(ok({ dataBase64: value.dataBase64 }));
    }
  }

  function onData(chunk) {
    if (state === 'poisoned' || state === 'closing' || state === 'closed') return;
    if (!Buffer.isBuffer(chunk)) { poison('SOURCE_NATIVE_TRANSPORT_TYPE'); return; }
    transportBytes = counter(transportBytes, chunk.length);
    let start = 0;
    while (start < chunk.length && state !== 'poisoned' && state !== 'closing' && state !== 'closed') {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const count = end - start;
      // Check before copy, decode or JSON.parse; storage never grows with input.
      if (used + count > frame.length) { poison('SOURCE_NATIVE_FRAME_BUDGET'); return; }
      chunk.copy(frame, used, start, end);
      used += count;
      if (newline < 0) return;
      let length = used;
      if (length && frame[length - 1] === 13) length--;
      used = 0;
      if (!length) { poison('SOURCE_NATIVE_EMPTY_FRAME'); return; }
      receive(frame.subarray(0, length));
      start = newline + 1;
    }
  }

  function write(message) {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error) poison('SOURCE_NATIVE_STDIN_ERROR');
      });
      return true;
    } catch { poison('SOURCE_NATIVE_STDIN_ERROR'); return false; }
  }
  function request(kind, params, maxBytes = 0) {
    if (pending) return Promise.resolve(fail('SOURCE_NATIVE_BUSY'));
    if (nextId >= 128) { poison('SOURCE_NATIVE_REQUEST_BUDGET'); return Promise.resolve(fail(fault)); }
    if (used !== 0) { poison('SOURCE_NATIVE_PARTIAL_FRAME'); return Promise.resolve(fail(fault)); }
    const base64Limit = 4 * Math.ceil(maxBytes / 3);
    const limit = kind === 'initialize' ? INITIAL_FRAME_BYTES : base64Limit + ENVELOPE_BYTES;
    frame = Buffer.alloc(limit);
    return new Promise(resolve => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending?.id === id) poison('SOURCE_NATIVE_TIMEOUT');
      }, REQUEST_TIMEOUT_MS);
      pending = { id, kind, base64Limit, resolve, timer };
      write({ id, method: kind === 'initialize' ? 'initialize' : 'fs/readFile', params });
    });
  }

  async function start() {
    if (state === 'ready') return ok(undefined);
    if (state !== 'created') return fail(state === 'starting' ? 'SOURCE_NATIVE_BUSY' : 'SOURCE_NATIVE_NOT_REUSABLE');
    state = 'starting';
    try {
      child = launch(executable, ['app-server', '--listen', 'stdio://', '--strict-config'],
        { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { spawnError = true; poison('SOURCE_NATIVE_SPAWN_ERROR'); return fail(fault); }
    // Retain this exact child handle even after failure; never rediscover by PID.
    child.on('error', () => { spawnError = true; poison('SOURCE_NATIVE_CHILD_ERROR'); });
    child.on('exit', (code, signal) => {
      exitSeen = true;
      exit = { code: Number.isSafeInteger(code) ? code : null,
        signal: typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? signal : null };
      if (state !== 'closing' && state !== 'closed') poison('SOURCE_NATIVE_CHILD_EXIT');
    });
    child.on('close', () => {
      closeSeen = true;
      if (state !== 'closing' && state !== 'closed') poison('SOURCE_NATIVE_CHILD_CLOSE');
      state = 'closed';
      for (const resolve of closeWaiters) resolve();
      closeWaiters.clear();
    });
    if (!child.stdin || !child.stdout || !child.stderr) { poison('SOURCE_NATIVE_CHILD_PIPES'); return fail(fault); }
    child.stdin.on('error', () => poison('SOURCE_NATIVE_STDIN_ERROR'));
    child.stdout.on('error', () => poison('SOURCE_NATIVE_STDOUT_ERROR'));
    child.stdout.on('end', () => {
      if (state !== 'closing' && state !== 'closed') poison('SOURCE_NATIVE_STDOUT_EOF');
    });
    child.stderr.on('error', () => poison('SOURCE_NATIVE_STDERR_ERROR'));
    child.stderr.on('data', chunk => { stderrBytes = counter(stderrBytes, Buffer.isBuffer(chunk) ? chunk.length : 0); });
    child.stdout.on('data', onData);
    const initialized = await request('initialize', {
      clientInfo: { name: 'buildx_source_reader', title: 'BuildX internal read-only source reader', version: '0.1.0' },
    });
    if (!initialized.ok) return initialized;
    if (state !== 'starting') return fail('SOURCE_NATIVE_NOT_REUSABLE');
    if (!write({ method: 'initialized' }) || state !== 'starting') return fail(fault ?? 'SOURCE_NATIVE_NOT_REUSABLE');
    state = 'ready';
    return ok(undefined);
  }

  async function readFile(absolutePath, readOptions) {
    if (!absolute(absolutePath) || !object(readOptions) ||
        Object.keys(readOptions).some(key => key !== 'maxBytes') ||
        !Number.isSafeInteger(readOptions.maxBytes) || readOptions.maxBytes < 0 || readOptions.maxBytes > MAX_FILE_BYTES)
      return fail('SOURCE_NATIVE_INVALID_READ');
    if (state !== 'ready') return fail('SOURCE_NATIVE_NOT_READY');
    const result = await request('readFile', { path: absolutePath }, readOptions.maxBytes);
    // A second frame in the same chunk may invalidate the just-received result
    // before this continuation runs. Never publish that poisoned batch as good.
    return fault ? fail(fault) : result;
  }

  function waitForClose() {
    if (closeSeen) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); closeWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, CLEANUP_TIMEOUT_MS);
      closeWaiters.add(done);
    });
  }
  async function close() {
    if (cleanupPromise) return cleanupPromise;
    if (!child) { state = 'closed'; return ok({ closed: true }); }
    if (closeSeen) { state = 'closed'; return ok({ closed: true }); }
    state = 'closing';
    settle(fail('SOURCE_NATIVE_CLOSING'));
    used = 0;
    cleanupPromise = (async () => {
      if (!stdinEnded) {
        stdinEnded = true;
        try { child.stdin?.end(); } catch { /* Owned handle retained for kill/close retry. */ }
      }
      await waitForClose();
      if (!closeSeen) {
        killRequests++;
        try { child.kill(); } catch { /* A failed kill is not an observed close. */ }
        await waitForClose();
      }
      if (!closeSeen) return fail('SOURCE_NATIVE_CLEANUP_UNCONFIRMED');
      state = 'closed';
      frame = Buffer.alloc(0);
      return ok({ closed: true });
    })();
    try { return await cleanupPromise; }
    finally { cleanupPromise = null; }
  }

  function diagnostics() {
    return { state, failureCode: fault, protocolIssue: protocolIssue ? { ...protocolIssue } : null, ownedChild: child !== null,
      pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      pending: pending !== null, requests: nextId, messages, discardedNotifications: notifications,
      transportBytes, stderrBytesDiscarded: stderrBytes, bufferedBytes: used,
      frameLimitBytes: frame.length, stdinEnded, killRequests, spawnError,
      exitObserved: exitSeen, closeObserved: closeSeen, exit: exit ? { ...exit } : null,
      retainedOwnership: child !== null && !closeSeen };
  }
  return ok(Object.freeze({ start, readFile, close, diagnostics }));
}
