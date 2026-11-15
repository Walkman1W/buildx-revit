import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSourcePolicy } from '../lib/source-policy.mjs';
import { createSourceContentReader, SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_LINES } from '../lib/source-content.mjs';
import { createSourceDirectoryBrowser } from '../lib/source-directory.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const result = bytes => ({ ok: true, value: { dataBase64: Buffer.from(bytes).toString('base64') } });
const request = extra => ({ rootId: 'sample-source', path: 'Example.cs', ...extra });
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-content-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.match(path.basename(base), /^buildx-source-content-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  const configured = createSourcePolicy({ roots: [{ id: 'sample-source', path: root }], ...options });
  assert.equal(configured.ok, true);
  const calls = [];
  const readFile = async (absolutePath, budget) => {
    calls.push({ absolutePath, ...budget });
    return result(await fs.readFile(absolutePath));
  };
  const reader = createSourceContentReader({ policy: configured.value, readFile });
  assert.equal(reader.ok, true);
  return { base, root, calls, policy: configured.value, readFile, reader: reader.value,
    write: bytes => fs.writeFile(path.join(root, 'Example.cs'), bytes),
    custom: callback => {
      const made = createSourceContentReader({ policy: configured.value, readFile: callback });
      assert.equal(made.ok, true); return made.value;
    } };
}
function failedWithoutSource(value, code, source = 'DO_NOT_LEAK') {
  assert.equal(value.ok, false);
  assert.equal(value.error.code, code);
  assert.equal(JSON.stringify(value).includes(source), false);
  assert.equal('value' in value, false);
}

test('reader configuration requires named trusted callbacks and the policy byte cap', async t => {
  const f = await fixture(t);
  for (const options of [undefined, null, [], 1, {}, { policy: f.policy }, { policy: f.policy, readFile: 1 },
    { policy: f.policy, readFile: f.readFile, command: true },
    { policy: { ...f.policy, maxFileBytes: 524289 }, readFile: f.readFile }])
    assert.equal(createSourceContentReader(options).error.code, 'INVALID_SOURCE_CONTENT_READER');
  assert.equal(Object.isFrozen(f.reader), true);
  assert.equal(SOURCE_PAGE_MAX_BYTES, 32768);
  assert.equal(SOURCE_PAGE_MAX_LINES, 200);
});

test('real file bytes produce a bounded page with provenance and no absolute path or metadata token', async t => {
  const f = await fixture(t); const text = 'class Sample {}\n// 中文 😀\n'; await f.write(text);
  const response = await f.reader.read(request());
  assert.equal(response.ok, true);
  assert.deepEqual(response.value.lines, [{ lineNumber: 1, text: 'class Sample {}' }, { lineNumber: 2, text: '// 中文 😀' }]);
  assert.equal(response.value.rootId, 'sample-source'); assert.equal(response.value.path, 'Example.cs');
  assert.equal(response.value.byteLength, Buffer.byteLength(text)); assert.equal(response.value.sha256, sha(text));
  assert.equal(response.value.totalLines, 2); assert.equal(response.value.startLine, 1); assert.equal(response.value.endLine, 2);
  assert.equal(response.value.nextLine, null); assert.equal(response.value.completeness, 'complete');
  assert.equal(response.value.wholeFileReturned, true); assert.deepEqual(response.value.truncationReasons, []);
  assert.equal(JSON.stringify(response).includes(f.root.replaceAll('\\', '\\\\')), false);
  for (const key of ['absolutePath', 'rootIdentity', 'ino', 'mtimeNs']) assert.equal(key in response.value, false);
  assert.deepEqual(f.calls, [{ absolutePath: path.join(f.root, 'Example.cs'), maxBytes: Buffer.byteLength(text) }]);
});

test('line pagination is bound to SHA256 and never pretends a tail page contains the whole file', async t => {
  const f = await fixture(t); await f.write('one\ntwo\nthree\nfour');
  const first = await f.reader.read(request({ maxLines: 2 }));
  assert.equal(first.value.nextLine, 3); assert.equal(first.value.completeness, 'partial');
  assert.equal(first.value.wholeFileReturned, false); assert.deepEqual(first.value.truncationReasons, ['max_lines']);
  const last = await f.reader.read(request({ startLine: first.value.nextLine, expectedSha256: first.value.sha256.toUpperCase() }));
  assert.equal(last.ok, true); assert.equal(last.value.sha256, first.value.sha256);
  assert.deepEqual(last.value.lines.map(line => line.text), ['three', 'four']);
  assert.equal(last.value.completeness, 'complete'); assert.equal(last.value.wholeFileReturned, false);
  assert.equal(last.value.nextLine, null); assert.equal(last.value.startLine, 3); assert.equal(last.value.endLine, 4);
  const eof = await f.reader.read(request({ startLine: 5, expectedSha256: first.value.sha256 }));
  assert.deepEqual(eof.value.lines, []); assert.equal(eof.value.endLine, null); assert.equal(eof.value.completeness, 'complete');
  failedWithoutSource(await f.reader.read(request({ startLine: 6, expectedSha256: first.value.sha256 })), 'SOURCE_LINE_OUT_OF_RANGE');
});

test('empty file, EOF, terminal separator, CRLF, lone CR and BOM have explicit logical line semantics', async t => {
  const f = await fixture(t);
  const cases = [['', []], ['\n', ['']], ['\r\n', ['']], ['\n\n', ['', '']], ['a\n', ['a']],
    ['a\r\nb\rc\n\n', ['a', 'b', 'c', '']], ['a\r\r', ['a', '']], ['a', ['a']], ['\uFEFF', []],
    ['\uFEFFa\r\nb\uFEFFc\r', ['a', 'b\uFEFFc']]];
  for (const [text, expected] of cases) {
    await f.write(text); const response = await f.reader.read(request());
    assert.equal(response.ok, true, JSON.stringify(text)); assert.equal(response.value.totalLines, expected.length);
    assert.deepEqual(response.value.lines.map(line => line.text), expected);
    assert.equal(response.value.hasUtf8Bom, text.startsWith('\uFEFF'));
    assert.equal(response.value.sha256, sha(text)); assert.equal(response.value.byteLength, Buffer.byteLength(text));
    assert.equal(response.value.endLine, expected.length || null); assert.equal(response.value.wholeFileReturned, true);
  }
});

test('unknown fields, malformed pagination and missing continuation hash are refused before native reads', async t => {
  const f = await fixture(t); await f.write('one\ntwo');
  for (const invalid of [null, [], 1, {}, request({ execute: true }), request({ path: 1 }), request({ rootId: 1 })])
    failedWithoutSource(await f.reader.read(invalid), 'INVALID_SOURCE_REQUEST');
  for (const startLine of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])
    failedWithoutSource(await f.reader.read(request({ startLine })), 'INVALID_SOURCE_PAGE');
  for (const maxLines of [0, -1, 201, 1.5, '80', null])
    failedWithoutSource(await f.reader.read(request({ maxLines })), 'INVALID_SOURCE_PAGE');
  for (const expectedSha256 of ['', '0'.repeat(63), 'G'.repeat(64), '0'.repeat(65), null, 1, {}, ` ${'0'.repeat(64)}`])
    failedWithoutSource(await f.reader.read(request({ expectedSha256 })), 'INVALID_SOURCE_HASH');
  failedWithoutSource(await f.reader.read(request({ startLine: 2 })), 'SOURCE_PAGE_HASH_REQUIRED');
  const symbolExtra = request(); symbolExtra[Symbol('unknown')] = true;
  failedWithoutSource(await f.reader.read(symbolExtra), 'INVALID_SOURCE_REQUEST');
  assert.equal(f.calls.length, 0);
});

test('the production policy remains the only owner of paths, file scopes and pre-read metadata budgets', async t => {
  const f = await fixture(t, { maxFileBytes: 8 }); await f.write('123456789');
  failedWithoutSource(await f.reader.read(request()), 'SOURCE_FILE_TOO_LARGE');
  failedWithoutSource(await f.reader.read(request({ path: '' })), 'SOURCE_NOT_FILE');
  failedWithoutSource(await f.reader.read(request({ path: '../outside.cs' })), 'INVALID_SOURCE_PATH');
  failedWithoutSource(await f.reader.read(request({ rootId: 'outside' })), 'UNKNOWN_SOURCE_ROOT');
  await fs.writeFile(path.join(f.root, 'auth.json'), '{}');
  failedWithoutSource(await f.reader.read(request({ path: 'auth.json' })), 'EXCLUDED_SOURCE_FILE');
  failedWithoutSource(await f.reader.read(request({ path: 'queue/data.cs' })), 'EXCLUDED_SOURCE_PATH');
  assert.equal(f.calls.length, 0);
  await f.write('12345678'); assert.equal((await f.reader.read(request())).ok, true); assert.equal(f.calls[0].maxBytes, 8);
});

test('output budget counts Unicode and actual JSON escaping and preserves all lines through bound pages', async t => {
  const f = await fixture(t);
  const expected = Array.from({ length: 8 }, (_, index) => `${index}:` + '中😀"\\\t'.repeat(850));
  await f.write(expected.join('\n'));
  const gathered = []; let startLine = 1, expectedSha256;
  do {
    const page = await f.reader.read(request({ startLine, maxLines: 200, ...(expectedSha256 ? { expectedSha256 } : {}) }));
    assert.equal(page.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= SOURCE_PAGE_MAX_BYTES);
    assert.equal(page.value.totalLines, expected.length); assert.ok(page.value.lines.length > 0);
    gathered.push(...page.value.lines.map(line => line.text)); expectedSha256 = page.value.sha256;
    startLine = page.value.nextLine;
    if (startLine !== null) assert.deepEqual(page.value.truncationReasons, ['output_byte_budget']);
  } while (startLine !== null);
  assert.deepEqual(gathered, expected); assert.ok(f.calls.length > 1);
});

test('an oversized first logical line fails explicitly, without a partial source fragment or silent line drop', async t => {
  const f = await fixture(t); await f.write('DO_NOT_LEAK' + '"'.repeat(18000) + '\nsecond');
  failedWithoutSource(await f.reader.read(request()), 'SOURCE_LINE_TOO_LARGE');
  await f.write('first\n' + 'DO_NOT_LEAK' + '"'.repeat(18000) + '\nlast');
  const first = await f.reader.read(request()); assert.equal(first.ok, true); assert.equal(first.value.nextLine, 2);
  assert.deepEqual(first.value.lines, [{ lineNumber: 1, text: 'first' }]);
  failedWithoutSource(await f.reader.read(request({ startLine: 2, expectedSha256: first.value.sha256 })), 'SOURCE_LINE_TOO_LARGE');
});

test('invalid base64 shape, alphabet and unused padding bits cannot use the permissive Node decoder', async t => {
  const f = await fixture(t); await f.write('a');
  for (const dataBase64 of ['!!!!', 'YQ', 'YQ=\n', 'YR==', 'YQ＝=', 'YQ-=', 'YQ__']) {
    const response = await f.custom(async () => ({ ok: true, value: { dataBase64 } })).read(request());
    assert.equal(response.ok, false, dataBase64);
    assert.ok(['INVALID_SOURCE_BASE64', 'SOURCE_READ_SIZE_MISMATCH', 'SOURCE_NATIVE_PAYLOAD_TOO_LARGE'].includes(response.error.code));
  }
  await f.write('ab');
  failedWithoutSource(await f.custom(async () => ({ ok: true, value: { dataBase64: 'YWJ=' } })).read(request()), 'INVALID_SOURCE_BASE64');
});

test('encoded oversize and decoded size mismatches fail before any source page exists', async t => {
  const f = await fixture(t); await f.write('a');
  failedWithoutSource(await f.custom(async () => result('DO_NOT_LEAK'.repeat(80000))).read(request()), 'SOURCE_NATIVE_PAYLOAD_TOO_LARGE');
  failedWithoutSource(await f.custom(async () => result('ab')).read(request()), 'SOURCE_READ_SIZE_MISMATCH');
  await f.write('abcdef');
  failedWithoutSource(await f.custom(async () => result('abc')).read(request()), 'SOURCE_READ_SIZE_MISMATCH');
});

test('malformed native contracts are tagged failures, not accepted source or unhandled errors', async t => {
  const f = await fixture(t); await f.write('safe');
  for (const native of [null, [], {}, { ok: 'true' }, { ok: true }, { ok: true, value: null },
    { ok: true, value: { dataBase64: 1 } }, { ok: true, value: { dataBase64: 'c2FmZQ==', path: 'override' } }])
    failedWithoutSource(await f.custom(async () => native).read(request()), 'INVALID_SOURCE_NATIVE_RESPONSE');
});

test('strict UTF-8 rejects invalid continuation, surrogate and out-of-range codepoints', async t => {
  const f = await fixture(t);
  for (const bytes of [[195, 40], [237, 160, 128], [244, 144, 128, 128], [192, 175], [239, 187]]) {
    await f.write(Buffer.from(bytes));
    failedWithoutSource(await f.reader.read(request()), 'SOURCE_INVALID_UTF8');
  }
});

test('NUL bytes are refused as binary without exposing surrounding source', async t => {
  const f = await fixture(t); await f.write('DO_NOT_LEAK\0more');
  failedWithoutSource(await f.reader.read(request()), 'SOURCE_BINARY_CONTENT');
});

test('source hash is computed from original BOM and line-ending bytes rather than display-normalized text', async t => {
  const f = await fixture(t); await f.write('\uFEFFone\r\ntwo\r');
  const response = await f.reader.read(request());
  assert.equal(response.value.sha256, sha(Buffer.from('\uFEFFone\r\ntwo\r')));
  assert.notEqual(response.value.sha256, sha('one\ntwo'));
  assert.deepEqual(response.value.lines.map(line => line.text), ['one', 'two']);
});

test('continuation content changes return no source even when a new metadata snapshot would be valid', async t => {
  const f = await fixture(t); await f.write('first\nold');
  const first = await f.reader.read(request({ maxLines: 1 })); await f.write('DO_NOT_LEAK\nnew');
  failedWithoutSource(await f.reader.read(request({ startLine: 2, expectedSha256: first.value.sha256 })), 'SOURCE_CONTENT_CHANGED');
  assert.equal(f.calls.length, 2);
});

test('a mutation after native read fails private snapshot revalidation and returns no prior content', async t => {
  const f = await fixture(t); await f.write('DO_NOT_LEAK');
  let calls = 0;
  const reader = f.custom(async file => {
    calls++; const native = result(await fs.readFile(file)); await fs.writeFile(file, 'changed and longer'); return native;
  });
  failedWithoutSource(await reader.read(request()), 'SOURCE_IDENTITY_CHANGED'); assert.equal(calls, 1);
});

test('replacement of the root during the native request cannot expose the captured content', async t => {
  const f = await fixture(t); await f.write('DO_NOT_LEAK');
  const reader = f.custom(async file => {
    const native = result(await fs.readFile(file));
    await fs.rename(f.root, path.join(f.base, 'old-source')); await fs.mkdir(f.root); await f.write('DO_NOT_LEAK');
    return native;
  });
  failedWithoutSource(await reader.read(request()), 'SOURCE_ROOT_CHANGED');
});

test('native failures and throws preserve only bounded codes and never retry or echo arbitrary messages', async t => {
  const f = await fixture(t); await f.write('safe'); let calls = 0;
  const failures = [async () => ({ ok: false, error: { code: 'NATIVE_TIMEOUT', message: 'DO_NOT_LEAK' } }),
    async () => { const error = new Error('DO_NOT_LEAK'); error.code = 'PIPE_CLOSED'; throw error; },
    async () => ({ ok: false, error: { code: 'DO_NOT_LEAK'.repeat(1000), message: 'DO_NOT_LEAK' } })];
  for (const [index, callback] of failures.entries()) {
    const response = await f.custom(async (...args) => { calls++; return callback(...args); }).read(request());
    failedWithoutSource(response, 'SOURCE_NATIVE_READ_FAILED');
    assert.equal(response.error.nativeCode, index === 0 ? 'NATIVE_TIMEOUT' : index === 1 ? 'PIPE_CLOSED' : undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 300);
  }
  assert.equal(calls, 3);
});

test('the exact internally inspected snapshot is revalidated, with no client identity or alternate path accepted', async t => {
  const f = await fixture(t); await f.write('class Safe {}'); let inspected, revalidated;
  const policy = { ...f.policy, inspect: async input => {
    assert.deepEqual(Object.keys(input).sort(), ['path', 'rootId']);
    const response = await f.policy.inspect(input); inspected = response.value; return response;
  }, revalidate: async snapshot => { revalidated = snapshot; return f.policy.revalidate(snapshot); } };
  const made = createSourceContentReader({ policy, readFile: f.readFile });
  assert.equal((await made.value.read(request())).ok, true); assert.equal(revalidated, inspected);
  failedWithoutSource(await made.value.read(request({ metadata: inspected })), 'INVALID_SOURCE_REQUEST');
  failedWithoutSource(await made.value.read(request({ absolutePath: inspected.absolutePath })), 'INVALID_SOURCE_REQUEST');
});

test('real source files and their metadata remain unchanged across successive reads', async t => {
  const f = await fixture(t); const bytes = Buffer.from('class Stable {}\r\n'); await f.write(bytes);
  const file = path.join(f.root, 'Example.cs'); const before = await fs.stat(file, { bigint: true });
  for (let count = 0; count < 2; count++) assert.equal((await f.reader.read(request())).ok, true);
  const after = await fs.stat(file, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) assert.equal(after[key], before[key]);
  assert.deepEqual(await fs.readFile(file), bytes); assert.equal(f.calls.length, 2);
});

test('factory snapshots its policy, callbacks and budget once so a mutable wrapper cannot widen later reads', async t => {
  const f = await fixture(t); await f.write('123456789');
  const wrapper = { ...f.policy, maxFileBytes: 8 };
  const made = createSourceContentReader({ policy: wrapper, readFile: f.readFile });
  assert.equal(made.ok, true);
  wrapper.maxFileBytes = 512 * 1024;
  wrapper.inspect = () => { throw new Error('replaced method must not run'); };
  wrapper.revalidate = wrapper.inspect;
  failedWithoutSource(await made.value.read(request()), 'SOURCE_FILE_TOO_LARGE');
  assert.equal(f.calls.length, 0);
  await f.write('12345678');
  assert.equal((await made.value.read(request())).ok, true);
  assert.equal(f.calls.length, 1);

  const accesses = { policy: 0, readFile: 0, inspect: 0, revalidate: 0, maxFileBytes: 0 };
  const once = (key, value) => () => {
    accesses[key]++;
    assert.equal(accesses[key], 1, `${key} was read more than once`);
    return value;
  };
  const getters = {};
  Object.defineProperties(getters, {
    inspect: { get: once('inspect', f.policy.inspect), enumerable: true },
    revalidate: { get: once('revalidate', f.policy.revalidate), enumerable: true },
    maxFileBytes: { get: once('maxFileBytes', 8), enumerable: true },
  });
  const options = {};
  Object.defineProperties(options, {
    policy: { get: once('policy', getters), enumerable: true },
    readFile: { get: once('readFile', f.readFile), enumerable: true },
  });
  const captured = createSourceContentReader(options);
  assert.equal(captured.ok, true);
  assert.equal((await captured.value.read(request())).ok, true);
  assert.equal((await captured.value.read(request())).ok, true);
  assert.deepEqual(accesses, { policy: 1, readFile: 1, inspect: 1, revalidate: 1, maxFileBytes: 1 });
});

test('a file grown after directory capture is refused by its reserved byte budget before native reading', async t => {
  const f = await fixture(t); await f.write('small');
  const made = createSourceDirectoryBrowser({ policy: f.policy }); assert.equal(made.ok, true);
  const browser = made.value;
  t.after(() => browser.cleanup());
  const scanned = await browser.scan({ rootId: 'sample-source', path: '' }); assert.equal(scanned.ok, true);
  const entries = await browser.page({ snapshotId: scanned.value.snapshotId }); assert.equal(entries.ok, true);
  const captured = entries.value.entries.find(entry => entry.path === 'Example.cs');
  assert.equal(captured.byteLength, 5);
  await f.write('DO_NOT_LEAK: grown but still within the source policy budget');
  const current = await f.policy.inspect({ rootId: 'sample-source', path: 'Example.cs' });
  assert.equal(current.ok, true); assert.ok(current.value.byteLength > captured.byteLength);
  failedWithoutSource(await f.reader.read(request({ maxReadBytes: captured.byteLength })), 'SOURCE_READ_BUDGET_EXCEEDED');
  assert.equal(f.calls.length, 0);
  assert.equal((await browser.release({ snapshotId: scanned.value.snapshotId })).ok, true);
});

test('an explicit byte cap allows equal-size content and rejects smaller budgets before callbacks', async t => {
  const f = await fixture(t); await f.write('12345678');
  assert.equal((await f.reader.read(request({ maxReadBytes: 8 }))).ok, true);
  assert.equal((await f.reader.read(request({ maxReadBytes: 16 }))).ok, true);
  failedWithoutSource(await f.reader.read(request({ maxReadBytes: 7 })), 'SOURCE_READ_BUDGET_EXCEEDED');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.maxBytes), [8, 8]);
});

test('a zero-byte cap permits only an empty source file without changing the callback contract', async t => {
  const f = await fixture(t); await f.write('');
  const empty = await f.reader.read(request({ maxReadBytes: 0 }));
  assert.equal(empty.ok, true); assert.equal(empty.value.byteLength, 0); assert.deepEqual(empty.value.lines, []);
  assert.equal(f.calls[0].maxBytes, 0);
  await f.write('x');
  failedWithoutSource(await f.reader.read(request({ maxReadBytes: 0 })), 'SOURCE_READ_BUDGET_EXCEEDED');
  assert.equal(f.calls.length, 1);
});

test('byte cap parameters are captured once and invalid caps or aliases do not reach native reading', async t => {
  const f = await fixture(t); await f.write('12345678');
  for (const maxReadBytes of [-1, 524289, 1.5, '8', null, NaN, Infinity, {}, 8n, Number.MAX_SAFE_INTEGER + 1])
    failedWithoutSource(await f.reader.read(request({ maxReadBytes })), 'INVALID_SOURCE_READ_BUDGET');
  failedWithoutSource(await f.reader.read(request({ maxBytes: 8 })), 'INVALID_SOURCE_REQUEST');
  assert.equal(f.calls.length, 0);
  let accesses = 0;
  const selected = request();
  Object.defineProperty(selected, 'maxReadBytes', { enumerable: true, get() { accesses++; return accesses === 1 ? 7 : 524288; } });
  failedWithoutSource(await f.reader.read(selected), 'SOURCE_READ_BUDGET_EXCEEDED');
  assert.equal(accesses, 1); assert.equal(f.calls.length, 0);
});
