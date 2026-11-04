import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { SOURCE_TOOLS } from './lib/source-tools.mjs';
import { createSourceMcpServer, SOURCE_MCP_INPUT_MAX_BYTES, SOURCE_MCP_DOMAIN_MAX_BYTES,
  SOURCE_MCP_TOOL_FRAME_MAX_BYTES, SOURCE_MCP_SUPPORTED_PROTOCOLS } from './lib/source-mcp-server.mjs';

const projectRoot = fileURLToPath(new URL('./', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notify = (method, params) => ({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
const init = id => request(id, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'source-test', version: '1' } });
const tool = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const rootTool = 'buildx_source_list_roots', readTool = 'buildx_source_read_file', searchTool = 'buildx_source_search';

async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error('Expected production boundary event did not arrive.');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fixture(t, { invoke, close, output: customOutput } = {}) {
  const input = new PassThrough(), frames = [], chunks = [], calls = [];
  let closeCalls = 0;
  const output = customOutput ?? new Writable({ write(chunk, encoding, callback) {
    chunks.push(Buffer.from(chunk));
    for (const line of chunk.toString('utf8').trimEnd().split('\n')) frames.push(JSON.parse(line));
    callback();
  } });
  output.on('error', () => {});
  const service = { async invoke(name, args) { calls.push({ name, args }); return invoke ? invoke(name, args) : { ok: true, value: { name, args } }; },
    async close() { closeCalls++; return close ? close() : { ok: true, value: { closed: true } }; } };
  const server = take(createSourceMcpServer({ input, output, service }));
  take(server.start());
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); });
  const send = value => input.write(Buffer.from(JSON.stringify(value) + '\n'));
  return { input, output, server, frames, chunks, calls, send, closeCalls: () => closeCalls,
    async initialized(protocolVersion = '2025-06-18') {
      const message = init('init'); message.params.protocolVersion = protocolVersion; send(message);
      await until(() => frames.some(frame => frame.id === 'init'));
      send(notify('notifications/initialized'));
    }, async response(id) { await until(() => frames.some(frame => frame.id === id)); return frames.find(frame => frame.id === id); } };
}

test('factory requires borrowed stream interfaces and captures the exact service methods once', async t => {
  const f = fixture(t);
  for (const options of [null, {}, { input: {}, output: {} }, { input: f.input, output: f.output, extra: true },
    { input: f.input, output: f.output, service: {} }])
    assert.equal(createSourceMcpServer(options).error.code, 'INVALID_SOURCE_MCP_SERVER');
  let calls = 0, closeCalls = 0, invokeGets = 0, closeGets = 0;
  const service = { get invoke() { invokeGets++; return async () => { calls++; return { ok: true, value: {} }; }; },
    get close() { closeGets++; return async () => { closeCalls++; return { ok: true, value: { closed: true } }; }; } };
  const input = new PassThrough(), output = new Writable({ write(c, e, cb) { cb(); } });
  const server = take(createSourceMcpServer({ input, output, service }));
  Object.defineProperty(service, 'invoke', { value: () => { throw new Error('changed'); } });
  take(server.start());
  input.write(Buffer.from(JSON.stringify(init(1)) + '\n' + JSON.stringify(notify('notifications/initialized')) + '\n' + JSON.stringify(tool(2, rootTool)) + '\n'));
  await until(() => calls === 1 && !server.diagnostics().toolBusy);
  take(await server.close());
  assert.deepEqual([invokeGets, closeGets, calls, closeCalls], [1, 1, 1, 1]);
  assert.equal(input.destroyed, false); assert.equal(output.destroyed, false);
  input.destroy(); output.destroy();
});

test('initialize negotiates supported versions and never echoes an arbitrary unknown protocol', async t => {
  const f = fixture(t); await f.initialized('future-unknown-version');
  assert.equal(f.frames[0].result.protocolVersion, SOURCE_MCP_SUPPORTED_PROTOCOLS[0]);
  assert.equal(f.frames[0].result.protocolVersion === 'future-unknown-version', false);
  assert.equal(f.server.diagnostics().state, 'ready');
  f.send(init('duplicate'));
  assert.equal((await f.response('duplicate')).error.code, -32600);
  f.send(request('ping', 'ping')); assert.deepEqual((await f.response('ping')).result, {});
});

test('tool calls require a completed initialized notification and tools/list publishes the exact named catalog', async t => {
  const f = fixture(t);
  f.send(request(1, 'tools/list')); assert.equal((await f.response(1)).error.code, -32002);
  await f.initialized(); f.send(request(2, 'tools/list'));
  const listed = (await f.response(2)).result.tools;
  assert.deepEqual(listed, SOURCE_TOOLS);
  assert.equal(listed.length, 6); assert.equal(new Set(listed.map(item => item.name)).size, 6);
  assert.equal(f.calls.length, 0);
});

test('exact tool dispatch returns one text Result and isError tracks the domain failure rather than transport success', async t => {
  const f = fixture(t, { invoke: (name, args) => args.fail ? { ok: false, error: { code: 'EXPECTED', message: 'fixed' } }
    : { ok: true, value: { received: name } } });
  await f.initialized(); f.send(tool('success', rootTool));
  const good = (await f.response('success')).result;
  assert.equal(good.isError, false); assert.equal(good.content.length, 1);
  assert.equal(good.content[0].type, 'text'); assert.equal(good.structuredContent, undefined);
  assert.deepEqual(JSON.parse(good.content[0].text), { ok: true, value: { received: rootTool } });
  f.send(tool('failure', readTool, { fail: true }));
  const bad = (await f.response('failure')).result;
  assert.equal(bad.isError, true); assert.equal(JSON.parse(bad.content[0].text).error.code, 'EXPECTED');
  assert.deepEqual(f.calls.map(call => call.name), [rootTool, readTool]);
});

test('unknown methods, names and malformed envelope fields never reach source handlers', async t => {
  const f = fixture(t); await f.initialized();
  const samples = [request(1, 'shell/exec', {}), tool(2, 'buildx_source_read_file_alias'),
    request(3, 'tools/call', { name: rootTool, arguments: {}, command: 'ignored' }),
    { ...tool(4, rootTool), extra: true }, request(5, 'tools/call', { name: rootTool, arguments: [] }),
    request(6, 'tools/list', { cursor: 'unknown' }), request(7, 'ping', { extra: true })];
  for (const selected of samples) { f.send(selected); assert.ok((await f.response(selected.id)).error); }
  assert.equal((await f.response(1)).error.code, -32601);
  assert.equal(f.calls.length, 0);
});

test('notifications including invalid or unknown ones do not receive invented response IDs', async t => {
  const f = fixture(t); await f.initialized(); const before = f.frames.length;
  for (const selected of [notify('unknown'), notify('tools/call', { name: rootTool }),
    { ...notify('ping'), extra: true }, notify('notifications/initialized', { extra: true })]) f.send(selected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.frames.length, before); assert.equal(f.calls.length, 0);
  assert.equal(f.server.diagnostics().notificationsDiscarded, 4);
});

test('bad JSON, fatal UTF-8 and invalid IDs use fixed JSON-RPC errors without leaking raw data', async t => {
  const f = fixture(t); await f.initialized();
  f.input.write(Buffer.from('{"private":"DO_NOT_LEAK"\n'));
  f.input.write(Buffer.from([0xff, 0xfe, 10]));
  f.send({ ...request(false, 'ping') });
  await until(() => f.frames.filter(frame => frame.id === null).length === 3);
  assert.deepEqual(f.frames.filter(frame => frame.id === null).map(frame => frame.error.code), [-32700, -32700, -32600]);
  assert.equal(JSON.stringify(f.frames).includes('DO_NOT_LEAK'), false);
  f.send(request('alive', 'ping')); assert.deepEqual((await f.response('alive')).result, {});
});

test('empty lines and chunk-split UTF-8 frames are bounded and preserve exact request IDs', async t => {
  const f = fixture(t); await f.initialized();
  f.input.write(Buffer.from('\n\r\n'));
  const frame = Buffer.from(JSON.stringify(request('中文-ID', 'ping')) + '\n');
  const boundary = frame.indexOf(Buffer.from('中')) + 1;
  f.input.write(frame.subarray(0, boundary)); f.input.write(frame.subarray(boundary));
  assert.deepEqual((await f.response('中文-ID')).result, {});
  assert.equal(f.server.diagnostics().emptyLines, 2);
  assert.equal(f.server.diagnostics().bufferedInputBytes, 0);
});

test('oversized input is rejected before line decoding or handler invocation and owns final cleanup', async t => {
  const f = fixture(t);
  f.input.write(Buffer.alloc(SOURCE_MCP_INPUT_MAX_BYTES + 1, 0x61));
  take(await f.server.finished);
  assert.equal(f.server.diagnostics().shutdownReason, 'input_frame_budget');
  assert.equal(f.server.diagnostics().framesReceived, 0);
  assert.equal(f.server.diagnostics().bufferedInputBytes, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.closeCalls(), 1);
  assert.equal(f.input.destroyed, false); assert.equal(f.output.destroyed, false);
});

test('concurrent tool requests get bounded BUSY replies with their own IDs while the original retains its result', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { invoke: async () => { await held; return { ok: true, value: { completed: true } }; } });
  await f.initialized(); f.send(tool('first', readTool)); await until(() => f.calls.length === 1);
  f.send(tool('second', rootTool)); assert.equal((await f.response('second')).error.code, -32001);
  assert.equal(f.frames.some(frame => frame.id === 'first'), false);
  release(); assert.equal((await f.response('first')).result.isError, false);
  assert.equal(f.calls.length, 1);
});

test('whole domain Result and escaped MCP frame budgets are checked without structuredContent duplication', async t => {
  const near = { ok: true, value: { text: '\\"'.repeat(7000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(near)) < SOURCE_MCP_DOMAIN_MAX_BYTES);
  const f = fixture(t, { invoke: (name, args) => args.large ? { ok: true, value: 'x'.repeat(SOURCE_MCP_DOMAIN_MAX_BYTES) } : near });
  await f.initialized(); f.send(tool('near', rootTool));
  assert.deepEqual(JSON.parse((await f.response('near')).result.content[0].text), near);
  assert.ok(f.chunks.every(chunk => chunk.length <= SOURCE_MCP_TOOL_FRAME_MAX_BYTES));
  f.send(tool('large', rootTool, { large: true }));
  const large = (await f.response('large')).result;
  assert.equal(large.isError, true); assert.equal(JSON.parse(large.content[0].text).error.code, 'SOURCE_MCP_RESULT_TOO_LARGE');
});

test('throws, circular values and failing toJSON are fixed handler errors rather than raw exception output', async t => {
  const circular = { ok: true }; circular.value = circular;
  const values = [() => { throw new Error('DO_NOT_LEAK'); }, () => circular,
    () => ({ ok: true, toJSON() { throw new Error('DO_NOT_LEAK'); } }), () => ({ ok: true, toJSON() { return undefined; } })];
  const f = fixture(t, { invoke: () => values.shift()() }); await f.initialized();
  for (let id = 1; id <= 4; id++) {
    f.send(tool(id, rootTool)); const response = (await f.response(id)).result;
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0].text).error.code, 'SOURCE_MCP_HANDLER_FAILED');
  }
  assert.equal(JSON.stringify(f.frames).includes('DO_NOT_LEAK'), false);
});

test('isError derives from the exact transported Result tag instead of rereading mutable getters or toJSON', async t => {
  let tagReads = 0;
  const getterResult = { get ok() { tagReads++; return false; }, error: { code: 'EXPECTED', message: 'fixed' } };
  const values = [{ ok: true, toJSON() { return { ok: false, error: { code: 'EXPECTED', message: 'fixed' } }; } }, getterResult];
  const f = fixture(t, { invoke: () => values.shift() }); await f.initialized();
  for (let id = 1; id <= 2; id++) {
    f.send(tool(id, rootTool)); const response = (await f.response(id)).result;
    assert.equal(JSON.parse(response.content[0].text).ok, false); assert.equal(response.isError, true);
  }
  assert.equal(tagReads, 1);
});

test('EOF closes the service during an active call and joins its final handler without a stale response', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { invoke: async () => { await held; return { ok: true, value: {} }; },
    close: async () => { release(); return { ok: true, value: { closed: true } }; } });
  await f.initialized(); f.send(tool('active', readTool)); await until(() => f.calls.length === 1);
  f.input.end(); take(await f.server.finished);
  assert.equal(f.server.diagnostics().state, 'closed'); assert.equal(f.server.diagnostics().toolBusy, false);
  assert.equal(f.closeCalls(), 1); assert.equal(f.frames.some(frame => frame.id === 'active'), false);
});

test('cleanup failure retains the exact service and can retry without restarting or destroying caller streams', async t => {
  let failures = 1;
  const f = fixture(t, { close: async () => failures-- > 0 ? { ok: false, error: { code: 'PRIVATE', message: 'DO_NOT_LEAK' } }
    : { ok: true, value: { closed: true } } });
  f.input.end();
  const first = await f.server.finished;
  assert.equal(first.error.code, 'SOURCE_MCP_CLEANUP_UNCONFIRMED');
  assert.equal(JSON.stringify(first).includes('DO_NOT_LEAK'), false);
  assert.equal(f.server.diagnostics().cleanupPending, true);
  assert.equal(f.server.diagnostics().serviceRetained, true);
  assert.equal(f.output.destroyed, false);
  take(await f.server.close());
  assert.equal(f.server.diagnostics().state, 'closed'); assert.equal(f.closeCalls(), 2);
  assert.equal(f.server.diagnostics().serviceRetained, false);
});

test('only an explicit closed:true cleanup result releases ownership; malformed successes remain retryable', async t => {
  for (const unconfirmed of [{ ok: true }, { ok: true, value: { closed: false } },
    { ok: true, value: {} }, { ok: true, value: { closed: 'true' } }, { ok: true, value: null }]) {
    let attempts = 0;
    const f = fixture(t, { close: async () => ++attempts === 1 ? unconfirmed : { ok: true, value: { closed: true } } });
    f.input.end();
    const first = await f.server.finished;
    assert.equal(first.error.code, 'SOURCE_MCP_CLEANUP_UNCONFIRMED');
    assert.equal(f.server.diagnostics().state, 'cleanup_pending');
    assert.equal(f.server.diagnostics().cleanupPending, true);
    assert.equal(f.server.diagnostics().serviceRetained, true);
    assert.equal(f.closeCalls(), 1);
    take(await f.server.close());
    assert.equal(f.closeCalls(), 2);
    assert.equal(f.server.diagnostics().state, 'closed');
    assert.equal(f.server.diagnostics().serviceRetained, false);
    assert.equal(f.output.destroyed, false);
  }
});

test('input error and output EPIPE both close only the owned service and suppress raw IO messages', async t => {
  const first = fixture(t);
  first.input.emit('error', new Error('DO_NOT_LEAK')); take(await first.server.finished);
  assert.equal(first.server.diagnostics().shutdownReason, 'input_error'); assert.equal(first.closeCalls(), 1);
  const output = new Writable({ write(chunk, encoding, callback) {
    const error = new Error('DO_NOT_LEAK'); error.code = 'EPIPE'; callback(error);
  } });
  const second = fixture(t, { output }); second.send(request('p', 'ping'));
  take(await second.server.finished);
  assert.equal(second.server.diagnostics().shutdownReason, 'output_error'); assert.equal(second.closeCalls(), 1);
  assert.equal(second.input.destroyed, false);
});

test('unread output has a bounded queue and shuts down service ownership rather than accumulating replies', async t => {
  let finishWrite;
  const output = new Writable({ write(chunk, encoding, callback) { finishWrite = callback; } });
  const f = fixture(t, { output });
  for (let id = 0; id < 30; id++) f.send(request(id, 'ping'));
  take(await f.server.finished);
  assert.equal(f.server.diagnostics().shutdownReason, 'output_queue_budget');
  assert.equal(f.server.diagnostics().queuedOutputFrames, 0);
  assert.equal(f.closeCalls(), 1); finishWrite();
});

function childClient(child) {
  const frames = [], stderr = []; let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    assert.ok(Buffer.byteLength(pending) <= 256 * 1024);
    for (;;) {
      const newline = pending.indexOf('\n'); if (newline < 0) break;
      frames.push(JSON.parse(pending.slice(0, newline))); pending = pending.slice(newline + 1);
    }
  });
  child.stderr.on('data', chunk => { assert.ok(chunk.length < 4096); stderr.push(chunk.toString()); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { frames, stderr, exited,
    send: value => child.stdin.write(JSON.stringify(value) + '\n'),
    async response(id) { await until(() => frames.some(frame => frame.id === id)); return frames.find(frame => frame.id === id); } };
}

test('real source-mcp CLI stdio initializes, lists exactly six contracts, calls roots and naturally closes', async t => {
  const child = spawn(process.execPath, ['source-mcp.mjs'], { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = childClient(child);
  t.after(async () => { child.stdin.end(); await client.exited; });
  client.send(init(1)); assert.equal((await client.response(1)).result.protocolVersion, '2025-06-18');
  client.send(notify('notifications/initialized'));
  client.send(request(2, 'tools/list'));
  assert.deepEqual((await client.response(2)).result.tools, SOURCE_TOOLS);
  client.send(tool(3, rootTool));
  const roots = JSON.parse((await client.response(3)).result.content[0].text);
  assert.equal(roots.ok, true); assert.equal(roots.value.roots.length, 7);
  assert.equal(roots.value.availabilityChecked, false);
  child.stdin.end(); assert.deepEqual(await client.exited, { code: 0, signal: null });
  assert.deepEqual(client.stderr, []);
});

test('real child stdio with trusted fixture service reads and searches files through production owners without Codex', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-mcp-'));
  await fs.writeFile(path.join(base, 'Example.cs'), 'class Needle {}\n// needle marker\n');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const imports = name => pathToFileURL(path.join(projectRoot, 'lib', name)).href;
  const script = `import fs from 'node:fs/promises';
import {createSourcePolicy} from ${JSON.stringify(imports('source-policy.mjs'))};
import {createSourceTools} from ${JSON.stringify(imports('source-tools.mjs'))};
import {createSourceMcpServer} from ${JSON.stringify(imports('source-mcp-server.mjs'))};
const policy=createSourcePolicy({roots:[{id:'test-source',path:${JSON.stringify(base)}}]}).value;
const native=()=>({ok:true,value:{start:async()=>({ok:true,value:undefined}),readFile:async(file,budget)=>({ok:true,value:{dataBase64:(await fs.readFile(file)).toString('base64')}}),close:async()=>({ok:true,value:{closed:true}})}});
const service=createSourceTools({policy,createNativeClient:native}).value;
const server=createSourceMcpServer({input:process.stdin,output:process.stdout,service}).value;
server.start(); const closed=await server.finished;if(!closed.ok)process.exitCode=1;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = childClient(child); t.after(async () => { child.stdin.end(); await client.exited; });
  client.send(init(1)); await client.response(1); client.send(notify('notifications/initialized'));
  client.send(tool(2, rootTool)); assert.equal(JSON.parse((await client.response(2)).result.content[0].text).value.roots[0].id, 'test-source');
  client.send(tool(3, readTool, { rootId: 'test-source', path: 'Example.cs' }));
  const read = JSON.parse((await client.response(3)).result.content[0].text);
  assert.equal(read.ok, true); assert.deepEqual(read.value.lines.map(line => line.text), ['class Needle {}', '// needle marker']);
  client.send(tool(4, searchTool, { rootId: 'test-source', path: '', query: 'needle' }));
  const found = JSON.parse((await client.response(4)).result.content[0].text);
  assert.equal(found.ok, true); assert.equal(JSON.stringify(found).includes('needle marker'), true);
  client.send(tool(5, readTool, { rootId: 'test-source', path: '../outside.cs' }));
  assert.equal((await client.response(5)).result.isError, true);
  client.send(tool(6, rootTool, { unexpected: true }));
  assert.equal(JSON.parse((await client.response(6)).result.content[0].text).error.code, 'INVALID_SOURCE_TOOL_ARGUMENTS');
  child.stdin.end(); assert.deepEqual(await client.exited, { code: 0, signal: null }); assert.deepEqual(client.stderr, []);
});

test('advertised schemas from real tools/list validate under installed Ajv2020 and reject extra or invalid actual arguments', async t => {
  const ajvPath = 'C:/Users/LENOVO/AppData/Roaming/npm/node_modules/@google/gemini-cli/node_modules/ajv/dist/2020.js';
  let Ajv2020;
  try { const loaded = createRequire(import.meta.url)(ajvPath); Ajv2020 = loaded.default ?? loaded; }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') { t.skip('Optional preinstalled Ajv2020 is unavailable.'); return; } throw error; }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const f = fixture(t); await f.initialized(); f.send(request('schema-list', 'tools/list'));
  const listed = (await f.response('schema-list')).result.tools;
  const validArguments = new Map([
    [rootTool, {}], ['buildx_source_scan_directory', { rootId: 'test-source', path: '', maxEntries: 3 }],
    ['buildx_source_directory_page', { snapshotId: '1f62a514-e667-4b22-a15a-149c35cdf37a', offset: 0, limit: 2 }],
    ['buildx_source_release_directory', { snapshotId: '1f62a514-e667-4b22-a15a-149c35cdf37a' }],
    [readTool, { rootId: 'test-source', path: 'Example.cs', maxReadBytes: 10 }],
    [searchTool, { rootId: 'test-source', path: '', query: 'needle' }],
  ]);
  for (const descriptor of listed) {
    assert.equal(descriptor.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(ajv.validateSchema(descriptor.inputSchema), true, JSON.stringify(ajv.errors));
    const validate = ajv.compile(descriptor.inputSchema), args = validArguments.get(descriptor.name);
    assert.equal(validate(args), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...args, unexpected: true }), false);
  }
});
