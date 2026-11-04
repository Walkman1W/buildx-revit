import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCadCandidates } from './lib/cad-candidates.mjs';

const mappings = [{ layer: 'W', semantic: 'wall_centerline' },
  { layer: 'P', semantic: 'pipe_centerline' }, { layer: 'N', semantic: 'ignore' }];
const line = (layer, from = [0, 0, 0], to = [1000, 0, 0]) =>
  ({ type: 'LINE', layer, handle: null, sourceLine: 21, geometry: { kind: 'line', from, to }, issues: [] });
const drawing = (...entities) => ({ source: { format: 'ascii-dxf', sha256: 'a'.repeat(64) },
  units: { code: 4, name: 'mm', millimetresPerUnit: 1 }, warnings: [],
  coverage: { entityCount: entities.length, lineCount: entities.filter(item => item.type === 'LINE').length },
  entities: entities.map((entity, index) => ({ ...entity, ordinal: index + 1 })) });
const options = targetKind => ({ targetKind, layerMappings: mappings });
const value = (input, opts = options('pipe')) => {
  const result = buildCadCandidates(input, opts); assert.equal(result.ok, true); return result.value;
};

test('requires one target and explicit, unique layer semantics', () => {
  for (const opts of [null, {}, options('all'), { ...options('pipe'), layerMappings: [] },
    { ...options('pipe'), layerMappings: [mappings[0], mappings[0]] },
    { ...options('pipe'), layerMappings: [{ layer: 'W', semantic: 'guess' }] },
    { ...options('pipe'), unitOverride: 'mm' }])
    assert.equal(buildCadCandidates(drawing(), opts).ok, false);
});
test('every entity receives a disposition; names are case-sensitive, never inferred', () => {
  const input = drawing(line('W'), line('P'), { ...line('N'), type: 'TEXT', geometry: null,
    issues: [{ code: 'UNSUPPORTED_ENTITY', message: 'TEXT' }] }, line('p'),
    { ...line('P'), type: 'ARC', geometry: null, issues: [{ code: 'UNSUPPORTED_ENTITY', message: 'ARC' }] });
  const result = value(input);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.dispositions.map(item => item.disposition),
    ['other_target', 'candidate', 'ignored', 'unmapped_layer', 'unsupported']);
  assert.equal(result.dispositions[2].issues[0].code, 'UNSUPPORTED_ENTITY');
  assert.equal(Object.values(result.coverage.counts).reduce((a, b) => a + b), input.entities.length);
});
test('converts known units once and preserves source coordinates, provenance and modelling elevation', () => {
  const input = drawing(line('P', [1, 2, 0], [11, 2, 0]));
  input.units = { code: 1, name: 'inches', millimetresPerUnit: 25.4 };
  const snapshot = structuredClone(input);
  const result = value(input, { ...options('pipe'), specification: { elevationMm: 2700, diameterMm: 50 } });
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.sourceAxis.from, [1, 2, 0]);
  assert.deepEqual(candidate.cadAxisMm.from, [25.4, 50.8, 0]);
  assert.ok(Math.abs(candidate.cadAxisMm.length - 254) < 1e-9);
  assert.equal(candidate.requestedParameters.elevationMm, 2700);
  assert.deepEqual(candidate.sourceEntity, { ordinal: 1, type: 'LINE', layer: 'P', handle: null, sourceLine: 21 });
  assert.equal(result.coordinateInterpretation.instanceTransformApplied, false);
  assert.equal(result.coordinateInterpretation.sourceZIsModellingElevation, false);
  assert.deepEqual(input, snapshot);
});
test('unknown units keep source inventory and block candidate conversion', () => {
  const input = drawing(line('P')); input.units = { code: 0, name: null, millimetresPerUnit: null };
  const result = value(input);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.counts.unknown_units, 1);
  assert.equal(result.coordinateInterpretation.output, null);
});
test('invalid, paper-space, zero-length and overflowing axes do not become candidates', () => {
  const input = drawing({ ...line('P'), issues: [{ code: 'INVALID_COORDINATE', message: 'missing y' }] },
    { ...line('P'), issues: [{ code: 'PAPER_SPACE', message: 'paper-space line' }] },
    line('P', [0, 0, 0], [0, 0, 0]), line('P', [-1e308, 0, 0], [1e308, 0, 0]));
  const result = value(input);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.counts.invalid, 3); assert.equal(result.coverage.counts.degenerate, 1);
});
test('duplicate or reversed axes are retained and flagged for review', () => {
  const input = drawing(line('P'), line('P', [1000, 0, 0], [0, 0, 0]));
  const first = value(input), repeated = value(input);
  assert.deepEqual(first, repeated);
  assert.equal(first.candidates[1].duplicateOf, first.candidates[0].id);
  assert.equal(first.candidates[1].warnings[0].code, 'DUPLICATE_AXIS');
  assert.notEqual(first.candidates[1].id, first.candidates[0].id);
});
test('preview never authorizes creation and identifies missing native-model inputs', () => {
  const result = value(drawing(line('W')), { ...options('wall'), specification: { heightMm: 3000, thicknessMm: 200 } });
  assert.equal(result.review.required, true); assert.equal(result.review.modelCreationEnabled, false);
  assert.deepEqual(result.review.unresolvedInputs, ['levelId', 'wallTypeId']);
  assert.deepEqual(value(drawing(line('P'))).review.unresolvedInputs,
    ['elevationMm', 'diameterMm', 'levelId', 'pipeTypeId', 'systemTypeId']);
});
test('invalid specification and broken reader identity fail without guessing', () => {
  for (const specification of [{ heightMm: 5 }, { diameterMm: 0 }, { elevationMm: NaN }, { diameterMm: '50' }])
    assert.equal(buildCadCandidates(drawing(line('P')), { ...options('pipe'), specification }).ok, false);
  for (const input of [{}, { ...drawing(line('P')), source: { sha256: 'unknown', format: 'ascii-dxf' } },
    { ...drawing(line('P')), entities: [{ ...line('P'), ordinal: 2 }] }])
    assert.equal(buildCadCandidates(input, options('pipe')).ok, false);
});

test('finite axis lengths can have an unknown total without hiding overflow in JSON', () => {
  const input = drawing(line('P', [0, 0, 0], [1e308, 0, 0]), line('P', [0, 0, 0], [1e308, 0, 0]));
  input.warnings = [{ code: 'SOURCE_NOTICE', message: 'reader-level notice' }];
  input.coverage = { entityCount: 2, lineCount: 2, unsupportedCount: 0, invalidLineCount: 0 };
  const result = value(input);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.coverage.totalCandidateLengthMm, null);
  assert.equal(result.coverage.totalCandidateLengthKnown, false);
  assert.equal(result.aggregateIssues[0].code, 'TOTAL_LENGTH_OVERFLOW');
  assert.deepEqual(result.sourceWarnings, input.warnings);
  assert.deepEqual(result.sourceCoverage, input.coverage);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});