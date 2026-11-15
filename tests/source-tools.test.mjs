import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createSourcePolicy } from '../lib/source-policy.mjs';
import { createSourceTools, SOURCE_TOOLS } from '../lib/source-tools.mjs';

const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const ok = value => ({ ok: true, value });
const bad = () => ({ ok: false, error: { code: 'SOURCE_NATIVE_CLOSING', message: 'private-error-body' } });
const rootArgs = path => ({ rootId: 'test-source', path });
const N = Object.freeze({ roots: 'buildx_source_list_roots', scan: 'buildx_source_scan_directory',
  page: 'buildx_source_directory_page', release: 'buildx_source_release_directory',
  read: 'buildx_source_read_file', search: 'buildx_source_search' });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const digest = text => createHash('sha256').update(text).digest('hex');
const require = createRequire(import.meta.url);
const Ajv2020 = require('C:/Users/LENOVO/AppData/Roaming/npm/node_modules/@google/gemini-cli/node_modules/ajv/dist/2020.js').default;
const ajv = new Ajv2020({ strict: true });
const schemas = new Map(SOURCE_TOOLS.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));

function fakeNative(hooks = {}) {
  const calls = { factories: 0, starts: 0, reads: [], closes: 0, configs: [], clients: [] };
  const createNativeClient = async config => {
    calls.factories++; calls.configs.push({ ...config });
    if (hooks.factory) return hooks.factory(config, calls);
    const client = {
      async start() { calls.starts++; return hooks.start ? hooks.start(calls, client) : ok(undefined); },
      async readFile(file, options) {
        calls.reads.push({ file, ...options });
        return hooks.read ? hooks.read(file, options, calls, client) :
          ok({ dataBase64: (await fs.readFile(file)).toString('base64') });
      },
      async close() { calls.closes++; return hooks.close ? hooks.close(calls, client) : ok({ closed: true }); },
    };
    calls.clients.push(client);
    return ok(client);
  };
  return { calls, createNativeClient };
}

async function fixture(t, hooks = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-tools-'));
  const root = path.join(base, 'source'), outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const policy = take(createSourcePolicy({ roots: [{ id: 'test-source', path: root }] }));
  const fake = fakeNative(hooks), service = take(createSourceTools({ policy, createNativeClient: fake.createNativeClient }));
  t.after(async () => { await service.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, root, outside, policy, service, ...fake };
}

test('six exact named catalogs declare draft2020-12 flat contracts and immutable read-only hints', () => {
  assert.equal(SOURCE_TOOLS.length, 6);
  assert.deepEqual(new Set(SOURCE_TOOLS.map(tool => tool.name)), new Set(Object.values(N)));
  assert.equal(Object.isFrozen(SOURCE_TOOLS), true);
  for (const tool of SOURCE_TOOLS) {
    const schema = tool.inputSchema;
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
    assert.equal(Object.isFrozen(schema.properties), true);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    for (const value of Object.values(schema.properties)) assert.equal(['integer', 'string'].includes(value.type), true);
  }
  assert.equal(SOURCE_TOOLS.find(tool => tool.name === N.scan).inputSchema.properties.rootId.enum, undefined);
});

test('catalog and runtime reject the same structural bad values before native allocation', async t => {
  const f = await fixture(t);
  const cases = [
    [N.roots, { extra: true }], [N.scan, { rootId: 'test-source' }],
    [N.scan, { ...rootArgs(''), extra: 1 }], [N.scan, { ...rootArgs(''), maxEntries: 513 }],
    [N.scan, { ...rootArgs(''), maxEntries: 0 }], [N.scan, { rootId: 'UPPER', path: '' }],
    [N.page, { snapshotId: 'bad' }], [N.page, { snapshotId: '8bcd468d-39dc-4aaa-8aae-877d8be190b4', limit: 101 }],
    [N.page, { snapshotId: '8bcd468d-39dc-4aaa-8aae-877d8be190b4', offset: 0.5 }],
    [N.release, { snapshotId: '8bcd468d-39dc-4aaa-8aae-877d8be190b4', path: '' }],
    [N.read, { ...rootArgs('A.cs'), maxReadBytes: 524289 }],
    [N.read, { ...rootArgs('A.cs'), maxLines: 201 }],
    [N.read, { ...rootArgs('A.cs'), expectedSha256: 'bad' }],
    [N.read, { ...rootArgs('A.cs'), startLine: 0 }],
    [N.search, { ...rootArgs(''), query: '' }], [N.search, { ...rootArgs(''), query: 'a\nb' }],
    [N.search, { ...rootArgs(''), query: 'x', maxFiles: 17 }],
    [N.search, { ...rootArgs(''), query: 'x', maxPages: 33 }],
    [N.search, { ...rootArgs(''), query: 'x', maxReadBytes: 2097153 }],
    [N.search, { ...rootArgs(''), query: 'x', maxMatches: 51 }],
  ];
  for (const [name, args] of cases) {
    assert.equal(schemas.get(name)(args), false, name + JSON.stringify(args));
    assert.equal((await f.service.invoke(name, args)).error.code, 'INVALID_SOURCE_TOOL_ARGUMENTS');
  }
  assert.equal((await f.service.invoke('buildx_source_read_file_sorted_alias', rootArgs('A.cs'))).error.code, 'UNKNOWN_SOURCE_TOOL');
  assert.equal((await f.service.invoke(N.read, { ...rootArgs('A.cs'), [Symbol('extra')]: true })).error.code, 'INVALID_SOURCE_TOOL_ARGUMENTS');
  assert.equal(f.calls.factories, 0);
});

test('roots list returns configured IDs and declared policy without paths or an availability claim', async t => {
  const f = await fixture(t);
  const result = take(await f.service.invoke(N.roots, {}));
  assert.deepEqual(result.roots.map(root => root.id), ['test-source']);
  assert.equal(result.availabilityChecked, false); assert.equal(result.roots[0].availability, 'not_checked');
  assert.equal(JSON.stringify(result).includes(f.base), false);
  result.roots[0].id = 'changed'; result.roots[0].capabilityPolicy.content = 'write';
  assert.equal(take(await f.service.invoke(N.roots, {})).roots[0].id, 'test-source');
  assert.equal(f.calls.factories, 0);
});

test('scan, page and release map by exact name and retain only publicly issued snapshots', async t => {
  const f = await fixture(t);
  for (const name of ['A.cs', 'B.md', 'C.py']) await fs.writeFile(path.join(f.root, name), name);
  const scan = take(await f.service.invoke(N.scan, rootArgs('')));
  assert.equal(f.service.diagnostics().publicSnapshotCount, 1);
  const first = take(await f.service.invoke(N.page, { snapshotId: scan.snapshotId, limit: 1 }));
  const second = take(await f.service.invoke(N.page, { snapshotId: scan.snapshotId, offset: first.nextOffset, limit: 2 }));
  assert.equal(first.entries.length, 1); assert.equal(second.entries.length, 2);
  assert.equal(second.nextOffset, null);
  assert.equal(take(await f.service.invoke(N.release, { snapshotId: scan.snapshotId })).released, true);
  assert.equal(f.service.diagnostics().publicSnapshotCount, 0);
  assert.equal((await f.service.invoke(N.page, { snapshotId: scan.snapshotId })).error.code, 'SOURCE_TOOLS_SNAPSHOT_NOT_OWNED');
  assert.equal(f.calls.factories, 0);
});

test('read owner rejects unknown roots, paths, missing files, continuation without hash, and byte caps before native creation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const requests = [
    [{ rootId: 'unknown', path: 'A.cs' }, 'UNKNOWN_SOURCE_ROOT'],
    [rootArgs('../outside/X.cs'), 'INVALID_SOURCE_PATH'],
    [rootArgs('missing.cs'), 'SOURCE_NOT_FOUND'],
    [{ ...rootArgs('A.cs'), startLine: 2 }, 'SOURCE_PAGE_HASH_REQUIRED'],
    [{ ...rootArgs('A.cs'), maxReadBytes: 0 }, 'SOURCE_READ_BUDGET_EXCEEDED'],
  ];
  for (const [args, code] of requests) assert.equal((await f.service.invoke(N.read, args)).error.code, code);
  assert.equal(f.calls.factories, 0);
});

test('read pages retain SHA and each invocation lazily creates and finally closes its own native client', async t => {
  const f = await fixture(t), text = 'needle\none\ntwo';
  await fs.writeFile(path.join(f.root, 'A.cs'), text);
  const first = take(await f.service.invoke(N.read, { ...rootArgs('A.cs'), maxLines: 1 }));
  const last = take(await f.service.invoke(N.read, { ...rootArgs('A.cs'), startLine: first.nextLine,
    expectedSha256: first.sha256, maxLines: 200 }));
  assert.equal(first.sha256, digest(text)); assert.equal(last.sha256, first.sha256);
  assert.equal(first.completeness, 'partial'); assert.equal(last.completeness, 'complete');
  assert.equal(last.wholeFileReturned, false);
  assert.deepEqual([f.calls.factories, f.calls.starts, f.calls.reads.length, f.calls.closes], [2, 2, 2, 2]);
  assert.equal(f.calls.configs.every(config => path.isAbsolute(config.cwd) && config.executable === undefined), true);
  assert.equal(f.service.diagnostics().ownedNativeClient, false);
});

test('wrong SHA returns no source and still closes the owned native client', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'private-source-body');
  const result = await f.service.invoke(N.read, { ...rootArgs('A.cs'), expectedSha256: '0'.repeat(64) });
  assert.equal(result.error.code, 'SOURCE_CONTENT_CHANGED');
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  assert.equal(f.calls.closes, 1);
});

test('search combines production owners with real bytes, global page/read budgets and explicit partial coverage', async t => {
  const f = await fixture(t);
  const text = 'needle\n' + 'other\n'.repeat(449), length = Buffer.byteLength(text);
  await fs.writeFile(path.join(f.root, 'A.cs'), text);
  const result = take(await f.service.invoke(N.search, { ...rootArgs(''), query: 'needle', maxPages: 2 }));
  assert.equal(result.completeness, 'partial'); assert.equal(result.scope, 'single_directory_files');
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].sha256, digest(text));
  assert.equal(result.budgetUsage.contentPages, 2); assert.equal(result.budgetUsage.reservedReadBytes, length * 2);
  assert.equal(result.stopReasons.includes('content_page_budget'), true);
  assert.deepEqual([f.calls.factories, f.calls.reads.length, f.calls.closes], [1, 2, 1]);
  assert.equal(f.service.diagnostics().ownedSearch, false);
  assert.equal(f.service.diagnostics().publicSnapshotCount, 0);
});

test('search that cannot reserve a first file allocates no native client', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await f.service.invoke(N.search, { ...rootArgs(''), query: 'needle', maxReadBytes: 1 }));
  assert.equal(result.completeness, 'partial'); assert.equal(result.matches.length, 0);
  assert.equal(result.coverage.filesNotRead, 1); assert.equal(f.calls.factories, 0);
});

test('Unicode schema code-point bounds remain separate from the search owner UTF16 budget', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'a'.repeat(128) + '\n' + '😀'.repeat(64));
  for (const query of ['a'.repeat(128), '😀'.repeat(64)]) {
    const args = { ...rootArgs(''), query };
    assert.equal(schemas.get(N.search)(args), true);
    assert.equal(take(await f.service.invoke(N.search, args)).matches.length, 1);
  }
  const args = { ...rootArgs(''), query: '😀'.repeat(65) };
  assert.equal(schemas.get(N.search)(args), true);
  const count = f.calls.factories;
  assert.equal((await f.service.invoke(N.search, args)).error.code, 'INVALID_SOURCE_SEARCH_REQUEST');
  assert.equal(f.calls.factories, count);
  assert.match(SOURCE_TOOLS.find(tool => tool.name === N.search).inputSchema.properties.query.description, /UTF-16/);
});

test('factory options, policy methods and later caller argument mutation cannot expand captured scope', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  let policyGets = 0, factoryGets = 0, inspectGets = 0, revalidateGets = 0, rootsGets = 0, budgetGets = 0;
  const wrapper = { get inspect() { inspectGets++; return f.policy.inspect; },
    get revalidate() { revalidateGets++; return f.policy.revalidate; },
    get roots() { rootsGets++; return f.policy.roots; },
    get maxFileBytes() { budgetGets++; return f.policy.maxFileBytes; } };
  const options = { get policy() { policyGets++; return wrapper; },
    get createNativeClient() { factoryGets++; return f.createNativeClient; } };
  const service = take(createSourceTools(options));
  Object.defineProperty(wrapper, 'inspect', { value: () => { throw new Error('changed'); } });
  Object.defineProperty(options, 'createNativeClient', { value: () => { throw new Error('changed'); } });
  const args = rootArgs('A.cs'), running = service.invoke(N.read, args); args.path = '../outside/Private.cs';
  assert.equal(take(await running).lines[0].text, 'needle');
  assert.deepEqual([policyGets, factoryGets, inspectGets, revalidateGets, rootsGets, budgetGets], [1, 1, 1, 1, 1, 1]);
  take(await service.close());
  for (const value of [null, [], { extra: true }, { policy: {} }, { policy: f.policy, createNativeClient: 1 },
    { policy: f.policy, [Symbol('extra')]: true }, { get policy() { throw new Error('private'); } }])
    assert.equal(createSourceTools(value).error.code, 'INVALID_SOURCE_TOOLS');
});

test('busy holds through native final cleanup and repeated close remains idempotent', async t => {
  const startedClose = defer(), finishClose = defer();
  const f = await fixture(t, { close: async () => { startedClose.resolve(); await finishClose.promise; return ok({ closed: true }); } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const running = f.service.invoke(N.read, rootArgs('A.cs')); await startedClose.promise;
  assert.equal(f.service.diagnostics().busy, true);
  assert.equal((await f.service.invoke(N.roots, {})).error.code, 'SOURCE_TOOLS_BUSY');
  finishClose.resolve(); take(await running);
  assert.equal(f.calls.closes, 1);
  take(await f.service.close()); take(await f.service.close());
  assert.equal(f.calls.closes, 1);
  assert.equal((await f.service.invoke(N.roots, {})).error.code, 'SOURCE_TOOLS_CLOSED');
});

test('close during pending read closes the exact owned client before joining the active invocation', async t => {
  const enteredRead = defer(), pending = defer();
  const f = await fixture(t, { read: async () => { enteredRead.resolve(); return pending.promise; },
    close: async () => { pending.resolve(bad()); return ok({ closed: true }); } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const running = f.service.invoke(N.read, rootArgs('A.cs')); await enteredRead.promise;
  const [closed, result] = await Promise.all([f.service.close(), running]);
  assert.equal(take(closed).closed, true); assert.equal(result.error.code, 'SOURCE_TOOLS_CLOSING');
  assert.equal(f.calls.closes, 1); assert.equal(f.service.diagnostics().state, 'closed');
  assert.equal(JSON.stringify(result).includes('private-error-body'), false);
});

test('close during initialization settles the handshake without issuing a file read', async t => {
  const enteredStart = defer(), pending = defer();
  const f = await fixture(t, { start: async () => { enteredStart.resolve(); return pending.promise; },
    close: async () => { pending.resolve(bad()); return ok({ closed: true }); } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const running = f.service.invoke(N.read, rootArgs('A.cs')); await enteredStart.promise;
  const [closed, result] = await Promise.all([f.service.close(), running]);
  assert.equal(take(closed).closed, true); assert.equal(result.error.code, 'SOURCE_TOOLS_CLOSING');
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.closes, 1);
});

test('late factory completion after close is owned and cleaned without starting a client', async t => {
  const entered = defer(), made = defer(); let starts = 0, closes = 0;
  const f = await fixture(t, { factory: async () => { entered.resolve(); return made.promise; } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const running = f.service.invoke(N.read, rootArgs('A.cs')); await entered.promise;
  const closing = f.service.close();
  made.resolve(ok({ async start() { starts++; return ok(undefined); }, async readFile() { throw new Error('must not read'); },
    async close() { closes++; return ok({ closed: true }); } }));
  assert.equal(take(await closing).closed, true);
  assert.equal((await running).error.code, 'SOURCE_TOOLS_CLOSING');
  assert.deepEqual([starts, closes], [0, 1]);
});

test('a late successful read is not published as source after shutdown began', async t => {
  const enteredRead = defer(), pending = defer();
  const f = await fixture(t, { read: async () => { enteredRead.resolve(); return pending.promise; },
    close: async () => { pending.resolve(ok({ dataBase64: Buffer.from('private-source-body').toString('base64') })); return ok({ closed: true }); } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'private-source-body');
  const running = f.service.invoke(N.read, rootArgs('A.cs')); await enteredRead.promise;
  const closing = f.service.close();
  const result = await running;
  assert.equal(result.error.code, 'SOURCE_TOOLS_CLOSING');
  assert.equal(result.error.primaryOutcome.status, 'success');
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  take(await closing);
});

test('native cleanup failure preserves primary success, blocks new work, and retries only through explicit close', async t => {
  let failClose = true;
  const f = await fixture(t, { close: async () => failClose ? bad() : ok({ closed: true }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'private-source-body');
  const result = await f.service.invoke(N.read, rootArgs('A.cs'));
  assert.equal(result.error.code, 'SOURCE_TOOLS_CLEANUP_UNCONFIRMED');
  assert.equal(result.error.primaryOutcome.status, 'success');
  assert.equal(result.error.resources.ownedNativeClient, true);
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  assert.equal(f.calls.closes, 1);
  assert.equal((await f.service.invoke(N.roots, {})).error.code, 'SOURCE_TOOLS_CLEANUP_UNCONFIRMED');
  assert.equal(f.calls.closes, 1);
  failClose = false;
  take(await f.service.close());
  assert.equal(f.calls.closes, 2); assert.equal(f.service.diagnostics().ownedNativeClient, false);
});

test('mixed cleanup releases public snapshots even while native cleanup remains unconfirmed', async t => {
  let failClose = true;
  const f = await fixture(t, { close: async () => failClose ? bad() : ok({ closed: true }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  take(await f.service.invoke(N.scan, rootArgs('')));
  await f.service.invoke(N.read, rootArgs('A.cs'));
  const closed = await f.service.close();
  assert.equal(closed.error.code, 'SOURCE_TOOLS_CLEANUP_UNCONFIRMED');
  assert.equal(closed.error.resources.publicSnapshotCount, 0);
  assert.equal(closed.error.resources.ownedNativeClient, true);
  assert.equal(f.service.diagnostics().state, 'cleanup_pending');
  failClose = false; take(await f.service.close());
  assert.equal(f.service.diagnostics().state, 'closed');
});

test('startup or factory exceptions return fixed failures and retain any created cleanup owner', async t => {
  const f = await fixture(t, { start: async () => { throw new Error('private-handshake-body'); } });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = await f.service.invoke(N.read, rootArgs('A.cs'));
  assert.equal(result.error.code, 'SOURCE_NATIVE_READ_FAILED');
  assert.equal(result.error.nativeCode, 'SOURCE_TOOLS_NATIVE_START_FAILED');
  assert.equal(JSON.stringify(result).includes('private-handshake-body'), false);
  assert.equal(f.calls.closes, 1);
  const throwing = take(createSourceTools({ policy: f.policy, createNativeClient: () => { throw new Error('private-factory-body'); } }));
  const failed = await throwing.invoke(N.read, rootArgs('A.cs'));
  assert.equal(failed.error.code, 'SOURCE_NATIVE_READ_FAILED');
  assert.equal(JSON.stringify(failed).includes('private-factory-body'), false);
  take(await throwing.close());
});

test('client methods are captured once before handshake and invalid clients retain usable close ownership', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  let starts = 0, reads = 0, closes = 0;
  const client = { get start() { starts++; return async () => ok(undefined); },
    get readFile() { reads++; return async file => ok({ dataBase64: (await fs.readFile(file)).toString('base64') }); },
    get close() { closes++; return async () => ok({ closed: true }); } };
  const service = take(createSourceTools({ policy: f.policy, createNativeClient: () => ok(client) }));
  take(await service.invoke(N.read, rootArgs('A.cs')));
  assert.deepEqual([starts, reads, closes], [1, 1, 1]); take(await service.close());
  let invalidClosed = 0;
  const invalid = take(createSourceTools({ policy: f.policy, createNativeClient: () => ok({
    async close() { invalidClosed++; return ok({ closed: true }); } }) }));
  const result = await invalid.invoke(N.read, rootArgs('A.cs'));
  assert.equal(result.error.nativeCode, 'SOURCE_TOOLS_INVALID_NATIVE_CLIENT');
  assert.equal(invalidClosed, 1); take(await invalid.close());
});

test('native factory Result getters are captured once so a mutable wrapper cannot select a different client', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  let okGets = 0, valueGets = 0, starts = 0, closes = 0;
  const first = { async start() { starts++; return ok(undefined); },
    async readFile(file) { return ok({ dataBase64: (await fs.readFile(file)).toString('base64') }); },
    async close() { closes++; return ok({ closed: true }); } };
  const second = { async start() { throw new Error('wrong client'); },
    async readFile() { throw new Error('wrong client'); }, async close() { throw new Error('wrong client'); } };
  const service = take(createSourceTools({ policy: f.policy, createNativeClient: () => ({
    get ok() { okGets++; return true; }, get value() { valueGets++; return valueGets === 1 ? first : second; },
  }) }));
  assert.equal(take(await service.invoke(N.read, rootArgs('A.cs'))).lines[0].text, 'needle');
  assert.deepEqual([okGets, valueGets, starts, closes], [1, 1, 1, 1]);
  take(await service.close());
});

test('all domain results and diagnostics remain bounded and do not reveal filesystem or account locations', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  for (const [name, args] of [[N.roots, {}], [N.scan, rootArgs('')],
    [N.read, rootArgs('A.cs')], [N.search, { ...rootArgs(''), query: 'needle' }]]) {
    const result = await f.service.invoke(name, args);
    take(result); assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 32768, true);
    assert.equal(JSON.stringify(result).includes(f.base), false);
  }
  assert.equal(JSON.stringify(f.service.diagnostics()).includes(f.base), false);
  take(await f.service.close());
  assert.equal(f.service.diagnostics().publicSnapshotCount, 0);
});
