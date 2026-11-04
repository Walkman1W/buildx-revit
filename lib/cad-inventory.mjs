import { isDeepStrictEqual } from 'node:util';
import { isSavedCadDocumentPath } from './cad-document-path.mjs';

// One owning boundary for the two reader representations. Native geometry has
// already been transformed and scaled by the Revit producer; never do it again.
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const integer = x => Number.isSafeInteger(x) && x >= 0;
const text = (x, max = 4096) => typeof x === 'string' && x.length <= max;
const nonempty = x => text(x) && x.trim().length > 0;
const point = x => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);
const matrix = x => Array.isArray(x) && x.length === 16 && x.every(Number.isFinite) &&
  x[12] === 0 && x[13] === 0 && x[14] === 0 && x[15] === 1;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const clone = x => structuredClone(x);
const issue = (code, message) => ({ code, message });
const fail = (code, message, path) => ({ ok: false, error: { code, message, ...(path ? { path } : {}) } });
const checks = (x, path) => {
  if (!Array.isArray(x) || x.length > 1000 || x.some(y => !record(y) || !nonempty(y.code) || !text(y.message) ||
      (y.path !== undefined && y.path !== null && !text(y.path))))
    return fail('INVALID_DIAGNOSTICS', 'Diagnostic records require code and message.', path);
  return null;
};
function id(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) return undefined;
  return value;
}
function styleId(value) {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n ? value : undefined;
}
function jsonSafe(value, depth = 0, seen = new Set()) {
  if (depth > 20) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !record(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const result = Object.values(value).every(v => jsonSafe(v, depth + 1, seen));
  seen.delete(value); return result;
}
function axis(from, to, scale) {
  const converted = [from, to].map(p => p.map(v => v * scale));
  const length = Math.hypot(...converted[0].map((v, i) => converted[1][i] - v));
  return [...converted.flat(), length].every(Number.isFinite)
    ? { from: converted[0], to: converted[1], length } : null;
}
function rawFromCanonical(value) {
  if (value.schemaVersion !== 1 || value.kind !== 'cad-inventory' || !record(value.source) ||
      !Array.isArray(value.entities)) return null;
  const source = { ...value.source }; delete source.snapshotId;
  const native = source.format === 'revit-import-instance';
  const entities = value.entities.map(e => {
    if (!record(e) || !record(e.provenance)) return null;
    const { sourceIssues, ...fields } = clone(e.provenance);
    return { ordinal: e.ordinal, type: e.type, layer: e.layer, ...fields, issues: sourceIssues };
  });
  return { ...(native ? { schemaVersion: 1, page: clone(value.page) } : {}), source,
    units: clone(value.sourceUnits), entities, warnings: clone(value.warnings), coverage: clone(value.coverage) };
}

/** Result<CadInventory>: malformed representations fail; partial valid evidence survives. */
export function normalizeCadInventory(input) {
  if (!record(input) || !jsonSafe(input)) return fail('INVALID_INVENTORY', 'Inventory must contain finite JSON values.');
  if (Object.hasOwn(input, 'kind')) {
    const raw = rawFromCanonical(input);
    if (!raw) return fail('INVALID_CANONICAL_INVENTORY', 'Unsupported canonical inventory schema.');
    const rebuilt = normalizeCadInventory(raw);
    if (!rebuilt.ok || !isDeepStrictEqual(rebuilt.value, input))
      return fail('INVALID_CANONICAL_INVENTORY', 'Canonical fields do not match their retained source evidence.');
    return rebuilt;
  }
  if (!record(input.source) || !record(input.units) || !record(input.coverage) ||
      !Array.isArray(input.entities) || input.entities.length > 20000 ||
      (input.schemaVersion !== undefined && input.schemaVersion !== 1))
    return fail('INVALID_READER_RESULT', 'Reader source, units, coverage and bounded entities are required.');
  for (const [values, path] of [[input.warnings, 'warnings'], ...input.entities.map((e, i) => [e?.issues, `entities/${i}/issues`])]) {
    const error = checks(values, path); if (error) return error;
  }
  const native = input.source.format === 'revit-import-instance';
  const ascii = input.source.format === 'ascii-dxf';
  if (!native && !ascii) return fail('UNSUPPORTED_CAD_SOURCE', 'Only ASCII DXF and Revit ImportInstance reader data are supported.');
  const source = clone(input.source), units = clone(input.units), coverage = clone(input.coverage);
  let snapshotId, page, coordinateInterpretation, enumerationComplete, interpretationComplete;
  if (ascii) {
    if (!hash(source.sha256) || (source.name !== undefined && !text(source.name)) ||
        (source.byteLength !== undefined && !integer(source.byteLength)) ||
        (units.code !== null && !integer(units.code)) ||
        (units.name !== null && !text(units.name)) ||
        (units.millimetresPerUnit !== null && !(Number.isFinite(units.millimetresPerUnit) && units.millimetresPerUnit > 0)) ||
        coverage.entityCount !== input.entities.length || !integer(coverage.lineCount) ||
        coverage.lineCount !== input.entities.filter(e => e?.type === 'LINE').length)
      return fail('INVALID_READER_RESULT', 'ASCII identity, units or coverage are inconsistent.');
    for (const name of ['unsupportedCount', 'invalidLineCount']) if (coverage[name] !== undefined &&
        (!integer(coverage[name]) || coverage[name] > coverage.entityCount))
      return fail('INVALID_COVERAGE', 'ASCII coverage counts are inconsistent.', `coverage/${name}`);
    snapshotId = source.sha256;
    enumerationComplete = true;
    interpretationComplete = units.millimetresPerUnit !== null && input.entities.every(e => e?.type === 'LINE' && e.issues.length === 0);
    page = { offset: 0, limit: Math.max(1, input.entities.length), returned: input.entities.length,
      totalRetainedEntities: input.entities.length, nextOffset: null, snapshotId, enumerationComplete };
    coordinateInterpretation = { input: 'source-WCS', output: units.millimetresPerUnit === null ? null : 'source-WCS-mm',
      millimetresPerUnit: units.millimetresPerUnit, instanceTransformApplied: false, sourceZIsModellingElevation: false };
  } else {
    const elementId = id(source.importElementId);
    if (input.schemaVersion !== 1 || !isSavedCadDocumentPath(source.documentPath) || elementId === undefined ||
        !nonempty(source.importUniqueId) || (source.documentFingerprint !== null && !nonempty(source.documentFingerprint)) ||
        typeof source.isLinked !== 'boolean' ||
        (source.originalCadPath !== null && !text(source.originalCadPath)) ||
        (source.originalCadUnits !== null && !text(source.originalCadUnits)) ||
        (source.importTypeName !== null && !text(source.importTypeName)) ||
        source.geometryCoordinateSpace !== 'revit-model-internal-feet' || source.geometryInstanceTransformsApplied !== true ||
        (source.importTotalTransformMetadata !== null && !matrix(source.importTotalTransformMetadata)) ||
        units.sourceGeometry !== 'Revit_internal_feet' || units.millimetresPerInternalUnit !== 304.8 ||
        units.displayGeometry !== 'millimetres' || units.originalCadUnits !== source.originalCadUnits)
      return fail('INVALID_NATIVE_SOURCE', 'Native source identities, coordinate ownership or internal unit contract are invalid.');
    source.importElementId = elementId;
    const names = ['examinedObjectCount', 'retainedEntityCount', 'lineSegmentCount', 'unsupportedEntityCount', 'invalidLineCount', 'maxObservedDepth'];
    if (names.some(k => !integer(coverage[k])) ||
        coverage.lineSegmentCount + coverage.unsupportedEntityCount !== coverage.retainedEntityCount ||
        coverage.invalidLineCount > coverage.lineSegmentCount || typeof coverage.enumerationComplete !== 'boolean' ||
        typeof coverage.interpretationComplete !== 'boolean' ||
        (coverage.stopReason !== null && !nonempty(coverage.stopReason)) ||
        (!coverage.enumerationComplete && coverage.stopReason === null) ||
        (coverage.enumerationComplete && coverage.stopReason !== null) ||
        (coverage.interpretationComplete && (!coverage.enumerationComplete || coverage.unsupportedEntityCount > 0 || coverage.invalidLineCount > 0)))
      return fail('INVALID_COVERAGE', 'Native global counts and completeness are inconsistent.');
    for (const [budget, count] of [['maxObjects', 'examinedObjectCount'], ['maxSegments', 'lineSegmentCount'],
      ['maxDepth', 'maxObservedDepth'], ['maxRetainedEntities', 'retainedEntityCount']])
      if (coverage[budget] !== undefined && (!integer(coverage[budget]) || coverage[count] > coverage[budget]))
        return fail('INVALID_COVERAGE', 'Native counts exceed their declared budget.', `coverage/${budget}`);
    page = clone(input.page);
    if (!record(page) || !integer(page.offset) || !integer(page.limit) || page.limit < 1 || page.limit > 20000 ||
        !integer(page.returned) || page.returned !== input.entities.length || page.returned > page.limit ||
        page.totalRetainedEntities !== coverage.retainedEntityCount || !integer(page.totalRetainedEntities) ||
        page.offset > page.totalRetainedEntities || page.offset + page.returned > page.totalRetainedEntities ||
        (page.returned === 0 && page.offset < page.totalRetainedEntities) ||
        page.nextOffset !== (page.offset + page.returned < page.totalRetainedEntities ? page.offset + page.returned : null) ||
        !hash(page.snapshotId) || page.enumerationComplete !== coverage.enumerationComplete)
      return fail('INVALID_PAGE', 'Page offset, returned count, continuation and snapshot must describe the same retained inventory.');
    snapshotId = page.snapshotId;
    enumerationComplete = coverage.enumerationComplete;
    interpretationComplete = coverage.interpretationComplete;
    coordinateInterpretation = { input: 'revit-model-internal-feet', output: 'revit-model-mm',
      millimetresPerUnit: 304.8, instanceTransformApplied: true, sourceZIsModellingElevation: false };
  }
  source.snapshotId = snapshotId;
  const entities = [];
  for (let index = 0; index < input.entities.length; index++) {
    const raw = input.entities[index], path = `entities/${index}`;
    if (!record(raw) || raw.ordinal !== page.offset + index + 1 || !nonempty(raw.type) ||
        (raw.layer !== null && (!text(raw.layer, 255) || !raw.layer.trim())))
      return fail('INVALID_ENTITY', 'Entity ordinal, type or layer is invalid.', path);
    if (raw.layer === null && !raw.issues.some(i => i.code === 'MISSING_LAYER' || i.code === 'DUPLICATE_LAYER'))
      return fail('INVALID_ENTITY', 'An unresolved layer must retain its diagnostic reason.', path);
    let provenance, sourceAxis = null, axisMm = null;
    const issues = clone(raw.issues);
    if (ascii) {
      if ((raw.handle !== null && !text(raw.handle)) || !Number.isSafeInteger(raw.sourceLine) || raw.sourceLine < 1 ||
          (raw.geometry !== null && (!record(raw.geometry) || raw.type !== 'LINE' || raw.geometry.kind !== 'line' ||
            !point(raw.geometry.from) || !point(raw.geometry.to))))
        return fail('INVALID_ENTITY', 'ASCII entity provenance or finite line geometry is invalid.', path);
      if (raw.type === 'LINE' && raw.geometry === null && issues.length === 0)
        return fail('INVALID_ENTITY', 'Missing LINE geometry must retain a diagnostic.', path);
      if (raw.type !== 'LINE' && !issues.some(i => i.code === 'UNSUPPORTED_ENTITY'))
        return fail('INVALID_ENTITY', 'Unsupported ASCII entities must retain their diagnostic reason.', path);
      provenance = { handle: raw.handle, sourceLine: raw.sourceLine, geometry: clone(raw.geometry) };
      if (raw.geometry !== null) {
        sourceAxis = { from: [...raw.geometry.from], to: [...raw.geometry.to], unitCode: units.code };
        if (units.millimetresPerUnit !== null) {
          axisMm = axis(raw.geometry.from, raw.geometry.to, units.millimetresPerUnit);
          if (!axisMm && !issues.some(i => i.code === 'CONVERSION_OVERFLOW'))
            issues.push(issue('CONVERSION_OVERFLOW', 'Unit conversion exceeds finite coordinate range.'));
        }
      }
    } else {
      const graphicsStyleId = styleId(raw.graphicsStyleId);
      if (!nonempty(raw.geometryPath) || graphicsStyleId === undefined ||
          (raw.segmentIndex !== null && !integer(raw.segmentIndex)))
        return fail('INVALID_ENTITY', 'Native geometry path, segment identity or style ID is invalid.', path);
      const pointNames = ['localFrom', 'localTo', 'modelFromInternal', 'modelToInternal', 'modelFromMm', 'modelToMm'];
      if (pointNames.some(k => raw[k] !== null && !point(raw[k])) ||
          (raw.cumulativeTransform !== null && !matrix(raw.cumulativeTransform)))
        return fail('INVALID_ENTITY', 'Native points and affine matrix must be finite.', path);
      const hasInvalid = issues.some(i => i.code === 'INVALID_AXIS');
      if (coverage.interpretationComplete && issues.length > 0)
        return fail('INVALID_COVERAGE', 'Global interpretation completeness contradicts retained entity diagnostics.', path);
      if (raw.type === 'LINE' && !hasInvalid && (pointNames.some(k => raw[k] === null) || !matrix(raw.cumulativeTransform)))
        return fail('INVALID_ENTITY', 'A valid native LINE requires local, internal and millimetre source evidence.', path);
      if (raw.type !== 'LINE' && (pointNames.some(k => raw[k] !== null) || raw.cumulativeTransform !== null))
        return fail('INVALID_ENTITY', 'Unsupported native geometry must not masquerade as an interpreted LINE.', path);
      if (raw.type !== 'LINE' && !issues.some(i => i.code === 'UNSUPPORTED_GEOMETRY'))
        return fail('INVALID_ENTITY', 'Unsupported native geometry must retain its diagnostic reason.', path);
      provenance = { geometryPath: raw.geometryPath, segmentIndex: raw.segmentIndex, graphicsStyleId,
        ...Object.fromEntries(pointNames.map(k => [k, clone(raw[k])])), cumulativeTransform: clone(raw.cumulativeTransform) };
      if (raw.type === 'LINE' && raw.modelFromMm !== null && raw.modelToMm !== null) {
        if (!point(raw.modelFromInternal) || !point(raw.modelToInternal) ||
            !raw.modelFromMm.every((v, i) => close(v, raw.modelFromInternal[i] * 304.8)) ||
            !raw.modelToMm.every((v, i) => close(v, raw.modelToInternal[i] * 304.8)))
          return fail('NATIVE_UNIT_MISMATCH', 'Native millimetre points do not agree with retained internal feet.', path);
        const length = Math.hypot(...raw.modelFromMm.map((v, i) => raw.modelToMm[i] - v));
        if (Number.isFinite(length)) axisMm = { from: [...raw.modelFromMm], to: [...raw.modelToMm], length };
        else if (!issues.some(i => i.code === 'CONVERSION_OVERFLOW'))
          issues.push(issue('CONVERSION_OVERFLOW', 'Native axis length exceeds finite coordinate range.'));
        sourceAxis = { from: [...raw.modelFromInternal], to: [...raw.modelToInternal], unitCode: 'Revit_internal_feet' };
      }
    }
    provenance.sourceIssues = clone(raw.issues);
    entities.push({ ordinal: raw.ordinal, type: raw.type, layer: raw.layer,
      sourceKey: `${source.format}:${snapshotId}:${raw.ordinal}`, provenance, sourceAxis, axisMm, issues });
  }
  interpretationComplete = interpretationComplete && entities.every(entity => entity.issues.length === 0);
  return { ok: true, value: { schemaVersion: 1, kind: 'cad-inventory', source, sourceUnits: units,
    coordinateInterpretation, entities, warnings: clone(input.warnings), coverage, page,
    completeness: { enumerationComplete, interpretationComplete,
      pageComplete: page.offset === 0 && page.nextOffset === null && page.returned === page.totalRetainedEntities } } };
}
