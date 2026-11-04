import { fileURLToPath } from 'node:url';
import { createSourcePolicy, SOURCE_FILE_MAX_BYTES } from './source-policy.mjs';
import { createSourceDirectoryBrowser, SOURCE_DIRECTORY_MAX_ENTRIES,
  SOURCE_DIRECTORY_PAGE_MAX_ENTRIES } from './source-directory.mjs';
import { createSourceContentReader, SOURCE_PAGE_MAX_LINES } from './source-content.mjs';
import { createSourceSearch, SOURCE_SEARCH_MAX_FILES, SOURCE_SEARCH_MAX_PAGES,
  SOURCE_SEARCH_MAX_READ_BYTES, SOURCE_SEARCH_MAX_MATCHES } from './source-search.mjs';
import { createNativeSourceClient } from './source-native-client.mjs';
import { resolveLocalRuntimes } from './local-runtimes.mjs';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const OUTPUT_MAX_BYTES = 32 * 1024;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const success = value => ({ ok: true, value });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const ownKeysOnly = (value, keys) => Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const rootId = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]{0,63}$' };
const relativePath = { type: 'string', maxLength: 32767,
  description: 'Relative POSIX source path; use an empty string for the configured root. JSON Schema length counts Unicode code points; the owner additionally enforces its UTF-16 and Windows path limits, physical ownership and exclusions.' };
const snapshotId = { type: 'string', minLength: 36, maxLength: 36,
  pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const integer = (minimum, maximum, fallback) => ({ type: 'integer', minimum, maximum,
  ...(fallback === undefined ? {} : { default: fallback }) });
const schema = (properties, required) => ({ $schema: DIALECT, type: 'object', properties,
  required, additionalProperties: false });
const descriptors = [
  { name: 'buildx_source_list_roots', description: 'List configured read-only source IDs and capability policy, without absolute paths or a claim that roots are currently available.', inputSchema: schema({}, []) },
  { name: 'buildx_source_scan_directory', description: 'Capture one bounded source directory metadata snapshot. Every raw entry consumes the scan budget; this does not read source content or recurse.',
    inputSchema: schema({ rootId, path: relativePath, maxEntries: integer(1, SOURCE_DIRECTORY_MAX_ENTRIES, 128) }, ['rootId', 'path']) },
  { name: 'buildx_source_directory_page', description: 'Read a metadata page from a snapshot issued by this source service, revalidating the directory and returned original entries.',
    inputSchema: schema({ snapshotId, offset: integer(0, Number.MAX_SAFE_INTEGER, 0),
      limit: integer(1, SOURCE_DIRECTORY_PAGE_MAX_ENTRIES, 50) }, ['snapshotId']) },
  { name: 'buildx_source_release_directory', description: 'Release one metadata snapshot issued by this source service. This does not modify source files.',
    inputSchema: schema({ snapshotId }, ['snapshotId']) },
  { name: 'buildx_source_read_file', description: 'Read a bounded UTF-8 source page with raw SHA256 provenance. Continuation requires expectedSha256; the original whole file is read for each page.',
    inputSchema: schema({ rootId, path: relativePath, startLine: integer(1, Number.MAX_SAFE_INTEGER, 1),
      maxLines: integer(1, SOURCE_PAGE_MAX_LINES, 80), expectedSha256: { type: 'string', minLength: 64,
        maxLength: 64, pattern: '^[a-fA-F0-9]{64}$' }, maxReadBytes: integer(0, SOURCE_FILE_MAX_BYTES, SOURCE_FILE_MAX_BYTES) }, ['rootId', 'path']) },
  { name: 'buildx_source_search', description: 'Search direct source files of one directory for a case-sensitive, nonempty literal, returning first hit per line. No regular expressions or recursion. Query is limited by the content owner to 128 UTF-16 units. Coverage is per-file verified history, not an atomic tree snapshot.',
    inputSchema: schema({ rootId, path: relativePath, query: { type: 'string', minLength: 1,
      maxLength: 128, pattern: '^[^\\u0000\\r\\n]+$',
      description: 'At most 128 UTF-16 code units in the search owner. JSON Schema maxLength counts Unicode code points; final business budget validation remains with the owner.' }, maxEntries: integer(1, SOURCE_DIRECTORY_MAX_ENTRIES, 128),
      maxFiles: integer(1, SOURCE_SEARCH_MAX_FILES, 8), maxPages: integer(1, SOURCE_SEARCH_MAX_PAGES, 16),
      maxReadBytes: integer(1, SOURCE_SEARCH_MAX_READ_BYTES, 1024 * 1024),
      maxMatches: integer(1, SOURCE_SEARCH_MAX_MATCHES, 20) }, ['rootId', 'path', 'query']) },
];
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  return Object.freeze(value);
}
export const SOURCE_TOOLS = deepFreeze(descriptors.map(descriptor => ({ ...descriptor,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })));
const contracts = new Map(SOURCE_TOOLS.map(tool => [tool.name, tool.inputSchema]));

// Validate the advertised primitive contract itself. Owner-specific physical
// paths, issued identity and cross-field requirements remain with their owners.
function validate(name, args) {
  const contract = contracts.get(name);
  if (!contract) return fail('UNKNOWN_SOURCE_TOOL', 'Select one exact registered source tool name.');
  try {
    if (!plain(args) || !ownKeysOnly(args, Object.keys(contract.properties))) throw new Error();
    const copy = {};
    for (const field of contract.required) if (!Object.hasOwn(args, field)) throw new Error();
    for (const field of Object.getOwnPropertyNames(args)) {
      const value = args[field], definition = contract.properties[field];
      if (definition.type === 'integer') {
        if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) throw new Error();
      } else {
        if (typeof value !== 'string') throw new Error();
        const length = Array.from(value).length;
        if ((definition.minLength !== undefined && length < definition.minLength) ||
            (definition.maxLength !== undefined && length > definition.maxLength) ||
            (definition.pattern && !new RegExp(definition.pattern, 'u').test(value))) throw new Error();
      }
      copy[field] = value;
    }
    return success(Object.freeze(copy));
  } catch { return fail('INVALID_SOURCE_TOOL_ARGUMENTS', 'Arguments must satisfy the named source tool contract, with no unknown fields.'); }
}

function bounded(result) {
  try {
    if (!plain(result) || typeof result.ok !== 'boolean') throw new Error();
    return jsonBytes(result) <= OUTPUT_MAX_BYTES ? result :
      fail('SOURCE_TOOLS_OUTPUT_TOO_LARGE', 'The complete domain result exceeded the 32 KiB output budget; no provenance was clipped.');
  } catch { return fail('SOURCE_TOOLS_INVALID_RESULT', 'The source owner did not return a serializable domain result.'); }
}
function outcome(result) {
  if (result?.ok === true) return { status: result.value?.completeness === 'partial' ? 'partial' : 'success' };
  const code = typeof result?.error?.code === 'string' && /^SOURCE_[A-Z_]{1,80}$/.test(result.error.code)
    ? result.error.code : 'SOURCE_TOOLS_OPERATION_FAILED';
  return { status: 'failed', code };
}
const labels = Object.freeze({ 'buildx-lib': 'BuildX application sources', 'buildx-revit': 'BuildX Revit sources',
  'buildx-prompts': 'BuildX application instructions', 'buildx-public': 'BuildX web interface',
  'argus-source': 'Argus recovered sources for research', 'aec-revit-source': 'AEC Revit sources for research',
  'aec-mcp-source': 'AEC MCP sources for research' });

/**
 * One internal source service. Public directory snapshots and transient native
 * clients are owned here; the live panel's Codex connection is never consumed.
 * close() first cancels an owned native pending request, then joins the active
 * invocation and cleans each resource independently. Failed cleanup retains the
 * exact object for an explicit close retry. No PID lookup or forced exit exists.
 */
export function createSourceTools(options = {}) {
  const invalid = () => fail('INVALID_SOURCE_TOOLS', 'A trusted source policy and optional native client factory are required.');
  let selectedPolicy, nativeFactory, policyInspect, policyRevalidate, maxFileBytes, rootIds;
  try {
    if (!plain(options) || !ownKeysOnly(options, ['policy', 'createNativeClient'])) return invalid();
    selectedPolicy = options.policy; nativeFactory = options.createNativeClient;
    if (selectedPolicy === undefined) {
      const created = createSourcePolicy(); if (!created.ok) return created;
      selectedPolicy = created.value;
    }
    policyInspect = selectedPolicy?.inspect; policyRevalidate = selectedPolicy?.revalidate;
    maxFileBytes = selectedPolicy?.maxFileBytes;
    const configuredRoots = selectedPolicy?.roots;
    if (!Array.isArray(configuredRoots)) return invalid();
    rootIds = configuredRoots.map(root => root.id);
    if (!rootIds.length || !rootIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id)) ||
        new Set(rootIds).size !== rootIds.length) return invalid();
  } catch { return invalid(); }
  if (typeof policyInspect !== 'function' || typeof policyRevalidate !== 'function' ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > SOURCE_FILE_MAX_BYTES ||
      (nativeFactory !== undefined && typeof nativeFactory !== 'function')) return invalid();
  const policy = Object.freeze({ inspect: policyInspect.bind(selectedPolicy),
    revalidate: policyRevalidate.bind(selectedPolicy), maxFileBytes });
  const launch = nativeFactory ?? (() => {
    let runtimes;
    try { runtimes = resolveLocalRuntimes(); }
    catch { return fail('SOURCE_TOOLS_RUNTIME_UNAVAILABLE', 'No unambiguous existing local Codex runtime was resolved; nothing was installed.'); }
    return createNativeSourceClient({ executable: runtimes.codex, cwd: projectRoot });
  });
  const createdDirectory = createSourceDirectoryBrowser({ policy });
  if (!createdDirectory.ok) return createdDirectory;
  const directory = createdDirectory.value, publicSnapshots = new Set();
  const configured = rootIds.map(id => Object.freeze({ id, label: labels[id] ?? id,
    availability: 'not_checked', capabilityPolicy: { directory: 'read_only', content: 'read_only', search: 'read_only' } }));
  let busy = false, closeRequested = false, state = 'open', activeDone = null, finishActive = null,
    ownedNative = null, retainedSearch = null, closingPromise = null, activeOutcome = null;

  function cleanupState() {
    return { ownedNativeClient: ownedNative !== null, ownedSearch: retainedSearch !== null,
      publicSnapshotCount: publicSnapshots.size, ownedDirectoryStream: directory.diagnostics().retainedOwnedDirectory };
  }
  const cleanupNeeded = () => ownedNative !== null || retainedSearch !== null || directory.diagnostics().retainedOwnedDirectory;
  function cleanupError(primary) {
    return fail('SOURCE_TOOLS_CLEANUP_UNCONFIRMED', 'Some source resources remain owned because final cleanup was not confirmed.',
      { resources: cleanupState(), ...(primary ? { primaryOutcome: outcome(primary) } : {}) });
  }

  async function closeNative(retry = false) {
    if (!ownedNative) return success({ closed: false });
    const owned = ownedNative;
    if (owned.closing) return owned.closing;
    if (owned.lastCloseFailure && !retry) return owned.lastCloseFailure;
    owned.closing = (async () => {
      let result;
      try { result = await owned.close(); } catch { result = null; }
      if (result?.ok === true && result.value?.closed === true) {
        if (ownedNative === owned) ownedNative = null;
        return success({ closed: true });
      }
      const failed = fail('SOURCE_NATIVE_CLEANUP_UNCONFIRMED', 'Closing the owned native source client was not confirmed.');
      owned.lastCloseFailure = failed;
      return failed;
    })();
    try { return await owned.closing; } finally { owned.closing = null; }
  }

  async function nativeRead(file, readOptions) {
    if (closeRequested) return fail('SOURCE_TOOLS_CLOSING', 'The source service is closing.');
    if (!ownedNative) {
      let made;
      try { made = await launch(Object.freeze({ cwd: projectRoot })); }
      catch { return fail('SOURCE_TOOLS_NATIVE_FACTORY_FAILED', 'The owned native source factory failed.'); }
      let madeOk, client;
      try { madeOk = made?.ok; client = made?.value; }
      catch { return fail('SOURCE_TOOLS_NATIVE_FACTORY_FAILED', 'The native source factory result could not be captured.'); }
      if (madeOk !== true || !client) return fail('SOURCE_TOOLS_NATIVE_FACTORY_FAILED', 'The owned native source factory did not create a client.');
      // Retain ownership before reading methods or awaiting the handshake.
      const owned = { client, close: async () => fail('SOURCE_NATIVE_CLEANUP_UNCONFIRMED', 'The client has no usable cleanup method.'),
        start: null, readFile: null, closing: null, lastCloseFailure: null };
      ownedNative = owned;
      try {
        const closeMethod = client.close;
        if (typeof closeMethod === 'function') owned.close = closeMethod.bind(client);
        const startMethod = client.start, readMethod = client.readFile;
        if (typeof closeMethod !== 'function' || typeof startMethod !== 'function' || typeof readMethod !== 'function')
          return fail('SOURCE_TOOLS_INVALID_NATIVE_CLIENT', 'The owned source client did not expose its named read-only lifecycle.');
        owned.start = startMethod.bind(client); owned.readFile = readMethod.bind(client);
      } catch { return fail('SOURCE_TOOLS_INVALID_NATIVE_CLIENT', 'The owned source client methods could not be captured.'); }
      if (closeRequested) return fail('SOURCE_TOOLS_CLOSING', 'The source service closed while the owned client was being created.');
      let started;
      try { started = await owned.start(); } catch { started = null; }
      if (started?.ok !== true) return fail('SOURCE_TOOLS_NATIVE_START_FAILED', 'The owned native source client did not initialize.');
    }
    const owned = ownedNative;
    if (closeRequested || !owned?.readFile) return fail('SOURCE_TOOLS_CLOSING', 'The source service is closing.');
    try { return await owned.readFile(file, readOptions); }
    catch { return fail('SOURCE_NATIVE_READ_FAILED', 'The owned native source read failed.'); }
  }

  const handlers = new Map([
    ['buildx_source_list_roots', async () => success({ schemaVersion: 1, roots: configured.map(root => ({ ...root,
      capabilityPolicy: { ...root.capabilityPolicy } })), availabilityChecked: false })],
    ['buildx_source_scan_directory', async args => {
      const result = await directory.scan(args);
      if (result.ok) publicSnapshots.add(result.value.snapshotId);
      return result;
    }],
    ['buildx_source_directory_page', async args => publicSnapshots.has(args.snapshotId) ? directory.page(args) :
      fail('SOURCE_TOOLS_SNAPSHOT_NOT_OWNED', 'The snapshot was not issued to this source service.')],
    ['buildx_source_release_directory', async args => {
      if (!publicSnapshots.has(args.snapshotId)) return fail('SOURCE_TOOLS_SNAPSHOT_NOT_OWNED', 'The snapshot was not issued to this source service.');
      const result = await directory.release(args);
      if (result.ok) publicSnapshots.delete(args.snapshotId);
      return result;
    }],
    ['buildx_source_read_file', async args => {
      const reader = createSourceContentReader({ policy, readFile: nativeRead });
      return reader.ok ? reader.value.read(args) : reader;
    }],
    ['buildx_source_search', async args => {
      const reader = createSourceContentReader({ policy, readFile: nativeRead });
      if (!reader.ok) return reader;
      const search = createSourceSearch({ directory, content: reader.value });
      if (!search.ok) return search;
      retainedSearch = search.value;
      const result = await retainedSearch.search(args);
      if (!retainedSearch.diagnostics().retainedOwnedSnapshot) retainedSearch = null;
      return result;
    }],
  ]);

  async function invoke(name, args) {
    const validated = validate(name, args);
    if (!validated.ok) return validated;
    if (closeRequested) return fail('SOURCE_TOOLS_CLOSED', 'The source service is closing or closed.');
    if (busy) return fail('SOURCE_TOOLS_BUSY', 'Another invocation owns this source service until cleanup completes.');
    if (cleanupNeeded()) return cleanupError();
    busy = true;
    activeDone = new Promise(resolve => { finishActive = resolve; });
    let result;
    try { result = await handlers.get(name)(validated.value); }
    catch { result = fail('SOURCE_TOOLS_OPERATION_FAILED', 'The source operation failed without returning source text.'); }
    finally {
      const cleaned = await closeNative(false);
      if (!cleaned.ok || cleanupNeeded()) result = cleanupError(result);
      else if (closeRequested) result = fail('SOURCE_TOOLS_CLOSING', 'The source service closed before this result could be published.',
        { primaryOutcome: outcome(result) });
      result = bounded(result); activeOutcome = outcome(result);
      busy = false; const done = finishActive; finishActive = null; activeDone = null; done();
    }
    return result;
  }

  async function close() {
    if (closingPromise) return closingPromise;
    closeRequested = true; state = 'closing';
    closingPromise = (async () => {
      const hadActive = busy;
      // Native close settles pending initialize/read before joining the active
      // operation. Its own bounded cleanup owns exact process handles.
      await closeNative(true);
      if (activeDone) await activeDone;
      const issues = [];
      if (ownedNative) issues.push({ resource: 'native_client', code: 'SOURCE_NATIVE_CLEANUP_UNCONFIRMED' });
      if (retainedSearch) {
        let result;
        try { result = await retainedSearch.cleanup(); } catch { result = null; }
        if (result?.ok === true && !retainedSearch.diagnostics().retainedOwnedSnapshot) retainedSearch = null;
        else issues.push({ resource: 'search_snapshot', code: 'SOURCE_SEARCH_CLEANUP_UNCONFIRMED' });
      }
      let releasedSnapshotCount = 0;
      for (const selected of [...publicSnapshots]) {
        let result;
        try { result = await directory.release({ snapshotId: selected }); } catch { result = null; }
        if (result?.ok === true && result.value?.released === true) { publicSnapshots.delete(selected); releasedSnapshotCount++; }
        else issues.push({ resource: 'public_snapshot', code: 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED' });
      }
      let cleaned;
      try { cleaned = await directory.cleanup(); } catch { cleaned = null; }
      if (cleaned?.ok !== true || directory.diagnostics().retainedOwnedDirectory)
        issues.push({ resource: 'directory_stream', code: 'SOURCE_DIRECTORY_CLEANUP_UNCONFIRMED' });
      const retained = cleanupState();
      if (issues.length || retained.ownedNativeClient || retained.ownedSearch || retained.publicSnapshotCount || retained.ownedDirectoryStream) {
        state = 'cleanup_pending';
        return bounded(fail('SOURCE_TOOLS_CLEANUP_UNCONFIRMED', 'Some source resources remain owned for an explicit close retry.',
          { resources: retained, cleanupIssues: issues, ...(hadActive ? { activeOutcome } : {}) }));
      }
      state = 'closed';
      return success({ closed: true, releasedSnapshotCount });
    })();
    try { return await closingPromise; } finally { closingPromise = null; }
  }

  const diagnostics = () => ({ state, busy, closeRequested, ...cleanupState() });
  return success(Object.freeze({ invoke, close, diagnostics }));
}
