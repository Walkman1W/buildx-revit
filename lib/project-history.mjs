import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const ok = value => ({ok: true, value});
const fail = (code, message) => ({ok: false, error: {code, message}});
const problem = (code, message) => Object.assign(new Error(message), {historyCode: code});
const id = stat => {
  if (stat.ino === 0n || stat.birthtimeNs === undefined) throw problem('HISTORY_IDENTITY_UNKNOWN', 'Filesystem identity is unavailable.');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');
const positive = value => Number.isSafeInteger(value) && value > 0;
const safeRelative = value => boundedString(value, 4096) && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
const containsPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const overlaps = (first, second) => containsPath(first, second) || containsPath(second, first);

// Validate before JSON serialization, including deeply nested or cyclic input.
function encodeSnapshot(value, budget) {
  const active = new Set(); let size = 0, count = 0;
  function visit(item, depth) {
    if (++count > 100000 || depth > 32) throw problem('HISTORY_SNAPSHOT_LIMIT', 'Snapshot structure exceeds the budget.');
    if (typeof item === 'string') size += Buffer.byteLength(item) * 6 + 2;
    else if (typeof item === 'number') { if (!Number.isFinite(item)) throw problem('HISTORY_SNAPSHOT_INVALID', 'Snapshot has a non-finite number.'); size += 32; }
    else if (item === null || typeof item === 'boolean') size += 5;
    else if (typeof item === 'object') {
      if (active.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw problem('HISTORY_SNAPSHOT_INVALID', 'Snapshot must be plain, acyclic JSON.');
      active.add(item); size += 2;
      for (const [key, child] of Object.entries(item)) { size += Buffer.byteLength(key) * 6 + 4; visit(child, depth + 1); }
      active.delete(item);
    } else throw problem('HISTORY_SNAPSHOT_INVALID', 'Snapshot must contain only JSON values.');
    if (size > budget) throw problem('HISTORY_SNAPSHOT_LIMIT', 'Snapshot exceeds the budget.');
  }
  visit(value, 0);
  return JSON.stringify(value);
}

/** Private append-only store. The host supplies an existing, private data root
 * and a verified stable account id. Disk access is not account authorization.
 * Any stale lock or malformed record fails closed and is never removed here.
 */
export function createProjectHistory({stateDirectory, accountId, maxEntries = 2000,
  maxTotalBytes = 128 * 1024 * 1024, maxSourceBytes = 2 * 1024 * 1024,
  maxSnapshotBytes = 12 * 1024 * 1024} = {}, dependencies = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory) || !boundedString(accountId, 512) ||
      ![maxEntries, maxTotalBytes, maxSourceBytes, maxSnapshotBytes].every(positive) ||
      maxEntries > 4096 || maxTotalBytes > 512 * 1024 * 1024 || maxSourceBytes > 2 * 1024 * 1024 || maxSnapshotBytes > 12 * 1024 * 1024 ||
      !dependencies || Object.keys(dependencies).some(key => !['open','opendir','link','unlink'].includes(key) || typeof dependencies[key] !== 'function'))
    return fail('HISTORY_CONFIG_INVALID', 'An absolute private data root, stable account and bounded budgets are required.');
  const root = path.resolve(stateDirectory), accountDir = path.join(root, `account-${hash(accountId)}`);
  const open = dependencies.open || fs.open, opendir = dependencies.opendir || fs.opendir, link = dependencies.link || fs.link, unlink = dependencies.unlink || fs.unlink;
  let queue = Promise.resolve(), retained = null, pending = 0;
  const handles = new Set(), stages = new Set();
  async function closeTracked(handle) { await handle.close(); handles.delete(handle); }
  async function usingTracked(handle, operation, preserveOnFailure = () => false) {
    let value, primary;
    try { value = await operation(); } catch (error) { primary = error; }
    if (primary && preserveOnFailure()) throw primary;
    try { await closeTracked(handle); } catch (error) {
      if (primary) throw primary;
      throw problem('HISTORY_CLOSE_UNCONFIRMED', 'A storage handle could not be closed.');
    }
    if (primary) throw primary;
    return value;
  }
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  async function inspectDirectory(dir) {
    const stat = await fs.lstat(dir, {bigint: true});
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(dir, await fs.realpath(dir)) !== '') throw problem('HISTORY_DIRECTORY_INVALID', 'Data directory is unavailable or redirected.');
    return id(stat);
  }
  async function prepare() {
    const rootId = await inspectDirectory(root);
    try { await fs.mkdir(accountDir, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const accountIdentity = await inspectDirectory(accountDir);
    if (rootId !== await inspectDirectory(root)) throw problem('HISTORY_DIRECTORY_CHANGED', 'Data directory identity changed.');
    return async () => {
      if (rootId !== await inspectDirectory(root) || accountIdentity !== await inspectDirectory(accountDir)) throw problem('HISTORY_DIRECTORY_CHANGED', 'Data directory identity changed.');
    };
  }
  async function locked(fn) {
    let handle, lockId, verify, value, primary;
    const lockPath = path.join(accountDir, '.project-history.lock');
    if (retained) return fail('HISTORY_CLEANUP_UNCONFIRMED', 'A previously owned lock requires cleanup retry.');
    try {
      verify = await prepare(); await verify();
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw problem('HISTORY_LOCKED', 'History is in use or has an unresolved lock.'); throw error; }
      lockId = id(await handle.stat({bigint: true}));
      if (id(await fs.lstat(lockPath, {bigint: true})) !== lockId) throw problem('HISTORY_LOCK_CHANGED', 'Lock identity changed.');
      await handle.writeFile(JSON.stringify({schema: 1, owner: randomUUID()}) + '\n'); await handle.sync(); await verify();
      value = await fn(verify);
    } catch (error) { primary = error; }
    if (handle) {
      retained = {handle, lockId, verify, lockPath, closed: false};
      try { await cleanupRetained(); }
      catch {
        if (primary) return {...fail(primary.historyCode || 'HISTORY_IO_ERROR', primary.historyCode ? primary.message : 'History storage failed.'), cleanupPending: true};
        return fail('HISTORY_CLEANUP_UNCONFIRMED', 'Lock cleanup could not be confirmed; retry cleanup without changing the lock.');
      }
    }
    if (primary) return fail(primary.historyCode || 'HISTORY_IO_ERROR', primary.historyCode ? primary.message : 'History storage failed.');
    return ok(value);
  }
  async function cleanupRetained() {
    const owner = retained; if (!owner) return;
    // Obtain a stage identity while its handle still exists, or preserve it.
    for (const stage of stages) if (!stage.identity && stage.handle && handles.has(stage.handle)) {
      try {
        const candidate = id(await stage.handle.stat({bigint:true}));
        if (id(await fs.lstat(stage.path, {bigint:true})) === candidate) stage.identity = candidate;
      } catch { /* Unknown identity must remain blocked. */ }
    }
    if ([...stages].some(stage => !stage.identity)) throw problem('HISTORY_STAGE_IDENTITY_UNKNOWN', 'Staged file ownership is unknown.');
    for (const resource of [...handles]) await closeTracked(resource);
    for (const stage of [...stages]) await cleanupStage(stage, owner.verify);
    if (!owner.closed) {
      try { if (!owner.lockId || id(await owner.handle.stat({bigint: true})) !== owner.lockId) owner.noUnlink = true; }
      catch { owner.noUnlink = true; }
      await owner.handle.close(); owner.closed = true;
    }
    await owner.verify();
    if (owner.noUnlink || !owner.lockId || id(await fs.lstat(owner.lockPath, {bigint: true})) !== owner.lockId) throw problem('HISTORY_LOCK_CHANGED', 'Lock ownership cannot be confirmed.');
    await unlink(owner.lockPath); retained = null;
  }
  async function cleanupStage(stage, verify) {
    await verify();
    if (!stage.identity) throw problem('HISTORY_STAGE_IDENTITY_UNKNOWN', 'Staged file ownership is unknown.');
    let staged = null, published = null;
    try { staged = await fs.lstat(stage.path, {bigint:true}); }
    catch (error) { if (error.code !== 'ENOENT' || !stage.unlinkAttempted) throw error; }
    if (staged && (staged.isSymbolicLink() || !staged.isFile() || id(staged) !== stage.identity)) throw problem('HISTORY_STAGE_CHANGED', 'Staged file identity changed.');
    if (stage.publicationAttempted) {
      try { published = await fs.lstat(stage.file, {bigint:true}); }
      catch (error) { if (error.code !== 'ENOENT' || stage.finalObserved) throw error; }
      if (published && (published.isSymbolicLink() || !published.isFile() || id(published) !== stage.identity)) throw problem('HISTORY_STAGE_CHANGED', 'Published record identity changed.');
      if (published) stage.finalObserved = true;
    }
    if (staged && staged.nlink !== (published ? 2n : 1n)) throw problem('HISTORY_STAGE_CHANGED', 'Staged file links cannot be confirmed.');
    if (staged) { await verify(); stage.unlinkAttempted = true; await unlink(stage.path); }
    await verify();
    if (published) {
      const final = await fs.lstat(stage.file, {bigint:true});
      if (id(final) !== stage.identity || final.nlink !== 1n || final.size !== stage.size) throw problem('HISTORY_WRITE_UNKNOWN', 'Published record could not be confirmed.');
    }
    stages.delete(stage);
  }
  async function inventory(verify) {
    const stream = await opendir(accountDir); handles.add(stream);
    let total = 0, examined = 0; const names = [];
    await usingTracked(stream, async () => { while (true) {
      const entry = await stream.read(); if (!entry) break;
      if (++examined > maxEntries + 1) throw problem('HISTORY_CAPACITY', 'History entry budget reached.');
      if (entry.name === '.project-history.lock') continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^(?:b-[0-9]{10}|v-[a-f0-9]{64}-[a-f0-9]{64})\.json$/.test(entry.name)) throw problem('HISTORY_UNEXPECTED_ENTRY', 'Unexpected history entry; no changes made.');
      const stat = await fs.lstat(path.join(accountDir, entry.name), {bigint: true});
      if (!stat.isFile() || stat.nlink !== 1n) throw problem('HISTORY_ENTRY_CHANGED', 'History entry identity cannot be confirmed.');
      total += Number(stat.size); names.push(entry.name);
      if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw problem('HISTORY_CAPACITY', 'History byte budget reached.');
    } });
    await verify(); return {names, total};
  }
  async function readRecord(name, verify) {
    const file = path.join(accountDir, name), named = await fs.lstat(file, {bigint: true});
    const maxRecordBytes = maxSnapshotBytes * 6 + Math.ceil(maxSourceBytes / 3) * 4 + 16384;
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > BigInt(Math.min(maxTotalBytes, maxRecordBytes))) throw problem('HISTORY_ENTRY_CHANGED', 'History record cannot be verified.');
    const handle = await open(file, 'r'); handles.add(handle);
    return usingTracked(handle, async () => {
      const before = await handle.stat({bigint: true});
      if (id(before) !== id(named) || before.size !== named.size) throw problem('HISTORY_ENTRY_CHANGED', 'History record changed.');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw problem('HISTORY_RECORD_INVALID', 'Incomplete history record.'); offset += result.bytesRead; }
      const after = await handle.stat({bigint: true}), current = await fs.lstat(file, {bigint: true});
      if (id(after) !== id(before) || id(current) !== id(before) || after.size !== before.size || current.size !== before.size || after.mtimeNs !== before.mtimeNs || current.mtimeNs !== before.mtimeNs) throw problem('HISTORY_ENTRY_CHANGED', 'History record changed.');
      await verify();
      try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
      catch { throw problem('HISTORY_RECORD_INVALID', 'History record is incomplete or invalid.'); }
    });
  }
  async function writeRecord(name, record, stats, verify) {
    const bytes = Buffer.from(JSON.stringify(record));
    if (stats.names.length >= maxEntries || stats.total + bytes.length > maxTotalBytes) throw problem('HISTORY_CAPACITY', 'History storage budget reached.');
    await verify();
    const file = path.join(accountDir, name), stagePath = path.join(accountDir, `pending-${randomUUID()}.json`);
    const stage = {path:stagePath, file, identity:null, handle:null, size:BigInt(bytes.length), publicationAttempted:false, finalObserved:false, unlinkAttempted:false};
    stages.add(stage);
    const handle = await open(stagePath, 'wx', 0o600); stage.handle = handle; handles.add(handle);
    await usingTracked(handle, async () => {
      const identity = id(await handle.stat({bigint: true}));
      if (id(await fs.lstat(stagePath, {bigint: true})) !== identity) throw problem('HISTORY_WRITE_UNKNOWN', 'Record ownership changed.');
      stage.identity = identity;
      await handle.writeFile(bytes); await handle.sync(); await verify();
      const after = await handle.stat({bigint: true}), named = await fs.lstat(stagePath, {bigint: true});
      if (id(after) !== identity || id(named) !== identity || after.size !== BigInt(bytes.length) || named.size !== after.size) throw problem('HISTORY_WRITE_UNKNOWN', 'Record write could not be confirmed.');
    }, () => !stage.identity);
    await verify();
    if (id(await fs.lstat(stagePath, {bigint:true})) !== stage.identity) throw problem('HISTORY_WRITE_UNKNOWN', 'Staged record identity changed.');
    stage.publicationAttempted = true;
    await link(stagePath, file); await verify();
    if (id(await fs.lstat(stagePath, {bigint:true})) !== stage.identity || id(await fs.lstat(file, {bigint:true})) !== stage.identity) throw problem('HISTORY_WRITE_UNKNOWN', 'Published record identity changed.');
    stage.finalObserved = true;
    await cleanupStage(stage, verify);
  }
  const admit = () => { if (pending >= 4) return false; pending++; return true; };
  const finish = promise => promise.finally(() => { pending--; });
  const run = fn => admit() ? finish(serial(() => locked(fn))) : Promise.resolve(fail('HISTORY_BUSY', 'History operation queue is full.'));
  const bind = ({projectId, rootPath} = {}) => {
    if (!boundedString(projectId, 200) || typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) return Promise.resolve(fail('HISTORY_BIND_INVALID', 'Project and absolute selected directory are required.'));
    if (!admit()) return Promise.resolve(fail('HISTORY_BUSY', 'History operation queue is full.'));
    const selected = path.resolve(rootPath);
    return finish(serial(async () => {
      // Check before creating the account directory or lock so an invalid
      // binding cannot itself create history files under the selected source.
      try {
        await inspectDirectory(root); await inspectDirectory(selected);
        if (overlaps(root, selected)) return fail('HISTORY_ROOT_OVERLAP', 'The selected directory and history data directory must be separate.');
      } catch { return fail('HISTORY_ROOT_UNAVAILABLE', 'The selected or history directory could not be verified.'); }
      return locked(async verify => {
    const rootIdentity = await inspectDirectory(selected);
    await verify();
    if (overlaps(root, selected)) throw problem('HISTORY_ROOT_OVERLAP', 'The selected directory and history data directory must be separate.');
    const stats = await inventory(verify);
    const names = stats.names.filter(name => name.startsWith('b-')).sort();
    const sequence = names.length ? Number(names.at(-1).slice(2, 12)) + 1 : 1;
    if (sequence > 9999999999) throw problem('HISTORY_CAPACITY', 'Binding sequence exhausted.');
    const record = {schema: 1, kind: 'binding', sequence, projectId, rootPath: selected, rootIdentity};
    if (rootIdentity !== await inspectDirectory(selected)) throw problem('HISTORY_ROOT_CHANGED', 'Selected directory identity changed.');
    await writeRecord(`b-${String(sequence).padStart(10, '0')}.json`, record, stats, verify);
    return {projectId, rootPath: selected};
  }); })); };
  const currentBinding = () => run(async verify => {
    const stats = await inventory(verify), names = stats.names.filter(name => name.startsWith('b-')).sort();
    if (!names.length) return null;
    const record = await readRecord(names.at(-1), verify);
    if (record?.schema !== 1 || record.kind !== 'binding' || record.sequence !== Number(names.at(-1).slice(2, 12)) || !boundedString(record.projectId, 200) || typeof record.rootPath !== 'string' || !path.isAbsolute(record.rootPath) || typeof record.rootIdentity !== 'string') throw problem('HISTORY_RECORD_INVALID', 'Binding record is invalid.');
    let current; try { current = await inspectDirectory(record.rootPath); } catch { throw problem('HISTORY_ROOT_UNAVAILABLE', 'Saved directory is unavailable or redirected.'); }
    if (current !== record.rootIdentity) throw problem('HISTORY_ROOT_CHANGED', 'Saved directory identity changed; explicit rebinding is required.');
    await verify();
    if (overlaps(root, record.rootPath)) throw problem('HISTORY_ROOT_OVERLAP', 'The saved directory and history data directory must be separate.');
    return {projectId: record.projectId, rootPath: record.rootPath};
  });
  const nameFor = (projectId, relative, sha256) => `v-${hash(projectId)}-${hash(relative + '\0' + sha256)}.json`;
  const validateRef = (projectId, relative, sha256) => {
    if (!boundedString(projectId, 200) || !safeRelative(relative) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw problem('HISTORY_REFERENCE_INVALID', 'Exact project, relative path and SHA-256 are required.');
  };
  function decodeVersion(record, projectId, relative, sha256) {
    if (record?.schema !== 1 || record.kind !== 'version' || record.projectId !== projectId || record.path !== relative || record.sha256 !== sha256 || typeof record.source !== 'string' || typeof record.snapshot !== 'string' || typeof record.snapshotHash !== 'string' || record.source.length > Math.ceil(maxSourceBytes / 3) * 4 || Buffer.byteLength(record.snapshot) > maxSnapshotBytes) throw problem('HISTORY_RECORD_INVALID', 'Version record is invalid.');
    const source = Buffer.from(record.source, 'base64');
    if (source.length > maxSourceBytes || source.toString('base64') !== record.source || hash(source) !== sha256 || hash(record.snapshot) !== record.snapshotHash) throw problem('HISTORY_RECORD_INVALID', 'Version content failed integrity verification.');
    let snapshot; try { snapshot = JSON.parse(record.snapshot); } catch { throw problem('HISTORY_RECORD_INVALID', 'Parsed snapshot is invalid.'); }
    return {projectId, path: relative, sha256, source, snapshot};
  }
  const saveVersion = ({projectId, path: relative, sha256, source, snapshot} = {}) => {
    if (!Buffer.isBuffer(source) || source.length > maxSourceBytes) return Promise.resolve(fail('HISTORY_SOURCE_INVALID', 'Source bytes are invalid or exceed the budget.'));
    if (!admit()) return Promise.resolve(fail('HISTORY_BUSY', 'History operation queue is full.'));
    let copy, encoded;
    try { copy = Buffer.from(source); encoded = encodeSnapshot(snapshot, maxSnapshotBytes); }
    catch (error) { pending--; return Promise.resolve(fail(error.historyCode || 'HISTORY_SNAPSHOT_INVALID', error.historyCode ? error.message : 'Snapshot is invalid.')); }
    return finish(serial(() => locked(async verify => {
    validateRef(projectId, relative, sha256);
    if (hash(copy) !== sha256) throw problem('HISTORY_SOURCE_INVALID', 'Source bytes do not match the specified SHA-256.');
    const name = nameFor(projectId, relative, sha256), stats = await inventory(verify);
    if (stats.names.includes(name)) {
      const existing = decodeVersion(await readRecord(name, verify), projectId, relative, sha256);
      if (JSON.stringify(existing.snapshot) !== encoded) throw problem('HISTORY_VERSION_CONFLICT', 'The same source version has a different parsed snapshot.');
      return {projectId, path: relative, sha256, existing: true};
    }
    await writeRecord(name, {schema: 1, kind: 'version', projectId, path: relative, sha256, source: copy.toString('base64'), snapshot: encoded, snapshotHash: hash(encoded)}, stats, verify);
    return {projectId, path: relative, sha256, existing: false};
  }))); };
  const readVersion = ({projectId, path: relative, sha256} = {}) => run(async verify => {
    validateRef(projectId, relative, sha256); const stats = await inventory(verify), name = nameFor(projectId, relative, sha256);
    if (!stats.names.includes(name)) throw problem('HISTORY_VERSION_UNAVAILABLE', 'This exact version is unavailable.');
    return decodeVersion(await readRecord(name, verify), projectId, relative, sha256);
  });
  const cleanup = () => admit() ? finish(serial(async () => {
    try { await cleanupRetained(); return ok({clean: true}); }
    catch { return fail('HISTORY_CLEANUP_UNCONFIRMED', 'Owned lock cleanup remains unconfirmed.'); }
  })) : Promise.resolve(fail('HISTORY_BUSY', 'History operation queue is full.'));
  return ok(Object.freeze({bind, currentBinding, saveVersion, readVersion, cleanup}));
}
