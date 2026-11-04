import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCadCandidates } from './lib/cad-candidates.mjs';
import { summarizeCadCandidateRead } from './lib/cad-read-report.mjs';

const documentPath = 'D:\\validation\\CAD-sample.rvt';
const snapshot = 'a'.repeat(64), session = 'c'.repeat(32);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const options = { expectedDocument: documentPath, importElementId: '42', targetKind: 'pipe' };
const rules = { targetKind: 'pipe', layerMappings: [{ layer: 'P', semantic: 'pipe_centerline' }],
  specification: { elevationMm: 2700, diameterMm: 50 } };
function pages({ total = 3, complete = true, lengthFeet = 1, noCandidates = false, empty = false } = {}) {
  if (empty) total = 0;
  return Array.from({ length: Math.max(1, total) }, (_, offset) => {
    const raw = { schemaVersion: 1,
      source: { format: 'revit-import-instance', documentPath, documentFingerprint: null,
        importElementId: '42', importUniqueId: 'import-42', importTypeName: 'fixture.dwg',
        isLinked: true, originalCadPath: null, originalCadUnits: null,
        geometryCoordinateSpace: 'revit-model-internal-feet', geometryInstanceTransformsApplied: true,
        importTotalTransformMetadata: identity },
      units: { sourceGeometry: 'Revit_internal_feet', millimetresPerInternalUnit: 304.8,
        displayGeometry: 'millimetres', originalCadUnits: null },
      entities: empty ? [] : [{ ordinal: offset + 1, type: 'LINE', layer: noCandidates ? 'UNMAPPED' : 'P',
        geometryPath: `geometry/${offset}`, segmentIndex: null, graphicsStyleId: '70',
        localFrom: [0, offset, 0], localTo: [lengthFeet, offset, 0],
        modelFromInternal: [0, offset, 0], modelToInternal: [lengthFeet, offset, 0],
        modelFromMm: [0, offset * 304.8, 0], modelToMm: [lengthFeet * 304.8, offset * 304.8, 0],
        cumulativeTransform: identity, issues: [] }],
      warnings: complete ? [] : [{ code: 'OBJECT_LIMIT', message: 'Synthetic omitted native objects.', path: 'geometry' }],
      coverage: { examinedObjectCount: total, retainedEntityCount: total, lineSegmentCount: total,
        unsupportedEntityCount: 0, invalidLineCount: 0, maxObservedDepth: 1,
        enumerationComplete: complete, interpretationComplete: complete, stopReason: complete ? null : 'OBJECT_LIMIT',
        maxObjects: 5000, maxSegments: 10000, maxDepth: 16, maxRetainedEntities: 15000 },
      page: { offset, limit: 2, returned: empty ? 0 : 1, totalRetainedEntities: total,
        nextOffset: offset + 1 < total ? offset + 1 : null, snapshotId: snapshot, enumerationComplete: complete } };
    const result = buildCadCandidates(raw, rules);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return { operation: 'read_cad_geometry', logical_tool: 'revit_preview_cad_candidates', hostSession: session,
      document: { title: 'CAD-sample', path: documentPath }, modifiedByOperation: false,
      source_evidence: `D:\\validation\\native-page-${offset}.json`,
      value_derivation: 'cad-inventory-v1-to-review-only-candidates', request_id: `request-${offset}`, value: result.value };
  });
}
const report = input => {
  const result = summarizeCadCandidateRead(input, options);
  assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value;
};
test('production-generated pages are summarized without changing pages, evidence or page-local duplicate claims', () => {
  const input = pages(), before = structuredClone(input), result = report(input);
  assert.equal(result.acceptedPageCount, 3); assert.equal(result.candidateCount, 3);
  assert.equal(result.examinedEntityCount, 3); assert.equal(result.expectedNextOffset, null);
  assert.equal(result.totalCandidateLengthMm, 304.8 * 3);
  assert.equal(result.completeness.pageSetComplete, true);
  assert.equal(result.completeness.enumerationComplete, true);
  assert.equal(result.completeness.interpretationComplete, true);
  assert.equal(result.completeness.dwgCompleteness, null); assert.equal(result.completeness.realRevitExecution, null);
  assert.equal(result.source.documentFingerprint, null); assert.equal(result.sourceUnits.originalCadUnits, null);
  assert.deepEqual(result.source_evidence, input.map(p => p.source_evidence));
  assert.equal(result.pages[0], input[0]); assert.deepEqual(input, before);
  assert.equal(result.review.required, true); assert.equal(result.review.modelCreationEnabled, false);
  assert.ok(result.pages.every(p => p.value.candidates[0].duplicateOf === null));
});
test('a complete retained-page set is distinct from incomplete enumeration and interpretation', () => {
  const result = report(pages({ complete: false }));
  assert.equal(result.completeness.pageSetComplete, true);
  assert.equal(result.completeness.enumerationComplete, false);
  assert.equal(result.completeness.interpretationComplete, false);
  assert.equal(result.sourceCoverage.stopReason, 'OBJECT_LIMIT');
  assert.equal(result.sourceWarnings[0].code, 'OBJECT_LIMIT');
});
test('a valid empty native inventory completes one page with zero candidates', () => {
  const result = report(pages({ empty: true }));
  assert.equal(result.candidateCount, 0); assert.equal(result.examinedEntityCount, 0);
  assert.equal(result.totalCandidateLengthMm, 0); assert.equal(result.completeness.pageSetComplete, true);
});
test('missing, skipped, repeated and reordered pages fail with only the accepted prefix', () => {
  const input = pages();
  for (const [selected, accepted] of [[input.slice(0, 2), 2], [[input[0], input[2]], 1],
    [[input[0], input[0]], 1], [[input[1], input[0], input[2]], 0], [[], 0]]) {
    const result = summarizeCadCandidateRead(selected, options);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, accepted);
    assert.equal(result.partial.candidateCount, accepted);
    assert.equal(result.partial.completeness.pageSetComplete, false);
    assert.deepEqual(result.partial.source_evidence, selected.slice(0, accepted).map(p => p.source_evidence));
  }
  const extra = summarizeCadCandidateRead([...input, input[2]], options);
  assert.equal(extra.error.code, 'EXTRA_PAGE'); assert.equal(extra.partial.acceptedPageCount, 3);
  assert.equal(extra.partial.completeness.pageSetComplete, false);
});
test('snapshot, host session, stable IDs, global coverage and warnings must remain identical', () => {
  const mutations = [p => { p.value.sourcePage.snapshotId = 'b'.repeat(64); p.value.source.snapshotId = 'b'.repeat(64); },
    p => p.hostSession = 'd'.repeat(32), p => p.value.source.importUniqueId = 'changed-import',
    p => p.value.source.documentFingerprint = 'known-new-document', p => p.value.sourceCoverage.examinedObjectCount++,
    p => p.value.sourceWarnings.push({ code: 'NEW_WARNING', message: 'changed' }),
    p => p.value.source.importElementId = '43'];
  for (const change of mutations) {
    const input = pages(); change(input[1]);
    const result = summarizeCadCandidateRead(input, options);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, 1);
  }
});
test('mapping and explicit specification must be stable even on pages with zero candidates', () => {
  for (const change of [p => p.value.specification.diameterMm = 75,
    p => p.value.layerMappings[0].layer = 'DIFFERENT', p => p.value.targetKind = 'wall']) {
    const input = pages({ noCandidates: true }); change(input[1]);
    const result = summarizeCadCandidateRead(input, options);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, 1);
  }
  const input = pages({ noCandidates: true }); delete input[1].value.specification;
  assert.equal(summarizeCadCandidateRead(input, options).error.code, 'INVALID_CANDIDATE_OPTIONS');
});
test('write outcomes or weakened review flags cannot be summarized as accepted reads', () => {
  const mutations = [p => p.modifiedByOperation = true, p => p.mode = 'rollback', p => p.committed = false,
    p => p.value.review.required = false, p => p.value.review.modelCreationEnabled = true,
    p => p.value.review.sourceGeometryConfirmed = true, p => p.operation = 'export_schematic',
    p => p.logical_tool = 'revit_list_cad_imports', p => p.document.path = 'D:\\other.rvt',
    p => p.source_evidence = '', p => p.value_derivation = 'unknown'];
  for (const change of mutations) {
    const input = pages(); change(input[1]);
    const result = summarizeCadCandidateRead(input, options);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, 1);
  }
});
test('candidate/disposition ordinals, keys and accounting must agree with their accepted source page', () => {
  const mutations = [p => p.value.dispositions[0].sourceEntity.ordinal = 1,
    p => p.value.dispositions[0].sourceKey = 'repeated-key', p => p.value.candidates[0].id = 'wrong',
    p => p.value.candidates.push(p.value.candidates[0]), p => p.value.coverage.counts.candidate = 2,
    p => p.value.candidates[0].requestedParameters.elevationMm = 999,
    p => p.value.candidates[0].cadAxisMm.length = NaN, p => p.value.coverage.totalCandidateLengthMm = 0,
    p => p.value.sourceCompleteness.pageComplete = true];
  for (const change of mutations) {
    const input = pages(); change(input[1]);
    const result = summarizeCadCandidateRead(input, options);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, 1);
  }
});
test('finite lengths overflowing only across pages remain unknown rather than a false finite total', () => {
  const input = pages({ total: 2, lengthFeet: 1e308 / 304.8 });
  assert.ok(input.every(p => Number.isFinite(p.value.coverage.totalCandidateLengthMm)));
  const result = report(input);
  assert.equal(result.candidateCount, 2); assert.equal(result.totalCandidateLengthMm, null);
  assert.equal(result.totalCandidateLengthKnown, false); assert.equal(result.aggregateIssues[0].code, 'TOTAL_LENGTH_OVERFLOW');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
test('invalid caller expectations and unbounded pages fail with an explicit empty partial', () => {
  for (const change of [x => x.expectedDocument = 'relative.rvt', x => x.importElementId = 9007199254740992,
    x => x.targetKind = 'all', x => x.unrecognized = true]) {
    const expectation = { ...options }; change(expectation);
    const result = summarizeCadCandidateRead(pages(), expectation);
    assert.equal(result.ok, false); assert.equal(result.partial.acceptedPageCount, 0);
  }
  assert.equal(summarizeCadCandidateRead(Array(15001), options).error.code, 'PAGE_LIMIT');
});
