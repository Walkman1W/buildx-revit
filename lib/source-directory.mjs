import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { SOURCE_FILE_MAX_BYTES } from './source-policy.mjs';

export const SOURCE_DIRECTORY_MAX_ENTRIES = 512;
export const SOURCE_DIRECTORY_PAGE_MAX_ENTRIES = 100;
export const SOURCE_DIRECTORY_PAGE_MAX_BYTES = 32 * 1024;
export const SOURCE_DIRECTORY_MAX_SNAPSHOTS = 4;
export const SOURCE_DIRECTORY_RETAINED_MAX_BYTES = 1024 * 1024;

const plainObject = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keysOnly = (value, names) => Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key));
const success = value => ({ ok: true, value });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const expectedExclusions = new Set(['EXCLUDED_SOURCE_PATH', 'EXCLUDED_SOURCE_FILE', 'SOURCE_LINK_REJECTED',
  'SOURCE_FILE_TOO_LARGE', 'SOURCE_NOT_REGULAR', 'INVALID_SOURCE_PATH']);
const knownPolicyCodes = new Set([...expectedExclusions, 'UNKNOWN_SOURCE_ROOT', 'INVALID_SOURCE_REQUEST',
  'SOURCE_NOT_FOUND', 'SOURCE_ACCESS_DENIED', 'SOURCE_IO_ERROR', 'SOURCE_ROOT_NOT_DIRECTORY',
  'SOURCE_ROOT_CHANGED', 'SOURCE_OUTSIDE_ROOT', 'SOURCE_NOT_DIRECTORY', 'SOURCE_IDENTITY_CHANGED']);
const policyCode = result => knownPolicyCodes.has(result?.error?.code) ? result.error.code : 'SOURCE_POLICY_UNCERTAIN';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function scanInput(request) {
  try {
    if (!plainObject(request) || !keysOnly(request, ['rootId', 'path', 'maxEntries'])) throw new Error();
    const { rootId, path, maxEntries = 128 } = request;
    if (typeof rootId !== 'string' || typeof path !== 'string' || !Number.isSafeInteger(maxEntries) ||
        maxEntries < 1 || maxEntries > SOURCE_DIRECTORY_MAX_ENTRIES) throw new Error();
    return success({ rootId, path, maxEntries });
  } catch { return fail('INVALID_SOURCE_DIRECTORY_REQUEST', 'Select a source root, relative path and a scan budget between 1 and 512.'); }
}

function pageInput(request) {
  try {
    if (!plainObject(request) || !keysOnly(request, ['snapshotId', 'offset', 'limit'])) throw new Error();
    const { snapshotId, offset = 0, limit = 50 } = request;
    if (!uuid(snapshotId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > SOURCE_DIRECTORY_PAGE_MAX_ENTRIES) throw new Error();
    return success({ snapshotId, offset, limit });
  } catch { return fail('INVALID_SOURCE_DIRECTORY_PAGE', 'A snapshot ID, nonnegative offset and a page limit between 1 and 100 are required.'); }
}

function releaseInput(request) {
  try {
    if (!plainObject(request) || !keysOnly(request, ['snapshotId'])) throw new Error();
    const snapshotId = request.snapshotId;
    if (!uuid(snapshotId)) throw new Error();
    return success(snapshotId);
  } catch { return fail('INVALID_SOURCE_DIRECTORY_RELEASE', 'Release accepts only an issued snapshot ID.'); }
}

// Only internally obtained policy facts enter this copy. Returned DTOs never
// accept or expose this identity as an authorization token.
function identityCopy(identity) {
  return Object.freeze({ ...identity, rootIdentity: Object.freeze({ ...identity.rootIdentity }) });
}

/**
 * Single-level source directory owner. opendir's bufferSize is one; every raw
 * entry, including exclusions, consumes the same scan budget. A fetched sentinel
 * is not inspected. No directory stream survives successful scan completion.
 *
 * Pages describe captured metadata and revalidate their directory and returned
 * entries. This is neither a content hash nor an OS sandbox, and it cannot
 * eliminate races against another local process with the same permissions.
 */
export function createSourceDirectoryBrowser(options) {
  const invalid = () => fail('INVALID_SOURCE_DIRECTORY_BROWSER', 'A trusted source policy and optional directory opener are required.');
  let policy, inspectMethod, revalidateMethod, maxFileBytes, openDirectory;
  try {
    if (!plainObject(options) || !keysOnly(options, ['policy', 'openDirectory'])) return invalid();
    policy = options.policy;
    inspectMethod = policy?.inspect;
    revalidateMethod = policy?.revalidate;
    maxFileBytes = policy?.maxFileBytes;
    openDirectory = options.openDirectory;
    if (openDirectory === undefined) openDirectory = (absolutePath, input) => fs.opendir(absolutePath, input);
  } catch { return invalid(); }
  if (typeof inspectMethod !== 'function' || typeof revalidateMethod !== 'function' ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > SOURCE_FILE_MAX_BYTES ||
      typeof openDirectory !== 'function') return invalid();
  const inspect = inspectMethod.bind(policy), revalidate = revalidateMethod.bind(policy);
  const snapshots = new Map();
  let busy = false, operation = null, retainedBytes = 0, ownedDirectory = null;

  const busyResult = () => fail('SOURCE_DIRECTORY_BUSY', 'Another directory operation owns this browser until its cleanup completes.');
  const cleanupFailure = () => fail('SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED',
    'Closing the owned directory was not confirmed; its exact handle is retained for cleanup.');

  async function checkedInspect(input) {
    try {
      const result = await inspect(input);
      if (result?.ok === false) return fail(policyCode(result), 'The source policy did not establish a usable directory entry.');
      if (result?.ok !== true || !plainObject(result.value) || result.value.schemaVersion !== 1 ||
          result.value.rootId !== input.rootId || result.value.path !== input.path ||
          !['file', 'directory'].includes(result.value.kind) ||
          typeof result.value.absolutePath !== 'string' || !plainObject(result.value.rootIdentity))
        return fail('SOURCE_POLICY_UNCERTAIN', 'The source policy did not return a trusted identity.');
      if (result.value.kind === 'file' && (!Number.isSafeInteger(result.value.byteLength) ||
          result.value.byteLength < 0 || result.value.byteLength > maxFileBytes))
        return fail('SOURCE_FILE_TOO_LARGE', 'The source metadata exceeds the captured file byte budget.');
      if (result.value.kind === 'directory' && result.value.byteLength !== null)
        return fail('SOURCE_POLICY_UNCERTAIN', 'The source policy did not return directory metadata.');
      return success(identityCopy(result.value));
    } catch { return fail('SOURCE_POLICY_UNCERTAIN', 'Source identity inspection failed.'); }
  }

  async function checkedRevalidate(identity) {
    try {
      const result = await revalidate(identity);
      return result?.ok === true ? success(undefined) :
        fail(policyCode(result), 'Captured source metadata could not be revalidated.');
    } catch { return fail('SOURCE_POLICY_UNCERTAIN', 'Captured source metadata could not be revalidated.'); }
  }

  async function closeOwned() {
    if (!ownedDirectory) return success({ closed: false });
    const owned = ownedDirectory;
    try {
      await owned.close();
      // No new operation can run until this operation relinquishes busy.
      if (ownedDirectory === owned) ownedDirectory = null;
      return success({ closed: true });
    } catch { return cleanupFailure(); }
  }

  async function exclusive(name, action) {
    if (busy) return busyResult();
    busy = true; operation = name;
    try { return await action(); }
    catch { return fail('SOURCE_DIRECTORY_INTERNAL_FAILURE', 'The directory operation failed without returning captured entries.'); }
    finally { busy = false; operation = null; }
  }

  async function scan(request) {
    const parsed = scanInput(request);
    if (!parsed.ok) return parsed;
    return exclusive('scan', async () => {
      if (ownedDirectory) return fail('SOURCE_DIRECTORY_CLEANUP_PENDING', 'Close the retained directory handle before scanning again.');
      if (snapshots.size >= SOURCE_DIRECTORY_MAX_SNAPSHOTS)
        return fail('SOURCE_DIRECTORY_SNAPSHOT_CAPACITY', 'Release a snapshot before capturing another directory.');
      const input = parsed.value;
      const initial = await checkedInspect({ rootId: input.rootId, path: input.path });
      if (!initial.ok) return initial;
      const directoryIdentity = initial.value;
      if (directoryIdentity.kind !== 'directory')
        return fail('SOURCE_NOT_DIRECTORY', 'Directory scans require an ordinary source directory.');
      const collectedAt = new Date().toISOString(), snapshotId = randomUUID(), records = [];
      const coverage = { maxEntries: input.maxEntries, rawDirectoryReads: 0, rawEntriesFetched: 0,
        policyInspected: 0, excludedEntryCount: 0, exclusionCounts: {}, uncertainEntryCount: 0,
        uncertaintyCounts: {}, unexaminedFetchedEntries: 0, metadataRetentionOmitted: 0,
        endOfDirectoryObserved: false, complete: false, truncationReasons: [] };
      // Account for private identities as well as the public metadata. Reserve a
      // bounded header allowance before retaining entries, not after an unbounded
      // full-directory collection has already been allocated.
      const baseBytes = jsonBytes({ snapshotId, rootId: input.rootId, path: input.path, collectedAt,
        directoryIdentity, records: [], coverage, metadataSha256: ''.padEnd(64, '0') }) + 2048;
      if (retainedBytes + baseBytes > SOURCE_DIRECTORY_RETAINED_MAX_BYTES)
        return fail('SOURCE_DIRECTORY_STORAGE_BUDGET', 'The retained metadata budget has no room for this directory identity.');
      let recordsBytes = 0, primaryFailure = null;
      try {
        const handle = await openDirectory(directoryIdentity.absolutePath, { bufferSize: 1 });
        // Capture methods exactly once, retaining the exact object if its shape
        // is unusable. The opener is a trusted dependency, never a client RPC.
        ownedDirectory = { handle, close: async () => { throw new Error(); } };
        const closeMethod = handle?.close;
        if (typeof closeMethod === 'function') ownedDirectory.close = closeMethod.bind(handle);
        const readMethod = handle?.read;
        if (typeof readMethod !== 'function' || typeof closeMethod !== 'function')
          primaryFailure = fail('SOURCE_DIRECTORY_INVALID_HANDLE', 'The directory opener did not return a readable, closable handle.');
        else {
          const read = readMethod.bind(handle);
          for (;;) {
            coverage.rawDirectoryReads++;
            let entry;
            try { entry = await read(); }
            catch { primaryFailure = fail('SOURCE_DIRECTORY_READ_FAILED', 'The directory stream failed; no snapshot was issued.'); break; }
            if (entry === null) { coverage.endOfDirectoryObserved = true; break; }
            coverage.rawEntriesFetched++;
            if (coverage.policyInspected === input.maxEntries) {
              coverage.unexaminedFetchedEntries++;
              coverage.truncationReasons.push('entry_scan_budget');
              break;
            }
            coverage.policyInspected++;
            let name;
            try { name = entry?.name; } catch { name = undefined; }
            if (typeof name !== 'string') {
              primaryFailure = fail('SOURCE_DIRECTORY_INVALID_ENTRY', 'A directory entry lacked an ordinary name.'); break;
            }
            // Policy owns name/path admissibility; consumers do not repeat its
            // extension, exclusion, link or path normalization rules.
            const relativePath = input.path === '' ? name : `${input.path}/${name}`;
            const inspected = await checkedInspect({ rootId: input.rootId, path: relativePath });
            if (!inspected.ok) {
              const code = inspected.error.code;
              if (expectedExclusions.has(code)) {
                coverage.excludedEntryCount++;
                coverage.exclusionCounts[code] = (coverage.exclusionCounts[code] ?? 0) + 1;
              } else {
                coverage.uncertainEntryCount++;
                coverage.uncertaintyCounts[code] = (coverage.uncertaintyCounts[code] ?? 0) + 1;
              }
              continue;
            }
            const identity = inspected.value;
            const entryDto = Object.freeze({ rootId: identity.rootId, path: identity.path, kind: identity.kind,
              byteLength: identity.byteLength, sha256: null });
            const record = Object.freeze({ entry: entryDto, identity });
            const addedBytes = jsonBytes(record) + (records.length > 0 ? 1 : 0);
            if (retainedBytes + baseBytes + recordsBytes + addedBytes > SOURCE_DIRECTORY_RETAINED_MAX_BYTES) {
              coverage.metadataRetentionOmitted++;
              coverage.truncationReasons.push('retained_byte_budget');
              break;
            }
            records.push(record); recordsBytes += addedBytes;
          }
        }
      } catch { primaryFailure = fail('SOURCE_DIRECTORY_OPEN_FAILED', 'The directory could not be opened within the source policy.'); }
      finally {
        const closed = await closeOwned();
        if (!closed.ok) primaryFailure = fail(closed.error.code, closed.error.message,
          primaryFailure ? { cause: primaryFailure.error.code } : {});
      }
      if (primaryFailure) return primaryFailure;
      const checked = await checkedRevalidate(directoryIdentity);
      if (!checked.ok) return fail('SOURCE_DIRECTORY_CHANGED', 'The captured directory identity changed during scanning.', { cause: checked.error.code });
      if (coverage.uncertainEntryCount > 0) coverage.truncationReasons.push('entry_inspection_uncertain');
      coverage.complete = coverage.endOfDirectoryObserved && coverage.uncertainEntryCount === 0 && coverage.metadataRetentionOmitted === 0;
      const metadataSha256 = createHash('sha256').update(JSON.stringify({ directoryIdentity, records })).digest('hex');
      const snapshot = Object.freeze({ snapshotId, rootId: input.rootId, path: input.path, collectedAt,
        directoryIdentity, records: Object.freeze(records), coverage: Object.freeze({ ...coverage,
          exclusionCounts: Object.freeze(coverage.exclusionCounts), uncertaintyCounts: Object.freeze(coverage.uncertaintyCounts),
          truncationReasons: Object.freeze(coverage.truncationReasons) }), metadataSha256 });
      const bytes = jsonBytes(snapshot);
      if (retainedBytes + bytes > SOURCE_DIRECTORY_RETAINED_MAX_BYTES)
        return fail('SOURCE_DIRECTORY_STORAGE_BUDGET', 'The captured metadata exceeds the retained snapshot budget.');
      const response = success(summary(snapshot));
      if (jsonBytes(response) > SOURCE_DIRECTORY_PAGE_MAX_BYTES)
        return fail('SOURCE_DIRECTORY_OUTPUT_METADATA_TOO_LARGE', 'Directory provenance does not fit the output budget.');
      snapshots.set(snapshotId, { snapshot, bytes, invalidCause: null }); retainedBytes += bytes;
      return response;
    });
  }

  function summary(snapshot) {
    return { schemaVersion: 1, snapshotId: snapshot.snapshotId, rootId: snapshot.rootId, path: snapshot.path,
      collectedAt: snapshot.collectedAt, metadataSha256: snapshot.metadataSha256, contentsRead: false,
      retainedEntryCount: snapshot.records.length, ordering: 'captured_directory_order',
      coverage: { ...snapshot.coverage, exclusionCounts: { ...snapshot.coverage.exclusionCounts },
        uncertaintyCounts: { ...snapshot.coverage.uncertaintyCounts }, truncationReasons: [...snapshot.coverage.truncationReasons] } };
  }

  async function page(request) {
    const parsed = pageInput(request);
    if (!parsed.ok) return parsed;
    return exclusive('page', async () => {
      const input = parsed.value, held = snapshots.get(input.snapshotId);
      if (!held) return fail('SOURCE_DIRECTORY_SNAPSHOT_NOT_FOUND', 'The snapshot was not issued here or has been released.');
      if (held.invalidCause) return fail('SOURCE_DIRECTORY_SNAPSHOT_INVALID', 'The captured snapshot previously failed identity validation.', { cause: held.invalidCause });
      const snapshot = held.snapshot;
      if (input.offset > snapshot.records.length)
        return fail('SOURCE_DIRECTORY_OFFSET_OUT_OF_RANGE', 'The offset exceeds the retained entries in this snapshot.');
      async function validate(identity) {
        const checked = await checkedRevalidate(identity);
        if (!checked.ok) {
          held.invalidCause = checked.error.code;
          return fail('SOURCE_DIRECTORY_SNAPSHOT_INVALID', 'Captured metadata could not be validated; no old entries were returned.', { cause: held.invalidCause });
        }
        return checked;
      }
      let checked = await validate(snapshot.directoryIdentity);
      if (!checked.ok) return checked;
      const entries = [], records = [];
      function response(reason) {
        const nextOffset = input.offset + entries.length < snapshot.records.length ? input.offset + entries.length : null;
        return success({ ...summary(snapshot), offset: input.offset, entries: entries.map(entry => ({ ...entry })), nextOffset,
          pageCompleteness: nextOffset === null ? 'complete' : 'partial',
          wholeSnapshotReturned: input.offset === 0 && nextOffset === null,
          pageTruncationReasons: nextOffset === null ? [] : [reason] });
      }
      if (jsonBytes(response('page_entry_limit')) > SOURCE_DIRECTORY_PAGE_MAX_BYTES)
        return fail('SOURCE_DIRECTORY_OUTPUT_METADATA_TOO_LARGE', 'Directory provenance does not fit the output budget.');
      let reason = 'page_entry_limit';
      for (let index = input.offset; index < Math.min(snapshot.records.length, input.offset + input.limit); index++) {
        const record = snapshot.records[index]; entries.push(record.entry);
        if (jsonBytes(response('output_byte_budget')) > SOURCE_DIRECTORY_PAGE_MAX_BYTES) {
          entries.pop(); reason = 'output_byte_budget';
          if (entries.length === 0)
            return fail('SOURCE_DIRECTORY_ENTRY_TOO_LARGE', 'A complete directory entry does not fit the output budget.');
          break;
        }
        records.push(record);
      }
      for (const record of records) { checked = await validate(record.identity); if (!checked.ok) return checked; }
      checked = await validate(snapshot.directoryIdentity);
      if (!checked.ok) return checked;
      return response(reason);
    });
  }

  async function release(request) {
    const parsed = releaseInput(request);
    if (!parsed.ok) return parsed;
    return exclusive('release', async () => {
      const held = snapshots.get(parsed.value);
      if (!held) return fail('SOURCE_DIRECTORY_SNAPSHOT_NOT_FOUND', 'The snapshot was not issued here or has already been released.');
      snapshots.delete(parsed.value); retainedBytes -= held.bytes;
      return success({ released: true, snapshotId: parsed.value });
    });
  }

  async function cleanup() {
    return exclusive('cleanup', async () => {
      const result = await closeOwned();
      return result.ok ? success({ closedDirectoryCount: result.value.closed ? 1 : 0, retainedOwnedDirectory: false }) : result;
    });
  }

  function diagnostics() {
    return { busy, operation, snapshotCount: snapshots.size, retainedBytes,
      maxSnapshots: SOURCE_DIRECTORY_MAX_SNAPSHOTS, retainedMaxBytes: SOURCE_DIRECTORY_RETAINED_MAX_BYTES,
      retainedOwnedDirectory: ownedDirectory !== null };
  }
  return success(Object.freeze({ scan, page, release, cleanup, diagnostics }));
}
