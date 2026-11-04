import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCadInventory } from './lib/cad-inventory.mjs';
import { buildCadCandidates, normalizeCadCandidateOptions } from './lib/cad-candidates.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const native = () => ({ schemaVersion: 1,
  source: { format: 'revit-import-instance', documentPath: 'D:\\samples\\a.rvt', documentFingerprint: 'project-uid',
    importElementId: '9223372036854775807', importUniqueId: 'import-uid', importTypeName: 'a.dwg',
    isLinked: true, originalCadPath: 'D:\\samples\\a.dwg', originalCadUnits: null,
    geometryCoordinateSpace: 'revit-model-internal-feet', geometryInstanceTransformsApplied: true,
    // Metadata is deliberately different: applying it would move the line twice.
    importTotalTransformMetadata: [1, 0, 0, 200, 0, 1, 0, 100, 0, 0, 1, 0, 0, 0, 0, 1] },
  units: { sourceGeometry: 'Revit_internal_feet', millimetresPerInternalUnit: 304.8,
    displayGeometry: 'millimetres', originalCadUnits: null },
  entities: [{ ordinal: 1, type: 'LINE', geometryPath: 'geometry/0/instance/1/0', segmentIndex: 0,
    layer: 'P', graphicsStyleId: '9223372036854775806', localFrom: [0, 0, 0], localTo: [1, 0, 0],
    modelFromInternal: [10, 20, 0], modelToInternal: [11, 20, 0],
    modelFromMm: [3048, 6096, 0], modelToMm: [3352.8, 6096, 0],
    cumulativeTransform: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 0, 0, 0, 0, 1], issues: [] }],
  warnings: [], coverage: { examinedObjectCount: 3, retainedEntityCount: 1, lineSegmentCount: 1,
    unsupportedEntityCount: 0, invalidLineCount: 0, maxObservedDepth: 2,
    enumerationComplete: true, interpretationComplete: true, stopReason: null,
    maxObjects: 5000, maxSegments: 10000, maxDepth: 16, maxRetainedEntities: 15000 },
  page: { offset: 0, limit: 100, returned: 1, totalRetainedEntities: 1, nextOffset: null,
    snapshotId: 'b'.repeat(64), enumerationComplete: true } });
const ascii = () => ({ source: { format: 'ascii-dxf', name: 'same-line.dxf', sha256: 'a'.repeat(64) },
  units: { code: 4, name: 'millimetres', millimetresPerUnit: 1 },
  entities: [{ ordinal: 1, type: 'LINE', layer: 'P', handle: 'A0', sourceLine: 11,
    geometry: { kind: 'line', from: [3048, 6096, 0], to: [3352.8, 6096, 0] }, issues: [] }],
  warnings: [], coverage: { entityCount: 1, lineCount: 1, unsupportedCount: 0, invalidLineCount: 0 } });
const opts = { targetKind: 'pipe', layerMappings: [{ layer: 'P', semantic: 'pipe_centerline' }] };
const value = input => { const r = normalizeCadInventory(input); assert.equal(r.ok, true, JSON.stringify(r.error)); return r.value; };

test('two readers share millimetre axes, preserve evidence and never reapply native metadata', () => {
  const raw = native(), before = structuredClone(raw);
  const a = value(ascii()), n = value(raw);
  assert.deepEqual(a.entities[0].axisMm, n.entities[0].axisMm);
  assert.deepEqual(n.entities[0].axisMm.from, [3048, 6096, 0]);
  assert.deepEqual(n.entities[0].provenance.localFrom, [0, 0, 0]);
  assert.deepEqual(n.entities[0].sourceAxis.from, [10, 20, 0]);
  assert.equal(n.entities[0].provenance.graphicsStyleId, '9223372036854775806');
  assert.equal(n.source.importElementId, '9223372036854775807');
  assert.deepEqual(raw, before);
  assert.deepEqual(value(n), n); assert.deepEqual(value(a), a);
  for (const input of [ascii(), native(), n]) {
    const result = buildCadCandidates(input, opts);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(result.value.candidates[0].cadAxisMm, n.entities[0].axisMm);
    assert.equal(result.value.review.required, true); assert.equal(result.value.review.modelCreationEnabled, false);
  }
});
test('native unknown original CAD units and fingerprint remain unknown while Revit feet are known', () => {
  const input = native(); input.source.documentFingerprint = null;
  const result = value(input);
  assert.equal(result.source.documentFingerprint, null);
  assert.equal(result.sourceUnits.originalCadUnits, null);
  assert.equal(result.coordinateInterpretation.millimetresPerUnit, 304.8);
  assert.equal(buildCadCandidates(result, opts).value.candidates.length, 1);
});
test('snapshot-backed pagination preserves global counts and does not claim the last page is the whole inventory', () => {
  const input = native();
  Object.assign(input.coverage, { retainedEntityCount: 2, lineSegmentCount: 2 });
  Object.assign(input.page, { offset: 1, limit: 1, totalRetainedEntities: 2 });
  input.entities[0].ordinal = 2;
  const result = value(input), preview = buildCadCandidates(result, opts).value;
  assert.equal(result.completeness.pageComplete, false);
  assert.equal(result.completeness.enumerationComplete, true);
  assert.equal(preview.sourceCoverage.retainedEntityCount, 2);
  assert.equal(preview.coverage.examinedEntityCount, 1);
  assert.equal(preview.candidates[0].sourceKey, `revit-import-instance:${'b'.repeat(64)}:2`);
  const first = structuredClone(input); first.page.offset = 0; first.page.nextOffset = 1; first.entities[0].ordinal = 1;
  assert.equal(value(first).completeness.pageComplete, false);
  const changed = structuredClone(input); changed.page.snapshotId = 'c'.repeat(64);
  assert.notEqual(value(changed).entities[0].sourceKey, result.entities[0].sourceKey);
});
test('invalid page coverage, offsets, continuation, snapshot and ordinal fail', () => {
  const mutations = [x => x.page.offset = 1, x => x.page.returned = 0, x => x.page.nextOffset = 1,
    x => x.page.totalRetainedEntities = 2, x => x.page.snapshotId = 'unknown',
    x => x.page.enumerationComplete = false, x => x.entities[0].ordinal = 2,
    x => x.coverage.lineSegmentCount = 0, x => x.coverage.maxSegments = 0];
  for (const change of mutations) { const x = native(); change(x); assert.equal(normalizeCadInventory(x).ok, false); }
});
test('byte-budget clipped pages and signed unresolved style IDs preserve provenance', () => {
  const input = native();
  Object.assign(input.coverage, { retainedEntityCount: 3, lineSegmentCount: 3 });
  Object.assign(input.page, { totalRetainedEntities: 3, nextOffset: 1 });
  input.entities[0].graphicsStyleId = '-1';
  assert.equal(value(input).entities[0].provenance.graphicsStyleId, '-1');
  assert.equal(value(input).completeness.pageComplete, false);
  input.entities[0].graphicsStyleId = 0;
  assert.equal(value(input).entities[0].provenance.graphicsStyleId, '0');
});
test('saved document path policy rejects root-relative and device paths without truncating valid long paths', () => {
  for (const documentPath of ['/sample.rvt', '\\sample.rvt', '\\\\?\\D:\\sample.rvt', 'D:sample.rvt']) {
    const input = native(); input.source.documentPath = documentPath;
    assert.equal(normalizeCadInventory(input).ok, false);
  }
  const input = native(); input.source.documentPath = `D:\\${'directory\\'.repeat(500)}sample.rvt`;
  assert.equal(normalizeCadInventory(input).ok, true);
});
test('native unsafe numeric IDs, bad units, nonfinite or malformed affine evidence fail closed', () => {
  const mutations = [x => x.source.importElementId = 9007199254740992,
    x => x.entities[0].graphicsStyleId = 9007199254740992,
    x => x.source.importElementId = '9223372036854775808', x => x.source.importElementId = '0001',
    x => x.units.millimetresPerInternalUnit = 1, x => x.units.sourceGeometry = 'mm',
    x => x.entities[0].modelFromMm[0] = 10, x => x.entities[0].modelFromInternal = null,
    x => x.entities[0].modelToMm[1] = Infinity, x => x.entities[0].cumulativeTransform = identity.slice(1),
    x => x.entities[0].cumulativeTransform[15] = 2, x => x.entities[0].localFrom[0] = NaN,
    x => x.source.importTotalTransformMetadata[0] = Infinity, x => x.source.geometryInstanceTransformsApplied = false];
  for (const change of mutations) { const x = native(); change(x); assert.equal(normalizeCadInventory(x).ok, false); }
  const old = native(); old.source.importElementId = 123; old.entities[0].graphicsStyleId = 456;
  assert.equal(value(old).source.importElementId, '123');
  assert.equal(value(old).entities[0].provenance.graphicsStyleId, '456');
});
test('canonical schema, coordinates, provenance and completeness cannot be forged independently', () => {
  for (const change of [x => x.schemaVersion = 2, x => x.entities[0].axisMm.from[0]++,
    x => x.entities[0].provenance.modelFromMm[0]++, x => x.entities[0].sourceKey = 'other',
    x => x.coordinateInterpretation.instanceTransformApplied = false,
    x => x.completeness.pageComplete = false, x => x.page.snapshotId = 'c'.repeat(64),
    x => x.unrecognized = true]) {
    const x = value(native()); change(x); assert.equal(normalizeCadInventory(x).ok, false);
  }
});
test('partial enumeration, unsupported primitives and missing layers retain independent reasons', () => {
  const partial = native();
  Object.assign(partial.coverage, { enumerationComplete: false, interpretationComplete: false, stopReason: 'OBJECT_LIMIT' });
  partial.page.enumerationComplete = false; partial.warnings = [{ code: 'OBJECT_LIMIT', message: 'Some native objects not examined.', path: 'geometry' }];
  assert.equal(value(partial).completeness.enumerationComplete, false);
  assert.equal(value(partial).completeness.pageComplete, true);
  const unsupported = native(), e = unsupported.entities[0];
  e.type = 'Arc'; e.localFrom = e.localTo = e.modelFromInternal = e.modelToInternal = e.modelFromMm = e.modelToMm = e.cumulativeTransform = null;
  e.issues = [{ code: 'UNSUPPORTED_GEOMETRY', message: 'Curved geometry retained.' }];
  Object.assign(unsupported.coverage, { lineSegmentCount: 0, unsupportedEntityCount: 1, interpretationComplete: false });
  assert.equal(value(unsupported).entities[0].axisMm, null);
  assert.equal(buildCadCandidates(unsupported, opts).value.coverage.counts.unsupported, 1);
  const missing = native(); missing.entities[0].layer = null;
  missing.entities[0].issues = [{ code: 'MISSING_LAYER', message: 'No style resolved.' }]; missing.coverage.interpretationComplete = false;
  const preview = buildCadCandidates(missing, opts).value;
  assert.equal(preview.coverage.counts.invalid, 1); assert.equal(preview.dispositions[0].sourceEntity.layer, null);
  assert.equal(preview.dispositions[0].issues[0].code, 'MISSING_LAYER');
});
test('ASCII unresolved units remain unscaled and malformed nonfinite geometry is rejected', () => {
  const input = ascii(); input.units = { code: 0, name: null, millimetresPerUnit: null };
  const normalized = value(input);
  assert.equal(normalized.entities[0].axisMm, null); assert.equal(normalized.completeness.interpretationComplete, false);
  assert.equal(buildCadCandidates(normalized, opts).value.coverage.counts.unknown_units, 1);
  const bad = ascii(); bad.entities[0].geometry.from[0] = NaN;
  assert.equal(normalizeCadInventory(bad).ok, false);
});
test('candidate option owner is idempotent and rejects cross-target dimensions and duplicate layer mappings', () => {
  const first = normalizeCadCandidateOptions(opts); assert.equal(first.ok, true);
  assert.deepEqual(normalizeCadCandidateOptions(first.value), first);
  for (const invalid of [{ ...opts, specification: { heightMm: 3000 } },
    { ...opts, layerMappings: [...opts.layerMappings, ...opts.layerMappings] },
    { ...opts, specification: { elevationMm: Infinity } }])
    assert.equal(normalizeCadCandidateOptions(invalid).ok, false);
});
test('overflow evidence is JSON-stable and canonical normalization is idempotent', () => {
  const input = ascii(); input.units = { code: 1, name: 'inches', millimetresPerUnit: 25.4 };
  input.entities[0].geometry = { kind: 'line', from: [0, 0, 0], to: [1e308, 0, 0] };
  const result = value(input);
  assert.equal(result.entities[0].axisMm, null);
  assert.equal(result.entities[0].issues[0].code, 'CONVERSION_OVERFLOW');
  assert.deepEqual(value(result), result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(buildCadCandidates(result, opts).value.coverage.counts.invalid, 1);
});
test('malformed JSON-like representations return a tagged failure rather than throwing', () => {
  const cyclic = native(); cyclic.source.extra = cyclic;
  for (const input of [null, [], {}, cyclic, { ...native(), entities: [null] },
    { ...native(), warnings: [{ code: 'NOTICE' }] }, { ...native(), schemaVersion: 2 }])
    assert.equal(normalizeCadInventory(input).ok, false);
});
