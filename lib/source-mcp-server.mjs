import { SOURCE_TOOLS, createSourceTools } from './source-tools.mjs';

export const SOURCE_MCP_INPUT_MAX_BYTES = 64 * 1024;
export const SOURCE_MCP_DOMAIN_MAX_BYTES = 32 * 1024;
export const SOURCE_MCP_TOOL_FRAME_MAX_BYTES = 2 * SOURCE_MCP_DOMAIN_MAX_BYTES + 4096;
export const SOURCE_MCP_CATALOG_FRAME_MAX_BYTES = 128 * 1024;
export const SOURCE_MCP_SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const OUTPUT_QUEUE_MAX_BYTES = 256 * 1024, OUTPUT_QUEUE_MAX_FRAMES = 8;
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const only = (value, keys) => Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const success = value => ({ ok: true, value });
const failure = (code, message) => ({ ok: false, error: { code, message } });
const hasId = value => Object.prototype.hasOwnProperty.call(value, 'id');
const validId = value => value === null || (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= 128);
const domainFailure = () => failure('SOURCE_MCP_HANDLER_FAILED', 'The source handler failed without returning a usable result.');
const cleanupFailure = () => failure('SOURCE_MCP_CLEANUP_UNCONFIRMED',
  'Source service cleanup was not confirmed; the service remains owned and close can be retried.');
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const emptyParams = value => value === undefined || (plain(value) && only(value, ['_meta']) &&
  (value._meta === undefined || plain(value._meta)));

/**
 * A bounded stdio adapter for the independent read-only development service.
 * The source-tools owner alone interprets tool names, arguments and source scope.
 * Caller streams are borrowed: this adapter never ends or destroys them.
 * finished reports the first shutdown attempt; close() retries retained cleanup.
 */
export function createSourceMcpServer(options) {
  const invalid = () => failure('INVALID_SOURCE_MCP_SERVER', 'Readable input, writable output and a source service are required.');
  let input, output, service, inputOn, inputOff, outputOn, outputOff, write;
  try {
    if (!plain(options) || !only(options, ['input', 'output', 'service'])) return invalid();
    input = options.input; output = options.output; service = options.service;
    inputOn = input?.on; inputOff = input?.removeListener;
    outputOn = output?.on; outputOff = output?.removeListener; write = output?.write;
  } catch { return invalid(); }
  if (![inputOn, inputOff, outputOn, outputOff, write].every(method => typeof method === 'function')) return invalid();
  inputOn = inputOn.bind(input); inputOff = inputOff.bind(input);
  outputOn = outputOn.bind(output); outputOff = outputOff.bind(output); write = write.bind(output);
  if (service === undefined) {
    const made = createSourceTools();
    if (!made.ok) return made;
    service = made.value;
  }
  let invokeMethod, closeMethod;
  try { invokeMethod = service?.invoke; closeMethod = service?.close; } catch { return invalid(); }
  if (typeof invokeMethod !== 'function' || typeof closeMethod !== 'function') return invalid();
  const invoke = invokeMethod.bind(service), closeService = closeMethod.bind(service);
  const names = new Set(SOURCE_TOOLS.map(tool => tool.name));
  if (names.size !== SOURCE_TOOLS.length) return failure('SOURCE_MCP_CATALOG_INVALID', 'Tool names must have one named contract each.');

  // Never append arbitrary raw chunks to an expanding string or array. A line
  // must fit this fixed allocation before UTF-8 decoding or JSON parsing occurs.
  const line = Buffer.allocUnsafe(SOURCE_MCP_INPUT_MAX_BYTES);
  let lineBytes = 0, started = false, stopping = false, state = 'uninitialized';
  let toolTask = null, toolBusy = false, closeTask = null, cleanupPending = false;
  let queue = [], queuedBytes = 0, writing = false;
  let framesReceived = 0, notificationsDiscarded = 0, emptyLines = 0, parseFailures = 0;
  let outputFrames = 0, outputBytes = 0, inputBytes = 0, cleanupAttempts = 0;
  let shutdownReason = null, firstShutdownSettled = false, resolveFinished;
  let outputDetachScheduled = false;
  const finished = new Promise(resolve => { resolveFinished = resolve; });

  function detachInput() {
    inputOff('data', onData); inputOff('end', onEnd); inputOff('error', onInputError);
  }
  function detachOutputWhenIdle() {
    if (writing || state !== 'closed' || outputDetachScheduled) return;
    outputDetachScheduled = true;
    // A Writable may emit its error just after invoking the write callback.
    // Retain our handler through that event before relinquishing the listener.
    setImmediate(() => { if (!writing && state === 'closed') outputOff('error', onOutputError); });
  }

  async function close(reason = 'requested') {
    if (closeTask) return closeTask;
    if (state === 'closed') return success({ closed: true, cleanupPending: false });
    stopping = true; state = 'closing'; shutdownReason ??= reason;
    detachInput(); lineBytes = 0; queue = []; queuedBytes = 0;
    closeTask = (async () => {
      cleanupAttempts++;
      let confirmedClosed = false;
      try {
        const result = await closeService();
        const value = plain(result) && result.ok === true ? result.value : null;
        confirmedClosed = plain(value) && value.closed === true;
      } catch { /* An unknown outcome retains the same owned service. */ }
      if (!confirmedClosed) {
        state = 'cleanup_pending'; cleanupPending = true;
        return cleanupFailure();
      }
      if (toolTask) await toolTask;
      state = 'closed'; cleanupPending = false;
      detachOutputWhenIdle();
      return success({ closed: true, cleanupPending: false });
    })();
    const pending = closeTask;
    try {
      const result = await pending;
      if (!firstShutdownSettled) { firstShutdownSettled = true; resolveFinished(result); }
      return result;
    } finally { if (closeTask === pending) closeTask = null; }
  }

  function stop(reason) { void close(reason); }
  function onEnd() {
    // A final JSON value without a newline is a valid final stdio frame.
    if (lineBytes > 0 && !stopping) consumeLine();
    stop('input_eof');
  }
  function onInputError() { stop('input_error'); }
  function onOutputError() { stop('output_error'); }

  function pump() {
    if (writing || stopping || queue.length === 0) return;
    const frame = queue.shift(); queuedBytes -= frame.length; writing = true;
    let completed = false;
    const written = error => {
      if (completed) return;
      completed = true; writing = false;
      if (error) { stop('output_error'); return; }
      outputFrames++; outputBytes += frame.length;
      detachOutputWhenIdle();
      pump();
    };
    try { write(frame, written); } catch { written(true); }
  }

  function send(message, maxBytes = SOURCE_MCP_TOOL_FRAME_MAX_BYTES) {
    if (stopping) return false;
    let text;
    try { text = JSON.stringify(message); } catch { stop('output_contract'); return false; }
    const size = Buffer.byteLength(text, 'utf8') + 1;
    if (size > maxBytes) { stop('output_frame_budget'); return false; }
    if (queue.length >= OUTPUT_QUEUE_MAX_FRAMES || queuedBytes + size > OUTPUT_QUEUE_MAX_BYTES) {
      stop('output_queue_budget'); return false;
    }
    queue.push(Buffer.from(`${text}\n`, 'utf8')); queuedBytes += size; pump();
    return true;
  }

  const replyError = (id, code, message) => send(rpcError(id, code, message));
  const reply = (id, result, maxBytes) => send({ jsonrpc: '2.0', id, result }, maxBytes);

  function safeDomain(result) {
    try {
      if (!plain(result)) result = domainFailure();
      let text = JSON.stringify(result);
      if (typeof text !== 'string') { result = domainFailure(); text = JSON.stringify(result); }
      if (Buffer.byteLength(text, 'utf8') > SOURCE_MCP_DOMAIN_MAX_BYTES) {
        result = failure('SOURCE_MCP_RESULT_TOO_LARGE', 'The source result exceeded the domain output budget.');
        text = JSON.stringify(result);
      }
      // Derive the flag from the exact bounded JSON being transported. Reading
      // a live object's tag again can disagree with its getters or toJSON.
      const transported = JSON.parse(text);
      if (!plain(transported) || typeof transported.ok !== 'boolean') throw new Error();
      return { content: [{ type: 'text', text }], isError: !transported.ok };
    } catch {
      const result = domainFailure();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
    }
  }

  function handle(request) {
    const requestObject = plain(request), idPresent = requestObject && hasId(request);
    const id = idPresent && validId(request.id) ? request.id : null;
    if (!requestObject || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        request.method.length > 128 || !only(request, ['jsonrpc', 'id', 'method', 'params']) ||
        (idPresent && !validId(request.id)) || (request.params !== undefined && !plain(request.params))) {
      if (idPresent || !requestObject) replyError(id, -32600, 'Invalid JSON-RPC request.');
      else notificationsDiscarded++;
      return;
    }
    if (!idPresent) {
      if (request.method === 'notifications/initialized' && state === 'awaiting_initialized' && emptyParams(request.params)) state = 'ready';
      else notificationsDiscarded++;
      return;
    }
    if (request.method === 'initialize') {
      const params = request.params;
      if (state !== 'uninitialized') { replyError(id, -32600, 'The server has already initialized.'); return; }
      if (!plain(params) || !only(params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta']) ||
          typeof params.protocolVersion !== 'string' || params.protocolVersion.length > 64 ||
          !plain(params.capabilities) || !plain(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' ||
          (params._meta !== undefined && !plain(params._meta))) {
        replyError(id, -32602, 'Invalid initialization parameters.'); return;
      }
      const protocolVersion = SOURCE_MCP_SUPPORTED_PROTOCOLS.includes(params.protocolVersion)
        ? params.protocolVersion : SOURCE_MCP_SUPPORTED_PROTOCOLS[0];
      state = 'awaiting_initialized';
      reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'buildx-source-readonly', version: '0.1.0' } });
      return;
    }
    if (request.method === 'ping') {
      if (!emptyParams(request.params)) replyError(id, -32602, 'Invalid ping parameters.');
      else reply(id, {});
      return;
    }
    if (!['tools/list', 'tools/call'].includes(request.method)) { replyError(id, -32601, 'Unknown method.'); return; }
    if (state !== 'ready') { replyError(id, -32002, 'The initialization handshake is incomplete.'); return; }
    if (request.method === 'tools/list') {
      if (!emptyParams(request.params)) replyError(id, -32602, 'Invalid tool-list parameters.');
      else reply(id, { tools: SOURCE_TOOLS }, SOURCE_MCP_CATALOG_FRAME_MAX_BYTES);
      return;
    }
    const params = request.params;
    if (!plain(params) || !only(params, ['name', 'arguments', '_meta']) || !names.has(params.name) ||
        (params.arguments !== undefined && !plain(params.arguments)) || (params._meta !== undefined && !plain(params._meta))) {
      replyError(id, -32602, 'Select a named source tool with object arguments.'); return;
    }
    if (toolBusy) { replyError(id, -32001, 'The source tool service is busy.'); return; }
    toolBusy = true;
    const name = params.name, args = params.arguments ?? {};
    toolTask = (async () => {
      let result;
      try { result = await invoke(name, args); } catch { result = domainFailure(); }
      if (!stopping) reply(id, safeDomain(result));
    })().finally(() => { toolBusy = false; toolTask = null; });
  }

  function consumeLine() {
    let count = lineBytes; lineBytes = 0;
    if (count > 0 && line[count - 1] === 13) count--;
    if (count === 0) { emptyLines++; return; }
    framesReceived++;
    let text, request;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line.subarray(0, count)); request = JSON.parse(text); }
    catch { parseFailures++; replyError(null, -32700, 'Invalid UTF-8 JSON frame.'); return; }
    handle(request);
  }

  function onData(chunk) {
    if (stopping) return;
    if (!(chunk instanceof Uint8Array)) { stop('nonbinary_input'); return; }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    inputBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length && !stopping) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const incoming = end - offset;
      if (lineBytes + incoming > SOURCE_MCP_INPUT_MAX_BYTES) {
        parseFailures++; replyError(null, -32700, 'The input JSON frame exceeded its byte budget.');
        stop('input_frame_budget'); return;
      }
      bytes.copy(line, lineBytes, offset, end); lineBytes += incoming;
      if (newline === -1) break;
      consumeLine(); offset = newline + 1;
    }
  }

  function start() {
    if (started || stopping) return failure('SOURCE_MCP_ALREADY_STARTED', 'A server instance starts only once.');
    started = true;
    inputOn('end', onEnd); inputOn('error', onInputError);
    outputOn('error', onOutputError); inputOn('data', onData);
    return success(undefined);
  }

  function diagnostics() {
    return { started, state, stopping, toolBusy, cleanupPending, cleanupAttempts, shutdownReason,
      framesReceived, notificationsDiscarded, emptyLines, parseFailures, inputBytes, bufferedInputBytes: lineBytes,
      inputMaxBytes: SOURCE_MCP_INPUT_MAX_BYTES, queuedOutputBytes: queuedBytes, queuedOutputFrames: queue.length,
      outputWriting: writing, outputFrames, outputBytes, serviceRetained: state !== 'closed' };
  }

  return success(Object.freeze({ start, close, finished, diagnostics }));
}
