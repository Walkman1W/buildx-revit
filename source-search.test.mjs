import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSourcePolicy } from './lib/source-policy.mjs';
import { createSourceDirectoryBrowser } from './lib/source-directory.mjs';
import { createSourceContentReader } from './lib/source-content.mjs';
import { createSourceSearch, SOURCE_SEARCH_MAX_BYTES } from './lib/source-search.mjs';

const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const ask = (search, query = 'needle', extra = {}) => search.search({ rootId: 'test-source', path: '', query, ...extra });
const digest = text => createHash('sha256').update(text).digest('hex');
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

async function fixture(t, { readHook, wrapContent, wrapDirectory } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-search-'));
  const root = path.join(base, 'source'), outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const policy = take(createSourcePolicy({ roots: [{ id: 'test-source', path: root }] }));
  const directory = take(createSourceDirectoryBrowser({ policy }));
  const nativeCalls = [];
  const content = take(createSourceContentReader({ policy, readFile: async (file, options) => {
    nativeCalls.push({ file, ...options });
    if (readHook) await readHook(file, options, nativeCalls);
    return { ok: true, value: { dataBase64: (await fs.readFile(file)).toString('base64') } };
  } }));
  const shared = { base, root, outside, policy, directory, content, nativeCalls };
  const searchedDirectory = wrapDirectory ? wrapDirectory(directory, shared) : directory;
  const searchedContent = wrapContent ? wrapContent(content, shared) : content;
  const search = take(createSourceSearch({ directory: searchedDirectory, content: searchedContent }));
  t.after(async () => {
    await search.cleanup(); await directory.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { ...shared, search };
}

test('factory validates shape and captures dependency methods and option getters exactly once', async t => {
  const f = await fixture(t); let directoryGets = 0, contentGets = 0, scans = 0, pages = 0, releases = 0, reads = 0;
  const wrappedDirectory = {
    get scan() { scans++; return f.directory.scan; }, get page() { pages++; return f.directory.page; },
    get release() { releases++; return f.directory.release; },
  };
  const wrappedContent = { get read() { reads++; return f.content.read; } };
  const options = { get directory() { directoryGets++; return wrappedDirectory; },
    get content() { contentGets++; return wrappedContent; } };
  const search = take(createSourceSearch(options));
  Object.defineProperty(wrappedDirectory, 'scan', { value: () => { throw new Error('changed'); } });
  Object.defineProperty(wrappedContent, 'read', { value: () => { throw new Error('changed'); } });
  take(await ask(search));
  assert.deepEqual([directoryGets, contentGets, scans, pages, releases, reads], [1, 1, 1, 1, 1, 1]);
  for (const value of [null, [], {}, { directory: f.directory },
    { directory: f.directory, content: f.content, extra: true },
    { directory: { ...f.directory, page: null }, content: f.content },
    { directory: f.directory, content: { read: 1 } },
    { directory: f.directory, content: f.content, [Symbol('extra')]: true },
    { get directory() { throw new Error('sensitive'); }, content: f.content }])
    assert.equal(createSourceSearch(value).error.code, 'INVALID_SOURCE_SEARCH');
});

test('strict literal query and budgets reject unknown fields before a directory call', async t => {
  let scans = 0;
  const f = await fixture(t, { wrapDirectory: directory => ({ ...directory, scan: request => { scans++; return directory.scan(request); } }) });
  const valid = { rootId: 'test-source', path: '', query: 'x' };
  const invalid = [null, [], {}, { ...valid, extra: 1 }, { ...valid, [Symbol('x')]: true },
    ...['', 'x'.repeat(129), 'a\nb', 'a\rb', 'a\0b'].map(query => ({ ...valid, query })),
    ...[['maxEntries', 0], ['maxEntries', 513], ['maxFiles', 17], ['maxPages', 33],
      ['maxReadBytes', 2097153], ['maxMatches', 51], ['maxMatches', 0], ['maxFiles', 1.5]]
      .map(([key, value]) => ({ ...valid, [key]: value })),
    { ...valid, get maxFiles() { throw new Error('private'); } }];
  for (const value of invalid) assert.equal((await f.search.search(value)).error.code, 'INVALID_SOURCE_SEARCH_REQUEST');
  assert.equal(scans, 0);
  assert.equal((await ask(f.search, 'x', { rootId: 'unknown' })).error.cause, 'UNKNOWN_SOURCE_ROOT');
  assert.equal((await ask(f.search, 'x', { path: '../outside' })).error.cause, 'INVALID_SOURCE_PATH');
  assert.equal(f.nativeCalls.length, 0);
});

test('Chinese and regex-looking text are case-sensitive literals with first hit per line and UTF16 columns', async t => {
  const f = await fixture(t);
  const text = '😀墙体墙体\r\n墙体 .*\nNeedle\nneedle\n';
  await fs.writeFile(path.join(f.root, 'Example.cs'), text);
  const chinese = take(await ask(f.search, '墙体'));
  assert.deepEqual(chinese.matches.map(value => [value.lineNumber, value.columnUtf16]), [[1, 3], [2, 1]]);
  assert.equal(chinese.matches[0].sha256, digest(text));
  assert.equal(chinese.fileReports[0].status, 'complete');
  assert.equal(chinese.fileReports[0].linesScanned, 4);
  assert.equal(chinese.fileReports[0].nextLine, null);
  assert.equal(chinese.completeness, 'complete');
  assert.equal(chinese.scope, 'single_directory_files');
  assert.equal(take(await ask(f.search, '.*')).matches.length, 1);
  assert.deepEqual(take(await ask(f.search)).matches.map(value => value.lineNumber), [4]);
  assert.equal(JSON.stringify(chinese).includes(f.base), false);
});

test('empty directories and empty files can be complete without inventing lines or matches', async t => {
  const f = await fixture(t);
  assert.equal(take(await ask(f.search)).completeness, 'complete');
  await fs.writeFile(path.join(f.root, 'Empty.cs'), '');
  const result = take(await ask(f.search));
  assert.equal(result.completeness, 'complete');
  assert.equal(result.fileReports[0].totalLines, 0);
  assert.equal(result.fileReports[0].linesScanned, 0);
  assert.equal(result.budgetUsage.reservedReadBytes, 0);
  assert.equal(f.nativeCalls.length, 1);
});

test('same-file continuation binds SHA, reads contiguous lines, and charges every whole-file read', async t => {
  const calls = [];
  const f = await fixture(t, { wrapContent: content => ({ read(request) { calls.push({ ...request }); return content.read(request); } }) });
  const text = Array.from({ length: 450 }, (_, index) => index === 300 ? 'needle' : 'line').join('\n');
  const byteLength = Buffer.byteLength(text);
  await fs.writeFile(path.join(f.root, 'Many.cs'), text);
  const result = take(await ask(f.search));
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(calls.map(value => value.startLine), [1, 201, 401]);
  assert.equal(calls[0].expectedSha256, undefined);
  assert.deepEqual(calls.slice(1).map(value => value.expectedSha256), [digest(text), digest(text)]);
  assert.equal(calls.every(value => value.maxReadBytes === byteLength && value.maxLines === 200), true);
  assert.equal(result.budgetUsage.contentPages, 3);
  assert.equal(result.budgetUsage.reservedReadBytes, byteLength * 3);
  assert.deepEqual(result.matches.map(value => value.lineNumber), [301]);
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});

test('content page budget is global across files and no-match unread ranges cannot be complete', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'no\n'.repeat(240));
  await fs.writeFile(path.join(f.root, 'B.cs'), 'no\n'.repeat(240));
  const result = take(await ask(f.search, 'absent', { maxPages: 3 }));
  assert.equal(result.matches.length, 0); assert.equal(result.completeness, 'partial');
  assert.equal(result.budgetUsage.contentPages, 3);
  assert.equal(result.coverage.filesFullyScanned, 1);
  assert.equal(result.coverage.filesPartial, 1);
  assert.equal(result.fileReports[1].linesScanned, 200);
  assert.equal(result.fileReports[1].nextLine, 201);
  assert.equal(result.stopReasons.includes('content_page_budget'), true);
});

test('read byte budget reserves the full original file again before continuation', async t => {
  const f = await fixture(t);
  const text = 'line\n'.repeat(450), length = Buffer.byteLength(text);
  await fs.writeFile(path.join(f.root, 'Many.cs'), text);
  const result = take(await ask(f.search, 'absent', { maxReadBytes: length * 2 }));
  assert.equal(result.budgetUsage.contentPages, 2);
  assert.equal(result.budgetUsage.reservedReadBytes, length * 2);
  assert.equal(result.fileReports[0].linesScanned, 400);
  assert.equal(result.fileReports[0].nextLine, 401);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.stopReasons.includes('read_byte_budget'), true);
  assert.equal(f.nativeCalls.length, 2);
});

test('insufficient first-file bytes makes no native read and records an unscanned file', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await ask(f.search, 'needle', { maxReadBytes: 1 }));
  assert.equal(result.completeness, 'partial'); assert.equal(f.nativeCalls.length, 0);
  assert.equal(result.coverage.filesNotRead, 1);
  assert.equal(result.fileReports[0].status, 'not_read');
  assert.equal(result.fileReports[0].sha256, null);
});

test('file and scan budgets preserve distinct known and unexamined coverage', async t => {
  const f = await fixture(t);
  for (const name of ['A.cs', 'B.cs', 'C.cs']) await fs.writeFile(path.join(f.root, name), 'needle');
  const limited = take(await ask(f.search, 'absent', { maxFiles: 1 }));
  assert.equal(limited.coverage.filesAttempted, 1);
  assert.equal(limited.coverage.filesEncountered, 2);
  assert.equal(limited.coverage.unvisitedRetainedEntries, 1);
  assert.equal(limited.fileReports[1].status, 'not_read');
  assert.equal(limited.stopReasons.includes('file_budget'), true);
  const scanned = take(await ask(f.search, 'absent', { maxEntries: 1 }));
  assert.equal(scanned.directoryCoverage.unexaminedFetchedEntries, 1);
  assert.equal(scanned.directoryCoverage.complete, false);
  assert.equal(scanned.completeness, 'partial');
});

test('subdirectories are explicitly skipped and source exclusions and real hardlinks remain owned by policy', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested')); await fs.writeFile(path.join(f.root, 'nested', 'Hidden.cs'), 'needle');
  await fs.mkdir(path.join(f.root, 'runtime')); await fs.writeFile(path.join(f.root, 'runtime', 'Hidden.cs'), 'needle');
  await fs.writeFile(path.join(f.root, 'auth.json'), 'needle');
  await fs.writeFile(path.join(f.root, 'Picture.png'), 'needle');
  await fs.writeFile(path.join(f.root, 'Ordinary.cs'), 'needle');
  await fs.writeFile(path.join(f.outside, 'Hard.cs'), 'needle');
  await fs.link(path.join(f.outside, 'Hard.cs'), path.join(f.root, 'Hard.cs'));
  const result = take(await ask(f.search));
  assert.equal(result.completeness, 'complete');
  assert.equal(result.coverage.skippedDirectories, 1);
  assert.deepEqual(result.matches.map(value => value.path), ['Ordinary.cs']);
  assert.equal(result.directoryCoverage.excludedEntryCount, 4);
  assert.equal(result.directoryCoverage.exclusionCounts.SOURCE_LINK_REJECTED, 1);
  assert.equal(f.nativeCalls.length, 1);
});

test('real symlink or Windows junction does not escape the source policy', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'Outside.cs'), 'needle');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(f.outside, path.join(f.root, 'linked'), kind);
  const result = take(await ask(f.search));
  assert.equal(result.matches.length, 0); assert.equal(f.nativeCalls.length, 0);
  assert.equal(result.directoryCoverage.exclusionCounts.SOURCE_LINK_REJECTED, 1);
  assert.equal(result.completeness, 'complete');
});

test('file growth after directory page is denied by content preflight before the native callback', async t => {
  let changed = false;
  const f = await fixture(t, { wrapContent: (content, state) => ({ async read(request) {
    if (!changed) { changed = true; await fs.writeFile(path.join(state.root, 'A.cs'), 'needle'.repeat(200)); }
    return content.read(request);
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await ask(f.search));
  assert.equal(f.nativeCalls.length, 0);
  assert.equal(result.matches.length, 0);
  assert.equal(result.fileReports[0].errorCode, 'SOURCE_READ_BUDGET_EXCEEDED');
  assert.equal(result.fileReports[0].status, 'failed');
  assert.equal(result.directoryCoverage.snapshotInvalidatedDuringSearch, true);
  assert.equal(result.completeness, 'partial');
});

test('a later SHA mismatch discards every pending match from that file without retry', async t => {
  let reads = 0;
  const f = await fixture(t, { wrapContent: (content, state) => ({ async read(request) {
    reads++;
    if (reads === 2) await fs.writeFile(path.join(state.root, 'A.cs'), 'NEEDLE\n' + 'xxxxxx\n'.repeat(249));
    return content.read(request);
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle\n' + 'xxxxxx\n'.repeat(249));
  const result = take(await ask(f.search, 'needle', { maxMatches: 50 }));
  assert.equal(reads, 2); assert.equal(f.nativeCalls.length, 2);
  assert.equal(result.matches.length, 0);
  assert.equal(result.fileReports[0].errorCode, 'SOURCE_CONTENT_CHANGED');
  assert.equal(result.fileReports[0].status, 'failed');
  assert.equal(result.completeness, 'partial');
});

test('original directory identity is checked after successful content reading before publishing matches', async t => {
  const f = await fixture(t, { wrapContent: (content, state) => ({ async read(request) {
    const result = await content.read(request);
    await fs.writeFile(path.join(state.root, 'A.cs'), 'changed');
    return result;
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await ask(f.search));
  assert.equal(result.matches.length, 0);
  assert.equal(result.fileReports[0].status, 'failed');
  assert.equal(result.fileReports[0].sha256, null);
  assert.equal(result.directoryCoverage.snapshotInvalidatedDuringSearch, true);
});

test('later directory invalidation preserves only earlier verified hashed file observations', async t => {
  let reads = 0;
  const f = await fixture(t, { wrapContent: (content, state) => ({ async read(request) {
    const result = await content.read(request); reads++;
    if (reads === 2) await fs.writeFile(path.join(state.root, request.path), 'mutated');
    return result;
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  await fs.writeFile(path.join(f.root, 'B.cs'), 'needle');
  const result = take(await ask(f.search));
  assert.equal(result.matches.length, 1);
  assert.equal(result.fileReports.filter(value => value.status === 'complete').length, 1);
  assert.equal(result.fileReports.filter(value => value.status === 'failed').length, 1);
  assert.match(result.matches[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.directoryCoverage.snapshotInvalidatedDuringSearch, true);
});

test('match budget marks unscanned lines while exact last-line EOF can be complete', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle\nneedle\nneedle');
  const first = take(await ask(f.search, 'needle', { maxMatches: 1 }));
  assert.equal(first.completeness, 'partial'); assert.equal(first.fileReports[0].nextLine, 2);
  assert.equal(first.fileReports[0].linesScanned, 1);
  const exact = take(await ask(f.search, 'needle', { maxMatches: 3 }));
  assert.equal(exact.completeness, 'complete'); assert.equal(exact.fileReports[0].nextLine, null);
});

test('snippets include exact UTF16 ranges and retain the query when truncating a long line', async t => {
  const f = await fixture(t);
  const line = 'x'.repeat(1000) + 'needle' + 'z'.repeat(1000);
  await fs.writeFile(path.join(f.root, 'A.cs'), line);
  const result = take(await ask(f.search));
  const match = result.matches[0];
  assert.equal(match.columnUtf16, 1001);
  assert.equal(match.snippetTruncatedStart, true); assert.equal(match.snippetTruncatedEnd, true);
  assert.equal(match.snippet, line.slice(match.snippetStartColumnUtf16 - 1, match.snippetEndColumnUtf16Exclusive - 1));
  assert.equal(match.snippet.includes('needle'), true); assert.equal(match.snippet.length <= 320, true);
});

test('complete Result output budget stops matches with explicit unscanned range and intact provenance', async t => {
  const f = await fixture(t);
  const relative = Array.from({ length: 4 }, (_, index) => String(index) + 'x'.repeat(170)).join('/');
  const nested = path.join(f.root, ...relative.split('/'));
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'Long.cs'), ('needle ' + 'z'.repeat(350) + '\n').repeat(60));
  const result = await ask(f.search, 'needle', { path: relative, maxMatches: 50 });
  const value = take(result);
  assert.equal(value.completeness, 'partial');
  assert.equal(value.stopReasons.includes('output_byte_budget'), true);
  assert.equal(value.matches.length > 0 && value.matches.length < 50, true);
  assert.equal(jsonBytes(result) <= SOURCE_SEARCH_MAX_BYTES, true);
  assert.equal(value.matches.every(match => match.path === relative + '/Long.cs' && hashLike(match.sha256)), true);
  assert.equal(value.fileReports[0].status, 'partial');
  assert.equal(value.fileReports[0].nextLine, value.matches.length + 1);
});
const hashLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

test('content failure is classified without returning raw native errors or pending source text', async t => {
  const f = await fixture(t, { wrapContent: () => ({ async read() {
    return { ok: false, error: { code: 'UNKNOWN_PRIVATE_VALUE', message: 'private-source-body' } };
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await ask(f.search));
  assert.equal(result.fileReports[0].errorCode, 'SOURCE_DEPENDENCY_FAILURE');
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  assert.equal(JSON.stringify(result).includes('UNKNOWN_PRIVATE_VALUE'), false);
  assert.equal(result.completeness, 'partial'); assert.equal(result.matches.length, 0);
});

test('malformed continuation line sequence is rejected and earlier pending matches are discarded', async t => {
  let reads = 0;
  const f = await fixture(t, { wrapContent: content => ({ async read(request) {
    const result = await content.read(request); reads++;
    if (reads === 2 && result.ok) result.value.lines[0].lineNumber++;
    return result;
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle\n' + 'other\n'.repeat(249));
  const result = take(await ask(f.search));
  assert.equal(reads, 2);
  assert.equal(result.matches.length, 0);
  assert.equal(result.fileReports[0].stopReasons.includes('content_result_invalid'), true);
  assert.equal(result.fileReports[0].status, 'failed');
  assert.equal(result.completeness, 'partial');
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});

test('EOF provenance must end exactly at declared totalLines instead of accepting extra invented lines', async t => {
  const f = await fixture(t, { wrapContent: content => ({ async read(request) {
    const result = await content.read(request);
    if (result.ok) result.value.totalLines--;
    return result;
  } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle\none\ntwo');
  const result = take(await ask(f.search));
  assert.equal(result.matches.length, 0);
  assert.equal(result.fileReports[0].status, 'failed');
  assert.equal(result.fileReports[0].stopReasons.includes('content_result_invalid'), true);
});

test('a thrown content failure releases its own snapshot and returns no raw text', async t => {
  const f = await fixture(t, { wrapContent: () => ({ async read() { throw new Error('private-source-body'); } }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle');
  const result = take(await ask(f.search));
  assert.equal(result.fileReports[0].errorCode, 'SOURCE_DEPENDENCY_FAILURE');
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  assert.equal(result.matches.length, 0);
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});

test('cleanup failure retains exact owned ID, blocks new searches, and releases no foreign snapshot', async t => {
  let failRelease = true; const released = [];
  const f = await fixture(t, { wrapDirectory: directory => ({ ...directory, async release(request) {
    released.push(request.snapshotId);
    if (failRelease) return { ok: false, error: { code: 'private', message: 'private' } };
    return directory.release(request);
  } }) });
  const foreign = take(await f.directory.scan({ rootId: 'test-source', path: '' }));
  assert.equal((await ask(f.search)).error.code, 'SOURCE_SEARCH_CLEANUP_UNCONFIRMED');
  assert.equal(f.search.diagnostics().retainedOwnedSnapshot, true);
  assert.equal((await ask(f.search)).error.code, 'SOURCE_SEARCH_CLEANUP_PENDING');
  assert.equal(f.directory.diagnostics().snapshotCount, 2);
  assert.equal(released.length, 1); assert.notEqual(released[0], foreign.snapshotId);
  failRelease = false;
  assert.equal(take(await f.search.cleanup()).releasedSnapshotCount, 1);
  assert.equal(released[0], released[1]); assert.equal(f.directory.diagnostics().snapshotCount, 1);
  assert.equal(f.search.diagnostics().retainedOwnedSnapshot, false);
  take(await f.directory.release({ snapshotId: foreign.snapshotId }));
});

test('primary failure and release failure both survive as bounded source-free lifecycle evidence', async t => {
  let failRelease = true;
  const f = await fixture(t, { wrapDirectory: directory => ({ ...directory,
    async scan(request) {
      const result = await directory.scan(request);
      if (result.ok) result.value.metadataSha256 = 'invalid';
      return result;
    },
    async release(request) {
      return failRelease ? { ok: false, error: { code: 'private', message: 'private' } } : directory.release(request);
    },
  }) });
  const result = await ask(f.search);
  assert.equal(result.error.code, 'SOURCE_SEARCH_CLEANUP_UNCONFIRMED');
  assert.deepEqual(result.error.primaryOutcome, { status: 'failed',
    code: 'SOURCE_SEARCH_INVALID_DIRECTORY_RESULT', stopReasons: [], verifiedMatchCount: 0 });
  assert.equal(f.search.diagnostics().retainedOwnedSnapshot, true);
  assert.equal(f.directory.diagnostics().snapshotCount, 1);
  assert.equal(JSON.stringify(result).includes(f.base), false);
  failRelease = false;
  take(await f.search.cleanup());
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});

test('verified partial outcome is summarized when release fails without returning the source body', async t => {
  let failRelease = true;
  const f = await fixture(t, { wrapDirectory: directory => ({ ...directory,
    async release(request) {
      return failRelease ? { ok: false, error: { code: 'private', message: 'private' } } : directory.release(request);
    },
  }) });
  await fs.writeFile(path.join(f.root, 'A.cs'), 'needle private-source-body\nneedle');
  const result = await ask(f.search, 'needle', { maxMatches: 1 });
  assert.equal(result.error.code, 'SOURCE_SEARCH_CLEANUP_UNCONFIRMED');
  assert.equal(result.error.primaryOutcome.status, 'partial');
  assert.equal(result.error.primaryOutcome.code, 'SOURCE_SEARCH_RESULT');
  assert.equal(result.error.primaryOutcome.verifiedMatchCount, 1);
  assert.equal(result.error.primaryOutcome.stopReasons.includes('match_budget'), true);
  assert.equal(JSON.stringify(result).includes('private-source-body'), false);
  assert.equal(f.search.diagnostics().retainedOwnedSnapshot, true);
  failRelease = false;
  take(await f.search.cleanup());
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});

test('busy spans final release, and shared directory cleanup or transport close are never invoked', async t => {
  let unblock, releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const f = await fixture(t, { wrapDirectory: directory => ({ ...directory,
    cleanup: () => { throw new Error('shared cleanup must not run'); },
    async release(request) { releaseStarted(); await gate; return directory.release(request); },
  }) });
  const running = ask(f.search); await started;
  assert.equal(f.search.diagnostics().busy, true);
  assert.equal((await ask(f.search)).error.code, 'SOURCE_SEARCH_BUSY');
  assert.equal((await f.search.cleanup()).error.code, 'SOURCE_SEARCH_BUSY');
  unblock(); take(await running);
  assert.equal(f.search.diagnostics().busy, false);
  assert.equal(f.directory.diagnostics().snapshotCount, 0);
});
