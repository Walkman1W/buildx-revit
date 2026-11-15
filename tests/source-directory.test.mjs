import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSourcePolicy } from '../lib/source-policy.mjs';
import { createSourceDirectoryBrowser, SOURCE_DIRECTORY_RETAINED_MAX_BYTES,
  SOURCE_DIRECTORY_PAGE_MAX_BYTES } from '../lib/source-directory.mjs';

const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const list = (browser, maxEntries = 128) => browser.scan({ rootId: 'test-source', path: '', maxEntries });
const page = (browser, snapshotId, options = {}) => browser.page({ snapshotId, ...options });

async function fixture(t, { policyOptions = {}, browserOptions = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-directory-'));
  const root = path.join(base, 'source'), outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const policy = take(createSourcePolicy({ roots: [{ id: 'test-source', path: root }], ...policyOptions }));
  const browser = take(createSourceDirectoryBrowser({ policy,
    ...(browserOptions.openDirectory === undefined ? {} : { openDirectory: browserOptions.openDirectory }) }));
  t.after(async () => { await browser.cleanup(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, root, outside, policy, browser };
}

function opener(hooks = {}) {
  const calls = { opens: 0, reads: 0, closes: 0, wrappers: [], options: [] };
  const openDirectory = async (selected, options) => {
    calls.opens++; calls.options.push({ ...options });
    const dir = await fs.opendir(selected, options);
    const owned = { async read() {
      calls.reads++;
      if (hooks.beforeRead) await hooks.beforeRead(calls, dir);
      const entry = await dir.read();
      if (hooks.afterRead) await hooks.afterRead(entry, calls, dir);
      return entry;
    }, async close() {
      calls.closes++;
      if (hooks.beforeClose) await hooks.beforeClose(calls, dir, owned);
      await dir.close();
    } };
    calls.wrappers.push(owned);
    return owned;
  };
  return { openDirectory, calls };
}

test('factory captures policy methods, byte budget and opener once and rejects invalid configuration', async t => {
  const f = await fixture(t); let inspectGets = 0, revalidateGets = 0, budgetGets = 0, openerGets = 0;
  const wrappedPolicy = {
    get inspect() { inspectGets++; return f.policy.inspect; },
    get revalidate() { revalidateGets++; return f.policy.revalidate; },
    get maxFileBytes() { budgetGets++; return f.policy.maxFileBytes; },
  };
  const tracing = opener();
  const options = { policy: wrappedPolicy, get openDirectory() { openerGets++; return tracing.openDirectory; } };
  const browser = take(createSourceDirectoryBrowser(options));
  Object.defineProperty(wrappedPolicy, 'inspect', { value: () => { throw new Error('expanded'); } });
  Object.defineProperty(options, 'openDirectory', { value: () => { throw new Error('changed'); } });
  take(await list(browser));
  assert.deepEqual([inspectGets, revalidateGets, budgetGets, openerGets], [1, 1, 1, 1]);
  assert.deepEqual(tracing.calls.options, [{ bufferSize: 1 }]);
  assert.equal(tracing.calls.closes, 1);
  for (const selected of [null, [], 1, {}, { policy: f.policy, extra: true },
    { policy: { ...f.policy, inspect: 1 } }, { policy: { ...f.policy, revalidate: null } },
    { policy: { ...f.policy, maxFileBytes: 524289 } }, { policy: f.policy, openDirectory: 1 },
    { policy: f.policy, [Symbol('extra')]: true }])
    assert.equal(createSourceDirectoryBrowser(selected).error.code, 'INVALID_SOURCE_DIRECTORY_BROWSER');
});

test('request validation and source policy reject traversal, unknown roots and files before opening', async t => {
  const tracing = opener(); const f = await fixture(t, { browserOptions: tracing });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'a');
  for (const selected of [null, [], {}, { rootId: 'test-source', path: '', maxEntries: 0 },
    { rootId: 'test-source', path: '', maxEntries: 513 }, { rootId: 'test-source', path: '', maxEntries: 2.5 },
    { rootId: 'test-source', path: '', extra: true }, { rootId: 'test-source', path: '', [Symbol('x')]: 1 }])
    assert.equal((await f.browser.scan(selected)).error.code, 'INVALID_SOURCE_DIRECTORY_REQUEST');
  assert.equal((await f.browser.scan({ rootId: 'test-source', path: '../outside' })).error.code, 'INVALID_SOURCE_PATH');
  assert.equal((await f.browser.scan({ rootId: 'unknown', path: '' })).error.code, 'UNKNOWN_SOURCE_ROOT');
  assert.equal((await f.browser.scan({ rootId: 'test-source', path: 'A.cs' })).error.code, 'SOURCE_NOT_DIRECTORY');
  assert.equal(tracing.calls.opens, 0);
  for (const selected of [{ snapshotId: 'x' }, { snapshotId: 'a'.repeat(36), offset: -1 },
    { snapshotId: 'f6212114-3034-4c11-9ad2-1131777de682', limit: 101 },
    { snapshotId: 'f6212114-3034-4c11-9ad2-1131777de682', extra: true }])
    assert.equal((await f.browser.page(selected)).error.code, 'INVALID_SOURCE_DIRECTORY_PAGE');
  assert.equal((await f.browser.release({ snapshotId: 'x' })).error.code, 'INVALID_SOURCE_DIRECTORY_RELEASE');
});

test('ordinary source metadata is captured once and read back in nonoverlapping pages without absolute paths', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested'));
  await fs.writeFile(path.join(f.root, 'Alpha.cs'), 'class A {}');
  await fs.writeFile(path.join(f.root, 'Beta.md'), 'hello');
  const scanned = take(await list(f.browser));
  assert.match(scanned.snapshotId, /^[a-f0-9-]{36}$/);
  assert.match(scanned.metadataSha256, /^[a-f0-9]{64}$/);
  assert.equal(scanned.entries, undefined);
  assert.equal(scanned.contentsRead, false);
  assert.equal(scanned.retainedEntryCount, 3);
  assert.equal(scanned.coverage.complete, true);
  assert.equal(scanned.coverage.rawDirectoryReads, 4);
  const first = take(await page(f.browser, scanned.snapshotId, { limit: 2 }));
  const second = take(await page(f.browser, scanned.snapshotId, { offset: first.nextOffset, limit: 2 }));
  assert.equal(first.nextOffset, 2); assert.equal(second.nextOffset, null);
  const all = [...first.entries, ...second.entries];
  assert.deepEqual(all.map(entry => entry.path).sort(), ['Alpha.cs', 'Beta.md', 'nested']);
  assert.equal(new Set(all.map(entry => entry.path)).size, 3);
  assert.equal(all.every(entry => entry.rootId === 'test-source' && entry.sha256 === null), true);
  assert.deepEqual(Object.keys(all[0]).sort(), ['byteLength', 'kind', 'path', 'rootId', 'sha256']);
  assert.equal(all.find(entry => entry.kind === 'directory').byteLength, null);
  assert.equal(first.collectedAt, second.collectedAt);
  assert.equal(first.metadataSha256, second.metadataSha256);
  assert.equal(JSON.stringify(first).includes(f.base), false);
  first.entries[0].path = 'tampered'; first.coverage.truncationReasons.push('tampered');
  const again = take(await page(f.browser, scanned.snapshotId));
  assert.equal(again.entries.some(entry => entry.path === 'tampered'), false);
  assert.equal(again.coverage.truncationReasons.includes('tampered'), false);
  assert.equal((await page(f.browser, scanned.snapshotId, { offset: 4 })).error.code, 'SOURCE_DIRECTORY_OFFSET_OUT_OF_RANGE');
  assert.equal(take(await page(f.browser, scanned.snapshotId, { offset: 3 })).entries.length, 0);
});

test('empty directories and exactly exhausted budgets distinguish observed EOF from a fetched sentinel', async t => {
  const f = await fixture(t);
  const empty = take(await list(f.browser, 1));
  assert.equal(empty.coverage.rawDirectoryReads, 1);
  assert.equal(empty.coverage.endOfDirectoryObserved, true);
  assert.equal(take(await page(f.browser, empty.snapshotId)).wholeSnapshotReturned, true);
  take(await f.browser.release({ snapshotId: empty.snapshotId }));
  await fs.writeFile(path.join(f.root, 'Only.cs'), 'one');
  const exact = take(await list(f.browser, 1));
  assert.equal(exact.coverage.rawDirectoryReads, 2);
  assert.equal(exact.coverage.rawEntriesFetched, 1);
  assert.equal(exact.coverage.policyInspected, 1);
  assert.equal(exact.coverage.unexaminedFetchedEntries, 0);
  assert.equal(exact.coverage.complete, true);
});

test('excluded entries consume the raw scan budget and an extra fetched entry is never policy-inspected', async t => {
  const tracing = opener(); const f = await fixture(t, { browserOptions: tracing });
  await fs.writeFile(path.join(f.root, '.hidden.cs'), 'hidden');
  await fs.writeFile(path.join(f.root, 'config.json'), '{}');
  await fs.writeFile(path.join(f.root, 'A.cs'), 'a');
  const result = take(await list(f.browser, 2));
  assert.equal(result.coverage.rawDirectoryReads, 3);
  assert.equal(result.coverage.rawEntriesFetched, 3);
  assert.equal(result.coverage.policyInspected, 2);
  assert.equal(result.coverage.unexaminedFetchedEntries, 1);
  assert.equal(result.retainedEntryCount + result.coverage.excludedEntryCount, 2);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.truncationReasons, ['entry_scan_budget']);
  assert.equal(tracing.calls.closes, 1);
  const returned = take(await page(f.browser, result.snapshotId));
  assert.equal(returned.entries.some(entry => entry.path.startsWith('.') || entry.path === 'config.json'), false);
  assert.equal(JSON.stringify(returned).includes('.hidden.cs'), false);
});

test('production policy owns extension, generated path, hardlink and oversize exclusions without leaking names', async t => {
  const f = await fixture(t, { policyOptions: { maxFileBytes: 16 } });
  await fs.writeFile(path.join(f.root, 'Original.cs'), 'small');
  await fs.link(path.join(f.root, 'Original.cs'), path.join(f.root, 'Linked.cs'));
  await fs.writeFile(path.join(f.root, 'Large.cs'), 'x'.repeat(17));
  await fs.writeFile(path.join(f.root, 'Image.png'), 'image');
  await fs.mkdir(path.join(f.root, 'runtime'));
  await fs.writeFile(path.join(f.root, 'Good.cs'), 'yes');
  const scanned = take(await list(f.browser));
  assert.equal(scanned.coverage.complete, true);
  assert.equal(scanned.coverage.excludedEntryCount, 5);
  assert.deepEqual(scanned.coverage.exclusionCounts,
    { SOURCE_LINK_REJECTED: 2, SOURCE_FILE_TOO_LARGE: 1, EXCLUDED_SOURCE_FILE: 1, EXCLUDED_SOURCE_PATH: 1 });
  const result = take(await page(f.browser, scanned.snapshotId));
  assert.deepEqual(result.entries.map(entry => entry.path), ['Good.cs']);
  for (const hidden of ['Linked.cs', 'Original.cs', 'Large.cs', 'Image.png', 'runtime'])
    assert.equal(JSON.stringify(result).includes(`"${hidden}"`), false, hidden);
});

test('real symlinks are excluded by the same policy or explicitly reported unavailable', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'Outside.cs'), 'outside');
  try { await fs.symlink(path.join(f.outside, 'Outside.cs'), path.join(f.root, 'Symlink.cs'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Real file symlink unavailable: ${error.code}`); return; }
    throw error;
  }
  const result = take(await list(f.browser));
  assert.equal(result.coverage.exclusionCounts.SOURCE_LINK_REJECTED, 1);
  assert.equal(result.retainedEntryCount, 0);
});

test('real junction or directory symlink is excluded without enumerating its target', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'Outside.cs'), 'outside');
  try { await fs.symlink(f.outside, path.join(f.root, 'LinkedDirectory'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Real directory link unavailable: ${error.code}`); return; }
    throw error;
  }
  const result = take(await list(f.browser));
  assert.equal(result.coverage.exclusionCounts.SOURCE_LINK_REJECTED, 1);
  assert.equal(result.retainedEntryCount, 0);
  assert.equal(result.coverage.rawDirectoryReads, 2);
});

test('a changed captured file invalidates its page and never returns earlier metadata again', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'before');
  const snapshot = take(await list(f.browser));
  take(await page(f.browser, snapshot.snapshotId));
  await fs.writeFile(path.join(f.root, 'A.cs'), 'a changed source');
  const failed = await page(f.browser, snapshot.snapshotId);
  assert.equal(failed.error.code, 'SOURCE_DIRECTORY_SNAPSHOT_INVALID');
  assert.equal(failed.error.cause, 'SOURCE_IDENTITY_CHANGED');
  assert.equal(failed.value, undefined);
  assert.equal((await page(f.browser, snapshot.snapshotId)).error.code, 'SOURCE_DIRECTORY_SNAPSHOT_INVALID');
  take(await f.browser.release({ snapshotId: snapshot.snapshotId }));
  assert.equal(f.browser.diagnostics().retainedBytes, 0);
});

test('pages revalidate returned rows rather than claiming unchanged directory metadata proves every captured file', async t => {
  const f = await fixture(t);
  for (const name of ['A.cs', 'B.cs', 'C.cs']) await fs.writeFile(path.join(f.root, name), 'before');
  const snapshot = take(await list(f.browser));
  const initially = take(await page(f.browser, snapshot.snapshotId));
  const last = initially.entries.at(-1);
  await fs.writeFile(path.join(f.root, last.path), 'a changed source');
  const first = take(await page(f.browser, snapshot.snapshotId, { limit: 1 }));
  assert.equal(first.entries.length, 1);
  assert.equal(first.collectedAt, snapshot.collectedAt);
  assert.equal(first.wholeSnapshotReturned, false);
  const changed = await page(f.browser, snapshot.snapshotId, { offset: 2, limit: 1 });
  assert.equal(changed.error.code, 'SOURCE_DIRECTORY_SNAPSHOT_INVALID');
  assert.equal(changed.value, undefined);
});

test('directory edits during scanning fail against the original trusted directory identity after closing', async t => {
  let root;
  const tracing = opener({ async afterRead(entry, calls) {
    if (entry !== null && calls.reads === 1) await fs.writeFile(path.join(root, 'Added.cs'), 'added');
  } });
  const f = await fixture(t, { browserOptions: tracing }); root = f.root;
  await fs.writeFile(path.join(f.root, 'A.cs'), 'original');
  const result = await list(f.browser);
  assert.equal(result.error.code, 'SOURCE_DIRECTORY_CHANGED');
  assert.equal(result.error.cause, 'SOURCE_IDENTITY_CHANGED');
  assert.equal(result.value, undefined);
  assert.equal(tracing.calls.closes, 1);
  assert.equal(f.browser.diagnostics().snapshotCount, 0);
});

test('root replacement between scan and page is rejected and does not bless the replacement metadata', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'first');
  const snapshot = take(await list(f.browser));
  await fs.rename(f.root, path.join(f.base, 'retired-root'));
  await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'A.cs'), 'replacement');
  const result = await page(f.browser, snapshot.snapshotId);
  assert.equal(result.error.code, 'SOURCE_DIRECTORY_SNAPSHOT_INVALID');
  assert.equal(result.error.cause, 'SOURCE_ROOT_CHANGED');
  assert.equal(result.value, undefined);
});

test('directory read failure closes its exact owned stream and publishes no snapshot or arbitrary IO text', async t => {
  const tracing = opener({ beforeRead() { throw new Error('private raw IO location must not escape'); } });
  const f = await fixture(t, { browserOptions: tracing });
  const result = await list(f.browser);
  assert.equal(result.error.code, 'SOURCE_DIRECTORY_READ_FAILED');
  assert.equal(JSON.stringify(result).includes('private raw IO location'), false);
  assert.equal(tracing.calls.closes, 1);
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, false);
  assert.equal(f.browser.diagnostics().snapshotCount, 0);
});

test('read plus cleanup failure retains the exact Dir, rejects new scans and retries close without reopening', async t => {
  let failures = 2; const handles = [];
  const tracing = opener({ beforeRead() { throw new Error('read failed'); }, beforeClose(calls, dir, wrapper) {
    handles.push(wrapper); if (failures-- > 0) throw new Error('close failed');
  } });
  const f = await fixture(t, { browserOptions: tracing });
  const result = await list(f.browser);
  assert.equal(result.error.code, 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED');
  assert.equal(result.error.cause, 'SOURCE_DIRECTORY_READ_FAILED');
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, true);
  assert.equal((await list(f.browser)).error.code, 'SOURCE_DIRECTORY_CLEANUP_PENDING');
  assert.equal((await f.browser.cleanup()).error.code, 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED');
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, true);
  assert.equal(take(await f.browser.cleanup()).closedDirectoryCount, 1);
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, false);
  assert.equal(tracing.calls.opens, 1);
  assert.equal(handles.length, 3);
  assert.equal(handles.every(handle => handle === handles[0]), true);
  assert.equal(take(await f.browser.cleanup()).closedDirectoryCount, 0);
});

test('release cannot discard a failed-close stream and frees only its named metadata snapshot', async t => {
  let failClose = false;
  const tracing = opener({ beforeClose() { if (failClose) throw new Error('close failed'); } });
  const f = await fixture(t, { browserOptions: tracing });
  const first = take(await list(f.browser)); failClose = true;
  assert.equal((await list(f.browser)).error.code, 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED');
  take(await f.browser.release({ snapshotId: first.snapshotId }));
  assert.equal(f.browser.diagnostics().snapshotCount, 0);
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, true);
  assert.equal((await list(f.browser)).error.code, 'SOURCE_DIRECTORY_CLEANUP_PENDING');
  failClose = false; take(await f.browser.cleanup());
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, false);
  assert.equal(tracing.calls.opens, 2);
});

test('scan owns busy through asynchronous read and final close so concurrent operations cannot interfere', async t => {
  let unblockRead, unblockClose;
  const readGate = new Promise(resolve => { unblockRead = resolve; });
  const closeGate = new Promise(resolve => { unblockClose = resolve; });
  const tracing = opener({ async beforeRead() { await readGate; }, async beforeClose() { await closeGate; } });
  const f = await fixture(t, { browserOptions: tracing });
  const pending = list(f.browser);
  while (tracing.calls.reads === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.browser.diagnostics().operation, 'scan');
  assert.equal((await list(f.browser)).error.code, 'SOURCE_DIRECTORY_BUSY');
  assert.equal((await f.browser.cleanup()).error.code, 'SOURCE_DIRECTORY_BUSY');
  assert.equal((await f.browser.release({ snapshotId: 'f6212114-3034-4c11-9ad2-1131777de682' })).error.code, 'SOURCE_DIRECTORY_BUSY');
  unblockRead();
  while (tracing.calls.closes === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await page(f.browser, 'f6212114-3034-4c11-9ad2-1131777de682')).error.code, 'SOURCE_DIRECTORY_BUSY');
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, true);
  unblockClose(); take(await pending);
  assert.equal(f.browser.diagnostics().busy, false);
  assert.equal(f.browser.diagnostics().retainedOwnedDirectory, false);
});

test('at most four snapshots are retained and release neither deletes files nor accepts client metadata', async t => {
  const tracing = opener(); const f = await fixture(t, { browserOptions: tracing });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'untouched');
  const issued = [];
  for (let index = 0; index < 4; index++) issued.push(take(await list(f.browser)));
  assert.equal(f.browser.diagnostics().snapshotCount, 4);
  assert.equal((await list(f.browser)).error.code, 'SOURCE_DIRECTORY_SNAPSHOT_CAPACITY');
  assert.equal(tracing.calls.opens, 4);
  assert.equal((await f.browser.release({ snapshotId: issued[0].snapshotId, metadata: {} })).error.code, 'INVALID_SOURCE_DIRECTORY_RELEASE');
  take(await f.browser.release({ snapshotId: issued[0].snapshotId }));
  assert.equal((await page(f.browser, issued[0].snapshotId)).error.code, 'SOURCE_DIRECTORY_SNAPSHOT_NOT_FOUND');
  assert.equal((await f.browser.release({ snapshotId: issued[0].snapshotId })).error.code, 'SOURCE_DIRECTORY_SNAPSHOT_NOT_FOUND');
  take(await list(f.browser));
  assert.equal(await fs.readFile(path.join(f.root, 'A.cs'), 'utf8'), 'untouched');
});

test('output byte budget is measured on the complete UTF-8 Result and continuation preserves every retained entry', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 100 }, (_, index) => `${'界'.repeat(82)}${String(index).padStart(3, '0')}.cs`);
  for (let index = 0; index < names.length; index += 20)
    await Promise.all(names.slice(index, index + 20).map(name => fs.writeFile(path.join(f.root, name), 'x')));
  const snapshot = take(await list(f.browser, 100));
  assert.equal(snapshot.coverage.complete, true);
  const result = await page(f.browser, snapshot.snapshotId, { limit: 100 });
  assert.equal(result.ok, true); assert.ok(bytes(result) <= SOURCE_DIRECTORY_PAGE_MAX_BYTES);
  assert.equal(result.value.pageTruncationReasons[0], 'output_byte_budget');
  assert.ok(result.value.entries.length > 0 && result.value.entries.length < 100);
  const rest = await page(f.browser, snapshot.snapshotId, { offset: result.value.nextOffset, limit: 100 });
  assert.equal(rest.ok, true); assert.ok(bytes(rest) <= SOURCE_DIRECTORY_PAGE_MAX_BYTES);
  assert.equal(rest.value.nextOffset, null);
  assert.deepEqual([...result.value.entries, ...rest.value.entries].map(entry => entry.path).sort(), names.sort());
});

test('retained budget counts private identities across snapshots and reports a bounded incomplete prefix', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 512 }, (_, index) => `${'s'.repeat(210)}${String(index).padStart(3, '0')}.cs`);
  for (let index = 0; index < names.length; index += 32)
    await Promise.all(names.slice(index, index + 32).map(name => fs.writeFile(path.join(f.root, name), 'x')));
  const first = take(await list(f.browser, 512));
  assert.equal(first.coverage.complete, true);
  const firstBytes = f.browser.diagnostics().retainedBytes;
  assert.ok(firstBytes > SOURCE_DIRECTORY_RETAINED_MAX_BYTES / 2);
  const second = take(await list(f.browser, 512));
  assert.equal(second.coverage.complete, false);
  assert.equal(second.coverage.metadataRetentionOmitted, 1);
  assert.equal(second.coverage.truncationReasons.includes('retained_byte_budget'), true);
  assert.ok(second.retainedEntryCount < 512);
  assert.ok(f.browser.diagnostics().retainedBytes <= SOURCE_DIRECTORY_RETAINED_MAX_BYTES);
  assert.ok(second.coverage.rawDirectoryReads <= 513);
  assert.ok(second.coverage.policyInspected <= 512);
  take(await f.browser.release({ snapshotId: first.snapshotId }));
  assert.ok(f.browser.diagnostics().retainedBytes < firstBytes);
});
