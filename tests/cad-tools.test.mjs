import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateTool, invokeWorkbench, WORKBENCH_TOOLS } from '../lib/workbench-client.mjs';
import { ALL_PANEL_TOOLS } from '../lib/panel-tools.mjs';
import { PANEL_TOOL_CATALOG } from '../lib/panel-catalog.mjs';
import { CAD_RESPONSE_MAX_BYTES } from '../lib/cad-tools.mjs';

const documentPath = 'D:\\validation\\CAD-sample.rvt';
const sessionId = 'c'.repeat(32), snapshotId = 'a'.repeat(64);
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const input = () => ({ expected_document: documentPath, import_element_id: 42,
  target_kind: 'pipe', layer_mappings: [{ layer: 'PIPE', semantic: 'pipe_centerline' }],
  specification: { diameterMm: 50, elevationMm: 2700 } });
export function nativeFixture({ offset = 0, total = 1, complete = true } = {}) {
  return { schemaVersion: 1,
    source: { format: 'revit-import-instance', documentPath, documentFingerprint: 'doc-fingerprint',
      importElementId: '42', importUniqueId: 'import-42', importTypeName: 'synthetic-fixture.dwg', isLinked: true,
      originalCadPath: null, originalCadUnits: null, geometryCoordinateSpace: 'revit-model-internal-feet',
      geometryInstanceTransformsApplied: true,
      importTotalTransformMetadata: [1,0,0,100,0,1,0,200,0,0,1,0,0,0,0,1] },
    units: { sourceGeometry: 'Revit_internal_feet', millimetresPerInternalUnit: 304.8,
      displayGeometry: 'millimetres', originalCadUnits: null },
    entities: [{ ordinal: offset + 1, type: 'LINE', geometryPath: 'geometry[0]/symbol[' + offset + ']', segmentIndex: null,
      layer: 'PIPE', graphicsStyleId: '70', localFrom: [0,0,0], localTo: [1,0,0],
      modelFromInternal: [0,0,0], modelToInternal: [1,0,0], modelFromMm: [0,0,0], modelToMm: [304.8,0,0],
      cumulativeTransform: identity, issues: [] }],
    warnings: [],
    coverage: { examinedObjectCount: total + 1, retainedEntityCount: total, lineSegmentCount: total,
      unsupportedEntityCount: 0, invalidLineCount: 0, maxObservedDepth: 1, enumerationComplete: complete,
      interpretationComplete: complete, stopReason: complete ? null : 'OBJECT_LIMIT', maxObjects: 5000,
      maxSegments: 10000, maxDepth: 16, maxRetainedEntities: 15000 },
    page: { offset, limit: 20, returned: 1, totalRetainedEntities: total,
      nextOffset: offset + 1 < total ? offset + 1 : null, snapshotId, enumerationComplete: complete } };
}
const envelope = value => ({ operation: 'read_cad_geometry', hostSession: sessionId,
  document: { title: 'CAD-sample', path: documentPath }, value, modifiedByOperation: false });
async function temporaryHost(version = '0.5.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-cad-tools-'));
  await fs.mkdir(path.join(root, 'queue', 'outbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'queue', 'host.json'), JSON.stringify({ sessionId, pid: process.pid, version }));
  return root;
}
async function published(root) {
  for (let i = 0; i < 200; i++) {
    const files = await fs.readdir(path.join(root, 'queue', 'inbox')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const file = files.find(name => name.endsWith('.json'));
    if (file) return { file, request: JSON.parse(await fs.readFile(path.join(root, 'queue', 'inbox', file))) };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('No fake-host request published');
}
async function complete(root, file, payload) {
  const destination = path.join(root, 'queue', 'outbox', file);
  await fs.writeFile(destination + '.tmp', typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  await fs.rename(destination + '.tmp', destination);
}

test('CAD catalog has two genuinely read-only tools and panel classification follows contracts', () => {
  assert.equal(new Set(ALL_PANEL_TOOLS).size, ALL_PANEL_TOOLS.length);
  for (const name of ['revit_list_cad_imports', 'revit_preview_cad_candidates', 'revit_preview_schematic']) {
    assert.equal(WORKBENCH_TOOLS.find(tool => tool.name === name).annotations.readOnlyHint, true);
    const row = PANEL_TOOL_CATALOG.find(tool => tool.name === name);
    assert.equal(row.readOnly, true); assert.ok(row.label && row.description);
  }
  for (const name of ['revit_export_schematic', 'revit_execute_csharp', 'revit_run_command'])
    assert.equal(PANEL_TOOL_CATALOG.find(tool => tool.name === name).readOnly, false);
});
test('CAD arguments reject writes, wrong dimensions, ambiguous rules and unbound paging before queue', () => {
  for (const change of [a => a.mode = 'commit', a => a.expected_document = '',
    a => a.expected_document = 'relative.rvt', a => a.expected_document = '\\validation\\x.rvt',
    a => a.expected_document = 'C:relative.rvt', a => a.expected_document = 'C:\\',
    a => a.expected_document = '\\\\server\\share\\', a => a.expected_document = '\\\\?\\C:\\x.rvt', a => a.target_kind = 'all',
    a => a.layer_mappings.push(a.layer_mappings[0]), a => a.specification.heightMm = 3000,
    a => a.offset = 1, a => a.expected_snapshot = 'z'.repeat(64), a => a.limit = 51,
    a => a.import_element_id = Number.MAX_SAFE_INTEGER + 1,
    a => a.import_element_id = '9223372036854775808', a => a.import_element_id = '0x2a']) {
    const args = input(); change(args); assert.throws(() => validateTool('revit_preview_cad_candidates', args));
  }
  assert.doesNotThrow(() => validateTool('revit_preview_cad_candidates', { ...input(), import_element_id: '9007199254740993' }));
  assert.equal(validateTool('revit_list_cad_imports', { expected_document: documentPath }).args.limit, 20);
});
test('host0.4 and malformed versions cannot queue CAD reads', async () => {
  for (const version of ['0.3.0', '0.4.0', undefined, 'unknown']) {
    const root = await temporaryHost(version);
    // undefined explicitly overrides helper's default version.
    if (version === undefined) await fs.writeFile(path.join(root, 'queue', 'host.json'), JSON.stringify({ sessionId, pid: process.pid }));
    for (const [name, args] of [['revit_list_cad_imports', { expected_document: documentPath }], ['revit_preview_cad_candidates', input()]])
      await assert.rejects(invokeWorkbench(name, args, { root, timeout: 200 }), /0\.5\.0.*未入队/);
    await assert.rejects(fs.stat(path.join(root, 'queue', 'inbox')), error => error.code === 'ENOENT');
  }
});
test('real production queue path sends only native read args then derives the unified candidate protocol', async () => {
  const root = await temporaryHost();
  const pending = invokeWorkbench('revit_preview_cad_candidates', input(), { root, timeout: 3000 });
  const { file, request } = await published(root);
  assert.equal(request.operation, 'read_cad_geometry'); assert.equal(request.targetSession, sessionId);
  assert.deepEqual(request.args, { expected_document: documentPath, import_element_id: '42', offset: 0, limit: 20 });
  const raw = { id: request.id, ok: true, result: { ...envelope(nativeFixture()), request_id: 'foreign-host-field' } };
  await complete(root, file, raw);
  const result = await pending;
  assert.equal(result.operation, 'read_cad_geometry'); assert.equal(result.logical_tool, 'revit_preview_cad_candidates');
  assert.equal(result.request_id, request.id);
  assert.equal(result.value.candidates.length, 1);
  assert.deepEqual(result.value.candidates[0].cadAxisMm.to, [304.8,0,0]);
  assert.equal(result.value.review.modelCreationEnabled, false); assert.equal(result.value.review.required, true);
  assert.equal(result.value_derivation, 'cad-inventory-v1-to-review-only-candidates');
  assert.deepEqual(JSON.parse(await fs.readFile(result.source_evidence)), raw);
});
test('CAD import discovery preserves full Int64 IDs as text with no precision loss', async () => {
  const root = await temporaryHost();
  const pending = invokeWorkbench('revit_list_cad_imports', { expected_document: documentPath }, { root, timeout: 3000 });
  const { file, request } = await published(root);
  assert.equal(request.operation, 'list_cad_imports');
  const value = { documentPath, documentFingerprint: 'doc-fingerprint',
    items: [{ elementId: '9007199254740993', uniqueId: 'import-large-id', name: 'CAD', isLinked: false }],
    page: { offset: 0, limit: 20, returned: 1, totalRetainedEntities: 1, nextOffset: null, snapshotId, enumerationComplete: true },
    coverage: { enumerationComplete: true, examinedImports: 1, maxImports: 5000 }, warnings: [] };
  await complete(root, file, { id: request.id, ok: true, result: { operation: 'list_cad_imports', hostSession: sessionId,
    document: { path: documentPath }, modifiedByOperation: false, value } });
  assert.equal((await pending).value.items[0].elementId, '9007199254740993');
});
test('CAD discovery retains known partial items and exact failure diagnostics', async () => {
  const root = await temporaryHost();
  const pending = invokeWorkbench('revit_list_cad_imports', { expected_document: documentPath }, { root, timeout: 3000 });
  const { file, request } = await published(root);
  const value = { documentPath, documentFingerprint: null,
    items: [{ elementId: '42', uniqueId: 'known-import', name: null, isLinked: true }],
    page: { offset: 0, limit: 20, returned: 1, totalRetainedEntities: 1, nextOffset: null, snapshotId, enumerationComplete: false },
    coverage: { enumerationComplete: false, examinedImports: 2, maxImports: 5000 },
    warnings: [{ code: 'NATIVE_IMPORT_LIST_FAILED', message: 'Synthetic InvalidOperationException: read failed', path: 'imports[1].Name' }] };
  await complete(root, file, { id: request.id, ok: true, result: { operation: 'list_cad_imports', hostSession: sessionId,
    document: { path: documentPath }, modifiedByOperation: false, value } });
  const actual = (await pending).value;
  assert.equal(actual.items[0].elementId, '42'); assert.equal(actual.page.enumerationComplete, false);
  assert.deepEqual(actual.warnings, value.warnings);
});
test('one later page keeps global partial coverage and never becomes a full-model result', async () => {
  const root = await temporaryHost(), args = { ...input(), offset: 2, expected_snapshot: snapshotId };
  const pending = invokeWorkbench('revit_preview_cad_candidates', args, { root, timeout: 3000 });
  const { file, request } = await published(root), value = nativeFixture({ offset: 2, total: 3, complete: false });
  value.warnings.push({ code: 'NATIVE_READ_FAILED', message: 'fake stopped native read', path: 'geometry[4]' });
  assert.equal(request.args.expected_snapshot, snapshotId);
  await complete(root, file, { id: request.id, ok: true, result: envelope(value) });
  const result = (await pending).value;
  assert.equal(result.sourceCompleteness.enumerationComplete, false);
  assert.equal(result.sourceCompleteness.pageComplete, false);
  assert.equal(result.sourcePage.offset, 2);
  assert.ok(result.sourceWarnings.some(item => item.code === 'NATIVE_READ_FAILED'));
});
test('foreign identity, writes and changed or nonadvancing pages are rejected', async () => {
  for (const mutate of [r => r.hostSession = 'd'.repeat(32), r => r.document.path = 'D:\\other.rvt',
    r => r.modifiedByOperation = true, r => r.committed = true, r => r.value.source.importElementId = '43',
    r => r.value.page.nextOffset = 0, r => r.value.page.returned = 0,
    r => r.value.page.snapshotId = 'invalid']) {
    const root = await temporaryHost(), pending = invokeWorkbench('revit_preview_cad_candidates', input(), { root, timeout: 3000 });
    const { file, request } = await published(root), result = envelope(nativeFixture()); mutate(result);
    await complete(root, file, { id: request.id, ok: true, result });
    await assert.rejects(pending, /CAD read response rejected/);
  }
});
test('oversized or invalid completion records fail before returning any candidate success', async () => {
  for (const payload of [' '.repeat(CAD_RESPONSE_MAX_BYTES + 1), 'invalid-json', Buffer.from([0xff])]) {
    const root = await temporaryHost(), pending = invokeWorkbench('revit_preview_cad_candidates', input(), { root, timeout: 3000 });
    const { file } = await published(root); await complete(root, file, payload);
    await assert.rejects(pending);
  }
  const root = await temporaryHost(), pending = invokeWorkbench('revit_preview_cad_candidates', input(), { root, timeout: 3000 });
  const { file } = await published(root);
  await complete(root, file, { id: 'foreign', ok: true, result: envelope(nativeFixture()) });
  await assert.rejects(pending, /invalid response identity/);
});
test('a well-formed but changed snapshot cannot be mixed with an earlier preview', async () => {
  const root = await temporaryHost(), args = { ...input(), expected_snapshot: snapshotId };
  const pending = invokeWorkbench('revit_preview_cad_candidates', args, { root, timeout: 3000 });
  const { file, request } = await published(root), result = envelope(nativeFixture());
  result.value.page.snapshotId = 'b'.repeat(64);
  await complete(root, file, { id: request.id, ok: true, result });
  await assert.rejects(pending, /snapshot changed/);
});
test('client owns the request identity for the existing query path as well', async () => {
  const root = await temporaryHost();
  const pending = invokeWorkbench('revit_get_selection', { expected_document: documentPath }, { root, timeout: 3000 });
  const { file, request } = await published(root);
  await complete(root, file, { id: request.id, ok: true,
    result: { hostSession: sessionId, operation: 'get_selection', request_id: 'forged', value: { element_ids: [] } } });
  assert.equal((await pending).request_id, request.id);
});
