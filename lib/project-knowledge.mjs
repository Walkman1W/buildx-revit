import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseProjectDocument} from './parse-project-document.mjs';
import {readAsciiDxf} from './cad-dxf-reader.mjs';

// This service is owned by the panel process. Binding a root is a trusted UI
// operation; callers of search/read never supply a filesystem path to open.
const success = value => ({ok: true, value});
const fail = (code, message) => ({ok: false, error: {code, message}});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
const identity = stat => [stat.dev, stat.ino, stat.birthtimeNs].join(':');
const supported = new Set(['.txt', '.md', '.csv', '.docx', '.pdf', '.xlsx', '.dxf']);
const namedFormats = new Set(['.dwg']);
const textDecoder = new TextDecoder('utf-8', {fatal: true});
const positive = n => Number.isSafeInteger(n) && n > 0;

function csvRows(text) {
  const rows = [], row = []; let field = '', quoted = false, afterQuote = false;
  const cell = () => { row.push(field); field = ''; afterQuote = false; };
  const line = () => { cell(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else field += c;
    } else if (afterQuote && c !== ',' && c !== '\r' && c !== '\n') throw new Error('invalid CSV quote');
    else if (c === '"') { if (field) throw new Error('invalid CSV quote'); quoted = true; }
    else if (c === ',') cell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; line(); }
    else field += c;
    if (row.length > 10000 || rows.length > 100000) throw new Error('CSV capacity');
  }
  if (quoted) throw new Error('unclosed CSV quote');
  if (field || row.length || afterQuote) line();
  return rows;
}

/** Bounded, read-only project index. Refresh is explicit; a host may schedule it.
 * Without a history owner, versions live only in this process. With an injected
 * owner, publication follows a successful durable save; restore is explicit.
 * A missing version is never substituted with current data.
 * Metadata-based reuse is an optimization, not a cryptographic freshness proof.
 * Filesystem checks reduce but cannot eliminate races with same-user processes.
 */
export function createProjectKnowledge({projectId, rootPath, maxFiles = 500, maxEntries = 3000,
  maxDepth = 16, maxFileBytes = 2 * 1024 * 1024, maxIndexBytes = 32 * 1024 * 1024,
  pythonExecutable = 'python', history = null} = {}) {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200 ||
      typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0') ||
      typeof pythonExecutable !== 'string' || !pythonExecutable ||
      ![maxFiles, maxEntries, maxDepth, maxFileBytes, maxIndexBytes].every(positive) ||
      history !== null && (typeof history?.saveVersion !== 'function' || typeof history?.readVersion !== 'function'))
    return fail('INVALID_PROJECT_KNOWLEDGE', 'A project identity, absolute selected directory and positive budgets are required.');
  const root = path.resolve(rootPath), versions = new Map();
  let current = new Map(), rootIdentity = null, retainedBytes = 0, busy = false, lastCoverage = null;
  const publicFile = entry => ({projectId, path: entry.path, format: entry.format, status: entry.status,
    sha256: entry.sha256 ?? null, byteLength: entry.byteLength ?? null,
    ...(entry.status === 'indexed' ? {persistence: history ? 'durable' : 'session'} : {}),
    discipline: null, applicability: null, ...(entry.issue ? {issue: entry.issue} : {}),
    ...(entry.persistenceIssue ? {persistenceIssue: entry.persistenceIssue} : {}),
    ...(entry.warnings?.length ? {warnings: entry.warnings} : {}), ...(entry.sheets ? {sheets: entry.sheets} : {})});
  const inside = target => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
  async function checkRoot() {
    const stat = await fs.lstat(root, {bigint: true}), real = await fs.realpath(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, real) !== '') throw new Error('root');
    const id = identity(stat); if (rootIdentity && rootIdentity !== id) throw new Error('root changed');
    rootIdentity = id;
  }
  async function readCandidate(absolute, stat) {
    const real = await fs.realpath(absolute);
    if (!inside(real) || path.relative(absolute, real) !== '') throw new Error('path changed');
    const handle = await fs.open(absolute, 'r');
    try {
      const before = await handle.stat({bigint: true});
      if (!before.isFile() || before.nlink > 1n || fingerprint(before) !== fingerprint(stat)) throw new Error('identity changed');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new Error('short read'); offset += result.bytesRead; }
      const after = await handle.stat({bigint: true}), pathAfter = await fs.lstat(absolute, {bigint: true});
      if (pathAfter.isSymbolicLink() || fingerprint(before) !== fingerprint(after) || fingerprint(before) !== fingerprint(pathAfter) || path.relative(absolute, await fs.realpath(absolute)) !== '') throw new Error('identity changed');
      return bytes;
    } finally { await handle.close(); }
  }
  async function refresh(options = {}) {
    if (options?.isCancelled !== undefined && typeof options.isCancelled !== 'function') return fail('INVALID_KNOWLEDGE_CANCEL', 'The cancellation callback must be a function.');
    if (busy) return fail('KNOWLEDGE_BUSY', 'A project refresh is already running.');
    const cancellation = Symbol('knowledge-refresh-cancelled');
    const checkCancelled = () => {
      if (!options?.isCancelled) return;
      let cancelled;
      try { cancelled = options.isCancelled(); } catch { throw cancellation; }
      if (cancelled !== false) throw cancellation;
    };
    const stagedVersions = new Map(); let stagedBytes = 0, persistenceAttempts = 0, persistedVersions = 0;
    busy = true;
    try {
      checkCancelled();
      try { await checkRoot(); } catch { checkCancelled(); return fail('KNOWLEDGE_ROOT_UNAVAILABLE', 'The selected directory is unavailable or its identity changed.'); }
      checkCancelled();
      const next = new Map(), coverage = {complete: true, examinedEntries: 0, skippedEntries: 0, indexedFiles: 0};
      let stop = false;
      const skip = () => { coverage.complete = false; coverage.skippedEntries++; };
      async function visit(dir, rel, depth) {
        checkCancelled();
        if (depth > maxDepth) { skip(); return; }
        let stream;
        try { stream = await fs.opendir(dir); }
        catch { checkCancelled(); skip(); return; }
        try {
          for await (const entry of stream) {
            checkCancelled();
            if (coverage.examinedEntries >= maxEntries || next.size >= maxFiles) { skip(); stop = true; break; }
            coverage.examinedEntries++;
            const name = entry.name;
            if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) { skip(); continue; }
            const relative = rel ? rel + '/' + name : name, absolute = path.join(dir, name);
            try {
              const stat = await fs.lstat(absolute, {bigint: true});
              if (stat.isSymbolicLink()) { skip(); continue; }
              const real = await fs.realpath(absolute);
              if (!inside(real) || path.relative(absolute, real) !== '') { skip(); continue; }
              if (stat.isDirectory()) { await visit(absolute, relative, depth + 1); if (stop) break; continue; }
              if (!stat.isFile() || stat.nlink > 1n) { skip(); continue; }
              const format = path.extname(name).toLowerCase();
              let record = {path: relative, format: format.slice(1) || 'unknown', byteLength: Number(stat.size), fingerprint: fingerprint(stat)};
              if (!supported.has(format)) {
                record.status = 'unsupported'; record.issue = namedFormats.has(format) ? 'FORMAT_NOT_CONNECTED' : 'FORMAT_UNSUPPORTED';
              } else if (stat.size > BigInt(maxFileBytes)) { record.status = 'too-large'; record.issue = 'FILE_BYTE_LIMIT'; }
              else {
                const previous = current.get(relative);
                if (previous?.fingerprint === record.fingerprint && previous.status === 'indexed') record = previous;
                else {
                  const bytes = await readCandidate(absolute, stat), sha256 = digest(bytes);
                  checkCancelled();
                  let text, rows, document;
                  if (format === '.dxf') {
                    const parsed = readAsciiDxf(bytes, {sourceName: relative});
                    if (!parsed.ok) { record.status = 'error'; record.issue = parsed.error.code; }
                    else {
                      document = {segments: parsed.value.entities.filter(entity => entity.textFact?.status === 'raw').map(entity => ({
                        text: entity.textFact.raw, location: {entityType: entity.type, ordinal: entity.ordinal, sourceLine: entity.sourceLine,
                          handle: entity.handle, layer: entity.layer, layout: entity.textFact.layout},
                        representation: entity.textFact.representation, formattingInterpreted: false})),
                      warnings: ['DXF_ASCII_DIRECT_ENTITIES_ONLY', 'DXF_LITERAL_TEXT_FORMATTING_NOT_INTERPRETED',
                        'DXF_BLOCKS_EXTERNAL_REFERENCES_AND_GEOMETRY_NOT_INTERPRETED']};
                      if (parsed.value.entities.some(entity => entity.textFact?.status === 'invalid'))
                        document.warnings.push('DXF_INVALID_TEXT_ENTITY_SKIPPED');
                      record.warnings = document.warnings;
                    }
                  } else if (['.docx', '.xlsx', '.pdf'].includes(format)) {
                    const parsed = await parseProjectDocument(bytes, format.slice(1), pythonExecutable);
                    if (!parsed.ok) { record.status = 'error'; record.issue = parsed.error.code; }
                    else { document = parsed.value; record.warnings = document.warnings; record.sheets = document.sheets; }
                  } else {
                    try { text = textDecoder.decode(bytes); if (text.includes('\0')) throw new Error('binary'); if (format === '.csv') rows = csvRows(text); }
                    catch { record.status = 'error'; record.issue = format === '.csv' ? 'INVALID_UTF8_OR_CSV' : 'INVALID_UTF8_OR_TEXT'; }
                  }
                  checkCancelled();
                  if ((text !== undefined || document) && !record.issue) {
                    const key = relative + '\0' + sha256, existing = versions.get(key) || stagedVersions.get(key);
                    const parsed = existing || {text, rows, document};
                    // Charge the serialized expansion before retaining or cloning it.
                    // JSON owns the on-disk representation and omits absent optional fields.
                    const serialized = JSON.stringify({schema: 1, format: format.slice(1), ...parsed});
                    const charge = bytes.length + Buffer.byteLength(serialized);
                    if (!existing && retainedBytes + stagedBytes + charge > maxIndexBytes) { record.status = 'error'; record.issue = 'INDEX_RETENTION_LIMIT'; }
                    else {
                      let persisted = success(null);
                      if (history) {
                        const saved = JSON.parse(serialized);
                        persistenceAttempts++;
                        try { persisted = await history.saveVersion({projectId, path: relative, sha256, source: bytes, snapshot: saved}); }
                        catch { persisted = fail('HISTORY_IO_ERROR', 'History storage failed.'); }
                        if (persisted?.ok === true) persistedVersions++;
                        checkCancelled();
                      }
                      if (persisted?.ok !== true) {
                        record.status = 'error'; record.issue = 'HISTORY_PERSISTENCE_FAILED';
                        if (typeof persisted?.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(persisted.error.code)) record.persistenceIssue = persisted.error.code;
                      } else {
                        if (!existing) { stagedVersions.set(key, parsed); stagedBytes += charge; }
                        record = {...record, status: 'indexed', sha256};
                      }
                    }
                  }
                }
              }
              next.set(relative, record);
              if (record.status === 'indexed') coverage.indexedFiles++;
            } catch (error) { if (error === cancellation) throw error; checkCancelled(); next.set(relative, {path: relative, format: path.extname(name).slice(1).toLowerCase(), status: 'error', issue: 'READ_OR_IDENTITY_FAILED'}); skip(); }
          }
        } catch (error) { if (error === cancellation) throw error; checkCancelled(); skip(); }
      }
      await visit(root, '', 0);
      checkCancelled();
      try { await checkRoot(); } catch { checkCancelled(); return fail('KNOWLEDGE_ROOT_CHANGED', 'Directory identity changed during refresh; the previous index is retained.'); }
      checkCancelled();
      // An incomplete traversal cannot establish deletion for unseen entries.
      if (!coverage.complete) for (const [key, value] of current) if (!next.has(key)) next.set(key, {...value, status: 'unverified', issue: 'SCAN_INCOMPLETE'});
      checkCancelled();
      for (const [key, value] of stagedVersions) versions.set(key, value);
      retainedBytes += stagedBytes; current = next; lastCoverage = coverage;
      return success({projectId, coverage: {...coverage}, files: current.size, retainedBytes});
    } catch (error) {
      if (error === cancellation) return {...fail('KNOWLEDGE_CANCELLED', 'Project refresh was cancelled; the previous index remains current.'), persistedVersions, persistenceUnconfirmed: persistenceAttempts - persistedVersions};
      throw error;
    } finally { busy = false; }
  }
  function list() { return success({projectId, files: [...current.values()].map(publicFile), coverage: lastCoverage && {...lastCoverage}, refreshing: busy}); }
  function snapshot(relative, sha256) {
    if (typeof relative !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return fail('INVALID_KNOWLEDGE_REFERENCE', 'A relative indexed path and SHA-256 version are required.');
    const item = versions.get(relative + '\0' + sha256);
    return item ? success(item) : fail('KNOWLEDGE_VERSION_UNAVAILABLE', 'This exact source version is not retained in the current service session.');
  }
  async function restoreVersion({path: relative, sha256} = {}) {
    if (typeof relative !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return fail('INVALID_KNOWLEDGE_REFERENCE', 'A relative indexed path and SHA-256 version are required.');
    if (versions.has(relative + '\0' + sha256)) return success({projectId, path: relative, sha256, restored: false});
    if (!history) return fail('KNOWLEDGE_VERSION_UNAVAILABLE', 'No durable history owner is available.');
    if (busy) return fail('KNOWLEDGE_BUSY', 'Another project operation is running.');
    busy = true;
    try {
      let result;
      try { result = await history.readVersion({projectId, path: relative, sha256}); }
      catch { return fail('KNOWLEDGE_HISTORY_UNAVAILABLE', 'The exact history version could not be read.'); }
      if (result?.ok !== true) return fail(result?.error?.code === 'HISTORY_VERSION_UNAVAILABLE' ? 'KNOWLEDGE_VERSION_UNAVAILABLE' : 'KNOWLEDGE_HISTORY_UNAVAILABLE', 'The exact history version could not be read.');
      const value = result.value, saved = value?.snapshot, format = path.extname(relative).slice(1).toLowerCase();
      if (value?.projectId !== projectId || value.path !== relative || value.sha256 !== sha256 || !Buffer.isBuffer(value.source) || value.source.length > maxFileBytes || digest(value.source) !== sha256 ||
          !saved || saved.schema !== 1 || saved.format !== format || !supported.has('.' + format) ||
          (saved.document ? typeof saved.document !== 'object' || !Array.isArray(saved.document.segments) || saved.document.segments.length > 50000 || saved.document.segments.some(segment => !segment || typeof segment.text !== 'string' || !segment.location || typeof segment.location !== 'object') || !Array.isArray(saved.document.warnings) || (saved.document.sheets !== undefined && (!Array.isArray(saved.document.sheets) || saved.document.sheets.some(sheet => typeof sheet !== 'string'))) : typeof saved.text !== 'string') ||
          (format === 'csv' && (!Array.isArray(saved.rows) || saved.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string')))))
        return fail('KNOWLEDGE_HISTORY_INVALID', 'The saved version or parsed facts are invalid.');
      const charge = value.source.length + Buffer.byteLength(JSON.stringify(saved));
      if (retainedBytes + charge > maxIndexBytes) return fail('INDEX_RETENTION_LIMIT', 'The restored version exceeds the in-memory retention budget.');
      versions.set(relative + '\0' + sha256, {text: saved.text, rows: saved.rows, document: saved.document});
      retainedBytes += charge;
      return success({projectId, path: relative, sha256, restored: true});
    } finally { busy = false; }
  }
  function read({path: relative, sha256, startLine = 1, maxLines = 50} = {}) {
    if (!positive(startLine) || !positive(maxLines) || maxLines > 100) return fail('INVALID_KNOWLEDGE_PAGE', 'Use a positive start line and at most 100 lines.');
    const found = snapshot(relative, sha256); if (!found.ok) return found;
    const lines = found.value.document ? found.value.document.segments : found.value.text.split(/\r\n|\r|\n/).map((text, i) => ({text, location: {line: i + 1}})), selected = [];
    let chars = 0;
    for (let i = startLine - 1; i < lines.length && selected.length < maxLines; i++) {
      if (lines[i].text.length > 8000 || chars + lines[i].text.length > 16000) break;
      selected.push({line: i + 1, ...lines[i]}); chars += lines[i].text.length;
    }
    if (!selected.length && startLine <= lines.length) return fail('KNOWLEDGE_LINE_TOO_LARGE', 'The requested line exceeds the output budget.');
    const nextLine = startLine - 1 + selected.length < lines.length ? startLine + selected.length : null;
    return success({projectId, path: relative, sha256, lines: selected, nextLine, historical: current.get(relative)?.sha256 !== sha256});
  }
  function search({query, limit = 20} = {}) {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 1024 || !positive(limit) || limit > 100) return fail('INVALID_KNOWLEDGE_QUERY', 'A nonempty query and limit of 1 to 100 are required.');
    const needle = query.toLowerCase(), matches = []; let examined = 0, matchCount = 0, skipped = 0, partial = 0;
    for (const entry of current.values()) {
      if (entry.status !== 'indexed') { skipped++; continue; }
      const item = versions.get(entry.path + '\0' + entry.sha256); if (!item) { skipped++; continue; }
      examined++;
      if (entry.warnings?.length) partial++;
      if (item.document) {
        for (const segment of item.document.segments) {
          const pos = segment.text.toLowerCase().indexOf(needle); if (pos < 0) continue;
          matchCount++; if (matches.length < limit) matches.push({path: entry.path, sha256: entry.sha256, location: segment.location, snippet: segment.text.slice(Math.max(0, pos - 60), pos + 180)});
        }
      } else if (entry.format === 'csv') {
        for (let r = 0; r < item.rows.length; r++) for (let c = 0; c < item.rows[r].length; c++) {
          const text = item.rows[r][c], pos = text.toLowerCase().indexOf(needle); if (pos < 0) continue;
          matchCount++; if (matches.length < limit) matches.push({path: entry.path, sha256: entry.sha256, location: {row: r + 1, column: c + 1}, snippet: text.slice(Math.max(0, pos - 60), pos + 180)});
        }
      } else for (const [i, text] of item.text.split(/\r\n|\r|\n/).entries()) {
        const pos = text.toLowerCase().indexOf(needle); if (pos < 0) continue;
        matchCount++; if (matches.length < limit) matches.push({path: entry.path, sha256: entry.sha256, location: {line: i + 1}, snippet: text.slice(Math.max(0, pos - 60), pos + 180)});
      }
    }
    return success({projectId, query, matches, matchCount, coverage: {examined, skipped, partial, scanComplete: lastCoverage?.complete === true, complete: lastCoverage?.complete === true && skipped === 0 && partial === 0, matchesTruncated: matchCount > matches.length}, freshness: 'last_refresh'});
  }
  function table({path: relative, sha256, sheet, column, equals, sumColumn} = {}) {
    const found = snapshot(relative, sha256); if (!found.ok) return found;
    if (!Number.isSafeInteger(column) || column < 1 || typeof equals !== 'string' || !Number.isSafeInteger(sumColumn) || sumColumn < 1) return fail('INVALID_KNOWLEDGE_TABLE', 'Provide one-based filter and sum columns and an exact string value.');
    const rows = found.value.rows;
    if (!rows && found.value.document?.sheets) {
      if (typeof sheet !== 'string' || !found.value.document.sheets.includes(sheet)) return fail('INVALID_KNOWLEDGE_SHEET', 'Select an indexed sheet by its exact name.');
      const indexed = new Map();
      for (const segment of found.value.document.segments) {
        if (segment.location.sheet !== sheet) continue;
        const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(segment.location.cell);
        if (!match) continue;
        const row = Number(match[2]), col = [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
        if (col !== column && col !== sumColumn) continue;
        if (!indexed.has(row)) indexed.set(row, {});
        indexed.get(row)[col] = segment;
      }
      let count = 0, sum = 0, invalid = 0, uncertainFilterRows = 0; const locations = [];
      for (const [row, cells] of indexed) if (row > 1 && cells[column]?.formula) uncertainFilterRows++;
      for (const [row, cells] of indexed) if (row > 1 && cells[column]?.text === equals && !cells[column].formula) {
        count++; const value = cells[sumColumn], raw = value?.text;
        if (!value || value.formula || value.cellType !== 'n' || typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) || !Number.isFinite(Number(raw))) invalid++;
        else sum += Number(raw);
        if (locations.length < 100) locations.push({sheet, cell: value?.location.cell ?? null, row, column: sumColumn});
      }
      if (!Number.isFinite(sum)) invalid++;
      return success({projectId, path: relative, sha256, sheet, matchedRows: count, invalidValues: invalid, uncertainFilterRows, sum: invalid || uncertainFilterRows ? null : sum,
        arithmetic: 'IEEE-754 binary floating point', locations, locationsTruncated: count > locations.length, headerRow: 1,
        limitations: ['FORMULAS_NOT_RECALCULATED', 'EXCEL_FORMATTING_AND_DATES_NOT_INTERPRETED']});
    }
    if (!rows) return fail('KNOWLEDGE_NOT_TABLE', 'Structured table operations support CSV and XLSX only.');
    let count = 0, sum = 0, invalid = 0; const locations = [];
    for (let i = 1; i < rows.length; i++) if (rows[i][column - 1] === equals) {
      count++; const raw = rows[i][sumColumn - 1];
      if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) || !Number.isFinite(Number(raw))) invalid++;
      else sum += Number(raw);
      if (locations.length < 100) locations.push({row: i + 1, column: sumColumn});
    }
    if (!Number.isFinite(sum)) invalid++;
    return success({projectId, path: relative, sha256, matchedRows: count, invalidValues: invalid, sum: invalid ? null : sum,
      arithmetic: 'IEEE-754 binary floating point', locations, locationsTruncated: count > locations.length, headerRow: 1});
  }
  return success(Object.freeze({refresh, list, search, read, table, restoreVersion}));
}
