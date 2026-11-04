import { SOURCE_DIRECTORY_MAX_ENTRIES } from './source-directory.mjs';
import { SOURCE_FILE_MAX_BYTES } from './source-policy.mjs';
import { SOURCE_PAGE_MAX_LINES, SOURCE_PAGE_MAX_BYTES } from './source-content.mjs';

export const SOURCE_SEARCH_MAX_BYTES = 32 * 1024;
export const SOURCE_SEARCH_MAX_FILES = 16;
export const SOURCE_SEARCH_MAX_PAGES = 32;
export const SOURCE_SEARCH_MAX_READ_BYTES = 2 * 1024 * 1024;
export const SOURCE_SEARCH_MAX_MATCHES = 50;
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keysOnly = (value, names) => Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key));
const success = value => ({ ok: true, value });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const positive = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const knownCodes = new Set(['INVALID_SOURCE_DIRECTORY_REQUEST', 'INVALID_SOURCE_DIRECTORY_PAGE',
  'UNKNOWN_SOURCE_ROOT', 'INVALID_SOURCE_REQUEST', 'INVALID_SOURCE_PATH', 'EXCLUDED_SOURCE_PATH',
  'EXCLUDED_SOURCE_FILE', 'SOURCE_LINK_REJECTED', 'SOURCE_FILE_TOO_LARGE', 'SOURCE_NOT_REGULAR',
  'SOURCE_NOT_FOUND', 'SOURCE_ACCESS_DENIED', 'SOURCE_IO_ERROR', 'SOURCE_ROOT_NOT_DIRECTORY',
  'SOURCE_ROOT_CHANGED', 'SOURCE_OUTSIDE_ROOT', 'SOURCE_NOT_DIRECTORY', 'SOURCE_IDENTITY_CHANGED',
  'SOURCE_POLICY_UNCERTAIN', 'SOURCE_DIRECTORY_BUSY', 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED',
  'SOURCE_DIRECTORY_CLEANUP_PENDING', 'SOURCE_DIRECTORY_SNAPSHOT_CAPACITY',
  'SOURCE_DIRECTORY_STORAGE_BUDGET', 'SOURCE_DIRECTORY_INVALID_HANDLE', 'SOURCE_DIRECTORY_READ_FAILED',
  'SOURCE_DIRECTORY_INVALID_ENTRY', 'SOURCE_DIRECTORY_OPEN_FAILED', 'SOURCE_DIRECTORY_CHANGED',
  'SOURCE_DIRECTORY_OUTPUT_METADATA_TOO_LARGE', 'SOURCE_DIRECTORY_SNAPSHOT_NOT_FOUND',
  'SOURCE_DIRECTORY_SNAPSHOT_INVALID', 'SOURCE_DIRECTORY_ENTRY_TOO_LARGE',
  'SOURCE_DIRECTORY_OFFSET_OUT_OF_RANGE', 'SOURCE_DIRECTORY_INTERNAL_FAILURE',
  'SOURCE_NOT_FILE', 'SOURCE_NATIVE_READ_FAILED', 'SOURCE_INSPECTION_FAILED',
  'INVALID_SOURCE_NATIVE_RESPONSE', 'SOURCE_NATIVE_PAYLOAD_TOO_LARGE', 'SOURCE_READ_SIZE_MISMATCH',
  'INVALID_SOURCE_BASE64', 'SOURCE_CONTENT_CHANGED', 'SOURCE_REVALIDATION_FAILED',
  'SOURCE_INVALID_UTF8', 'SOURCE_BINARY_CONTENT', 'SOURCE_OUTPUT_METADATA_TOO_LARGE',
  'SOURCE_LINE_TOO_LARGE', 'SOURCE_LINE_OUT_OF_RANGE', 'SOURCE_READ_BUDGET_EXCEEDED']);
const dependencyCode = result => knownCodes.has(result?.error?.code) ? result.error.code : 'SOURCE_DEPENDENCY_FAILURE';
const searchCodes = new Set(['SOURCE_SEARCH_DIRECTORY_FAILED', 'SOURCE_SEARCH_INVALID_DIRECTORY_RESULT',
  'SOURCE_SEARCH_OUTPUT_METADATA_TOO_LARGE', 'SOURCE_SEARCH_INTERNAL_FAILURE']);
const searchStopReasons = new Set(['directory_scan_incomplete', 'directory_snapshot_invalid',
  'file_budget', 'content_page_budget', 'read_byte_budget', 'output_byte_budget',
  'file_failed', 'file_incomplete', 'match_budget', 'retained_entries_unvisited']);

function primarySummary(result) {
  if (result?.ok === true) return {
    status: result.value.completeness === 'complete' ? 'success' : 'partial', code: 'SOURCE_SEARCH_RESULT',
    stopReasons: result.value.stopReasons.filter(reason => searchStopReasons.has(reason)),
    verifiedMatchCount: result.value.matches.length,
  };
  return { status: 'failed', code: searchCodes.has(result?.error?.code) ? result.error.code : 'SOURCE_SEARCH_INTERNAL_FAILURE',
    stopReasons: [], verifiedMatchCount: 0 };
}

function parse(request) {
  try {
    if (!plain(request) || !keysOnly(request, ['rootId', 'path', 'query', 'maxEntries',
      'maxFiles', 'maxPages', 'maxReadBytes', 'maxMatches'])) throw new Error();
    const { rootId, path, query, maxEntries = 128, maxFiles = 8, maxPages = 16,
      maxReadBytes = 1024 * 1024, maxMatches = 20 } = request;
    if (typeof rootId !== 'string' || typeof path !== 'string' || typeof query !== 'string' ||
        query.length < 1 || query.length > 128 || /[\0\r\n]/.test(query) ||
        !positive(maxEntries, SOURCE_DIRECTORY_MAX_ENTRIES) || !positive(maxFiles, SOURCE_SEARCH_MAX_FILES) ||
        !positive(maxPages, SOURCE_SEARCH_MAX_PAGES) || !positive(maxReadBytes, SOURCE_SEARCH_MAX_READ_BYTES) ||
        !positive(maxMatches, SOURCE_SEARCH_MAX_MATCHES)) throw new Error();
    return success({ rootId, path, query, maxEntries, maxFiles, maxPages, maxReadBytes, maxMatches });
  } catch { return fail('INVALID_SOURCE_SEARCH_REQUEST', 'Search requires named source, literal query and bounded scan/read/output budgets.'); }
}

function copiedCoverage(value) {
  if (!plain(value)) return null;
  const counts = ['maxEntries', 'rawDirectoryReads', 'rawEntriesFetched', 'policyInspected',
    'excludedEntryCount', 'uncertainEntryCount', 'unexaminedFetchedEntries', 'metadataRetentionOmitted'];
  if (!counts.every(key => nonnegative(value[key])) || typeof value.endOfDirectoryObserved !== 'boolean' ||
      typeof value.complete !== 'boolean' || !Array.isArray(value.truncationReasons) ||
      !value.truncationReasons.every(reason => ['entry_scan_budget', 'retained_byte_budget',
        'entry_inspection_uncertain'].includes(reason))) return null;
  const result = Object.fromEntries(counts.map(key => [key, value[key]]));
  for (const field of ['exclusionCounts', 'uncertaintyCounts']) {
    if (!plain(value[field])) return null;
    result[field] = {};
    for (const [key, count] of Object.entries(value[field])) {
      if (!knownCodes.has(key) || !nonnegative(count)) return null;
      result[field][key] = count;
    }
  }
  return { ...result, endOfDirectoryObserved: value.endOfDirectoryObserved,
    complete: value.complete, truncationReasons: [...value.truncationReasons] };
}

function snippet(line, index, query) {
  const start = Math.max(0, index - 80), end = Math.min(line.length, Math.max(start + 320, index + query.length));
  return { columnUtf16: index + 1, snippet: line.slice(start, end), snippetStartColumnUtf16: start + 1,
    snippetEndColumnUtf16Exclusive: end + 1, snippetTruncatedStart: start > 0,
    snippetTruncatedEnd: end < line.length };
}

/**
 * Internal, single-directory literal search. Directory snapshots remain owned
 * by their directory owner; this consumer holds only IDs it obtained itself.
 * File results are buffered until the original directory entry is revalidated.
 * Returned files are individually verified historical observations, not one
 * atomic project snapshot or an OS sandbox against same-user filesystem races.
 */
export function createSourceSearch(options) {
  const invalid = () => fail('INVALID_SOURCE_SEARCH', 'Trusted directory and content owners are required.');
  let directory, content, scanMethod, pageMethod, releaseMethod, readMethod;
  try {
    if (!plain(options) || !keysOnly(options, ['directory', 'content'])) return invalid();
    directory = options.directory; content = options.content;
    scanMethod = directory?.scan; pageMethod = directory?.page;
    releaseMethod = directory?.release; readMethod = content?.read;
  } catch { return invalid(); }
  if (![scanMethod, pageMethod, releaseMethod, readMethod].every(method => typeof method === 'function')) return invalid();
  const scan = scanMethod.bind(directory), page = pageMethod.bind(directory),
    release = releaseMethod.bind(directory), read = readMethod.bind(content);
  let busy = false, operation = null, retainedSnapshotId = null;
  const busyResult = () => fail('SOURCE_SEARCH_BUSY', 'A search or its final cleanup still owns this instance.');
  const cleanupFailure = () => fail('SOURCE_SEARCH_CLEANUP_UNCONFIRMED',
    'Snapshot release was not confirmed; its exact issued ID is retained for cleanup.');

  async function releaseOwned() {
    if (!retainedSnapshotId) return success({ released: false });
    const selected = retainedSnapshotId;
    try {
      const result = await release({ snapshotId: selected });
      if (result?.ok === true && result.value?.released === true && result.value.snapshotId === selected) {
        retainedSnapshotId = null;
        return success({ released: true });
      }
    } catch { /* Keep ownership; no automatic retry. */ }
    return cleanupFailure();
  }

  async function search(request) {
    const parsed = parse(request);
    if (!parsed.ok) return parsed;
    if (busy) return busyResult();
    if (retainedSnapshotId) return fail('SOURCE_SEARCH_CLEANUP_PENDING', 'Release the previously owned snapshot before searching again.');
    busy = true; operation = 'search';
    let result;
    try { result = await run(parsed.value); }
    catch { result = fail('SOURCE_SEARCH_INTERNAL_FAILURE', 'Search failed without returning source contents.'); }
    finally {
      const released = await releaseOwned();
      if (!released.ok) result = fail(released.error.code, released.error.message,
        { primaryOutcome: primarySummary(result) });
      busy = false; operation = null;
    }
    return result;
  }

  async function run(input) {
    let captured;
    try { captured = await scan({ rootId: input.rootId, path: input.path, maxEntries: input.maxEntries }); }
    catch { return fail('SOURCE_SEARCH_DIRECTORY_FAILED', 'The directory scan failed without returning source contents.'); }
    if (captured?.ok !== true) return fail('SOURCE_SEARCH_DIRECTORY_FAILED',
      'The directory scan could not establish a source snapshot.', { cause: dependencyCode(captured) });
    const raw = captured.value;
    // Even malformed remaining metadata must not make us forget an issued ID.
    if (uuid(raw?.snapshotId)) retainedSnapshotId = raw.snapshotId;
    const coverage = copiedCoverage(raw?.coverage);
    if (!retainedSnapshotId || raw?.rootId !== input.rootId || raw?.path !== input.path ||
        !hash(raw?.metadataSha256) || typeof raw?.collectedAt !== 'string' ||
        !nonnegative(raw?.retainedEntryCount) || raw.retainedEntryCount > input.maxEntries || !coverage)
      return fail('SOURCE_SEARCH_INVALID_DIRECTORY_RESULT', 'Directory provenance was not a valid bounded source snapshot.');
    const matches = [], fileReports = [], stopReasons = [];
    const addReason = reason => { if (!stopReasons.includes(reason)) stopReasons.push(reason); };
    if (!coverage.complete) addReason('directory_scan_incomplete');
    const counters = { retainedEntriesVisited: 0, unvisitedRetainedEntries: raw.retainedEntryCount,
      skippedDirectories: 0, filesEncountered: 0, filesAttempted: 0, filesFullyScanned: 0,
      filesPartial: 0, filesFailed: 0, filesNotRead: 0 };
    const usage = { contentPages: 0, reservedReadBytes: 0, directoryPageCalls: 0 };
    let invalidated = false, stop = false;
    function response() {
      return success({ schemaVersion: 1, rootId: input.rootId, path: input.path, query: input.query,
        scope: 'single_directory_files', matchMode: 'literal_case_sensitive_first_per_line',
        consistency: 'individually_verified_history_not_atomic_directory', collectedAt: raw.collectedAt,
        directorySnapshot: { metadataSha256: raw.metadataSha256, retainedEntryCount: raw.retainedEntryCount },
        directoryCoverage: { ...coverage, snapshotInvalidatedDuringSearch: invalidated },
        coverage: { ...counters }, budgetUsage: { ...usage,
          maxEntries: input.maxEntries, maxFiles: input.maxFiles, maxPages: input.maxPages,
          maxReadBytes: input.maxReadBytes, maxMatches: input.maxMatches,
          readAccounting: 'captured_full_file_bytes_reserved_before_each_content_page' },
        matches: [...matches], fileReports: [...fileReports],
        completeness: stopReasons.length === 0 ? 'complete' : 'partial', stopReasons: [...stopReasons] });
    }
    const fits = extra => bytes(extra ?? response()) <= SOURCE_SEARCH_MAX_BYTES;
    if (!fits()) return fail('SOURCE_SEARCH_OUTPUT_METADATA_TOO_LARGE', 'Search provenance does not fit the bounded output.');

    async function entryAt(offset) {
      usage.directoryPageCalls++;
      let selected;
      try { selected = await page({ snapshotId: retainedSnapshotId, offset, limit: 1 }); }
      catch { return fail('SOURCE_DEPENDENCY_FAILURE', 'The original directory snapshot could not be checked.'); }
      if (selected?.ok !== true) return fail(dependencyCode(selected), 'The original directory snapshot could not be checked.');
      const dto = selected.value, entry = dto?.entries?.[0];
      if (dto?.snapshotId !== retainedSnapshotId || dto?.rootId !== input.rootId || dto?.path !== input.path ||
          dto?.metadataSha256 !== raw.metadataSha256 || !Array.isArray(dto.entries) || dto.entries.length !== 1 ||
          !plain(entry) || entry.rootId !== input.rootId || typeof entry.path !== 'string' ||
          !['directory', 'file'].includes(entry.kind) || entry.sha256 !== null ||
          (entry.kind === 'file' ? !nonnegative(entry.byteLength) || entry.byteLength > SOURCE_FILE_MAX_BYTES : entry.byteLength !== null))
        return fail('SOURCE_DEPENDENCY_FAILURE', 'The original directory entry did not have a usable source identity.');
      return success({ rootId: entry.rootId, path: entry.path, kind: entry.kind, byteLength: entry.byteLength, sha256: null });
    }

    for (let offset = 0; offset < raw.retainedEntryCount && !stop; offset++) {
      const selected = await entryAt(offset);
      if (!selected.ok) { invalidated = true; addReason('directory_snapshot_invalid'); break; }
      const entry = selected.value;
      counters.retainedEntriesVisited++; counters.unvisitedRetainedEntries--;
      if (entry.kind === 'directory') { counters.skippedDirectories++; continue; }
      counters.filesEncountered++;
      const report = { rootId: entry.rootId, path: entry.path, byteLength: entry.byteLength, sha256: null,
        collectedAt: new Date().toISOString(), verifiedAt: null, status: 'not_read', linesScanned: 0,
        totalLines: null, nextLine: 1, stopReasons: [] };
      const pending = [];
      let startLine = 1, contentHash, totalLines, eof = false, fileFailed = false, reachedMatches = false;
      function projected(nextMatch, lineCount) {
        const current = response();
        current.value.matches.push(...pending, ...(nextMatch ? [nextMatch] : []));
        current.value.fileReports.push({ ...report, linesScanned: lineCount,
          stopReasons: ['output_byte_budget'], status: 'partial' });
        current.value.stopReasons.push('output_byte_budget'); current.value.completeness = 'partial';
        // Reserve final status/counter changes without clipping provenance.
        return bytes(current) <= SOURCE_SEARCH_MAX_BYTES - 1024;
      }
      for (;;) {
        let budgetStop = null;
        if (report.status === 'not_read' && counters.filesAttempted >= input.maxFiles) budgetStop = 'file_budget';
        else if (usage.contentPages >= input.maxPages) budgetStop = 'content_page_budget';
        else if (entry.byteLength > input.maxReadBytes - usage.reservedReadBytes) budgetStop = 'read_byte_budget';
        if (budgetStop) { report.stopReasons.push(budgetStop); addReason(budgetStop); stop = true; break; }
        if (report.status === 'not_read') { report.status = 'partial'; counters.filesAttempted++; }
        // content's same-inspection cap rejects a now-larger file before native
        // reading. Repeated pages still read the entire file and are all charged.
        usage.contentPages++; usage.reservedReadBytes += entry.byteLength;
        let readResult;
        try { readResult = await read({ rootId: entry.rootId, path: entry.path, startLine,
          maxLines: SOURCE_PAGE_MAX_LINES, maxReadBytes: entry.byteLength,
          ...(contentHash ? { expectedSha256: contentHash } : {}) }); }
        catch { readResult = fail('SOURCE_DEPENDENCY_FAILURE', 'Source content reading failed.'); }
        if (readResult?.ok !== true) {
          report.stopReasons.push('content_read_failed'); report.errorCode = dependencyCode(readResult);
          fileFailed = true; break;
        }
        const contentPage = readResult.value;
        let valid = contentPage?.rootId === entry.rootId && contentPage?.path === entry.path &&
          contentPage?.byteLength === entry.byteLength && hash(contentPage?.sha256) &&
          (!contentHash || contentPage.sha256 === contentHash) && contentPage.startLine === startLine &&
          nonnegative(contentPage.totalLines) && (totalLines === undefined || totalLines === contentPage.totalLines) &&
          contentPage.totalLines >= startLine - 1 && Array.isArray(contentPage.lines) &&
          contentPage.lines.length <= SOURCE_PAGE_MAX_LINES && bytes(readResult) <= SOURCE_PAGE_MAX_BYTES;
        if (valid) {
          const count = contentPage.lines.length;
          valid = contentPage.lines.every((line, index) => plain(line) && typeof line.text === 'string' &&
            !/[\0\r\n]/.test(line.text) && line.lineNumber === startLine + index) &&
            contentPage.endLine === (count ? startLine + count - 1 : null) &&
            (contentPage.nextLine === null ? startLine + count === contentPage.totalLines + 1 :
              count > 0 && contentPage.nextLine === startLine + count && contentPage.nextLine <= contentPage.totalLines) &&
            contentPage.completeness === (contentPage.nextLine === null ? 'complete' : 'partial') &&
            contentPage.wholeFileReturned === (startLine === 1 && contentPage.nextLine === null);
        }
        if (!valid) { report.stopReasons.push('content_result_invalid'); fileFailed = true; break; }
        contentHash = contentPage.sha256; totalLines = contentPage.totalLines;
        report.sha256 = contentHash; report.totalLines = totalLines;
        for (const line of contentPage.lines) {
          const index = line.text.indexOf(input.query);
          if (index !== -1) {
            const match = { rootId: entry.rootId, path: entry.path, sha256: contentHash,
              lineNumber: line.lineNumber, ...snippet(line.text, index, input.query) };
            if (!projected(match, report.linesScanned + 1)) {
              report.stopReasons.push('output_byte_budget'); addReason('output_byte_budget'); stop = true; break;
            }
            pending.push(match);
          }
          report.linesScanned++;
          if (matches.length + pending.length === input.maxMatches) { reachedMatches = true; break; }
        }
        report.nextLine = report.linesScanned < totalLines ? report.linesScanned + 1 : null;
        eof = report.nextLine === null && contentPage.nextLine === null;
        if (stop || reachedMatches || eof) break;
        startLine = contentPage.nextLine;
      }
      // Includes no-read/budget exits: verification always uses the original
      // snapshot offset, never the content reader's newer inspect identity.
      const checked = await entryAt(offset);
      if (!checked.ok || checked.value.path !== entry.path || checked.value.kind !== entry.kind ||
          checked.value.byteLength !== entry.byteLength) {
        report.stopReasons.push('directory_snapshot_invalid'); fileFailed = true;
        invalidated = true; addReason('directory_snapshot_invalid'); stop = true;
      }
      if (fileFailed) {
        pending.length = 0; report.status = 'failed'; report.linesScanned = 0;
        report.sha256 = null; report.totalLines = null; report.nextLine = null;
        counters.filesFailed++; addReason('file_failed');
      } else {
        report.verifiedAt = new Date().toISOString();
        if (report.status === 'not_read') counters.filesNotRead++;
        else if (eof) { report.status = 'complete'; counters.filesFullyScanned++; }
        else {
          report.status = 'partial'; counters.filesPartial++; addReason('file_incomplete');
          if (reachedMatches) report.stopReasons.push('match_budget');
        }
        matches.push(...pending);
      }
      if (reachedMatches) {
        stop = true;
        if (!eof || counters.unvisitedRetainedEntries > 0) addReason('match_budget');
      }
      fileReports.push(report);
      if (!fits()) return fail('SOURCE_SEARCH_OUTPUT_METADATA_TOO_LARGE', 'Complete result provenance does not fit the output budget.');
    }
    if (counters.unvisitedRetainedEntries > 0) addReason('retained_entries_unvisited');
    const result = response();
    return fits(result) ? result : fail('SOURCE_SEARCH_OUTPUT_METADATA_TOO_LARGE', 'Complete result provenance does not fit the output budget.');
  }

  async function cleanup() {
    if (busy) return busyResult();
    busy = true; operation = 'cleanup';
    try {
      const released = await releaseOwned();
      return released.ok ? success({ releasedSnapshotCount: released.value.released ? 1 : 0,
        retainedOwnedSnapshot: false }) : released;
    } finally { busy = false; operation = null; }
  }
  const diagnostics = () => ({ busy, operation, retainedOwnedSnapshot: retainedSnapshotId !== null });
  return success(Object.freeze({ search, cleanup, diagnostics }));
}
