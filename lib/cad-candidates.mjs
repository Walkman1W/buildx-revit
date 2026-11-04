import { normalizeCadInventory } from './cad-inventory.mjs';

// Both readers enter the same owning normalizer before candidate interpretation.
const semanticByKind = { wall: 'wall_centerline', pipe: 'pipe_centerline' };
const specificationKeys = {
  wall: ['heightMm', 'thicknessMm'],
  pipe: ['elevationMm', 'diameterMm'],
};
const issue = (code, message) => ({ code, message });
const failure = (code, message) => ({ ok: false, error: issue(code, message) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeCadCandidateOptions(options) {
  if (!record(options) || !Object.hasOwn(semanticByKind, options.targetKind))
    return failure('TARGET_KIND_REQUIRED', 'Select exactly one target kind: wall or pipe.');
  if (Object.keys(options).some(key => !['targetKind', 'layerMappings', 'specification'].includes(key)))
    return failure('UNKNOWN_OPTION', 'Unsupported candidate option.');
  if (!Array.isArray(options.layerMappings) || options.layerMappings.length === 0 || options.layerMappings.length > 100)
    return failure('LAYER_MAPPING_REQUIRED', 'Provide 1..100 explicit, case-sensitive layer mappings.');
  const mappings = new Map();
  for (const rule of options.layerMappings) {
    if (!record(rule) || Object.keys(rule).length !== 2 || typeof rule.layer !== 'string' || !rule.layer.trim() ||
        rule.layer.length > 255 || !['wall_centerline', 'pipe_centerline', 'ignore'].includes(rule.semantic))
      return failure('INVALID_LAYER_MAPPING', 'Each layer mapping requires only layer and semantic.');
    if (mappings.has(rule.layer)) return failure('DUPLICATE_LAYER_MAPPING', 'Layer mappings must be unique.');
    mappings.set(rule.layer, rule.semantic);
  }
  const supplied = options.specification ?? {};
  if (!record(supplied) || Object.keys(supplied).some(key => !specificationKeys[options.targetKind].includes(key)))
    return failure('INVALID_SPECIFICATION', 'Use only explicit dimensions for the selected target kind.');
  const specification = {};
  for (const key of specificationKeys[options.targetKind]) {
    const value = supplied[key];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) ||
        (key !== 'elevationMm' && value <= 0)))
      return failure('INVALID_SPECIFICATION', `${key} must be a finite millimetre value${key === 'elevationMm' ? '' : ' greater than zero'}.`);
    specification[key] = value ?? null;
  }
  return { ok: true, value: { targetKind: options.targetKind,
    layerMappings: options.layerMappings.map(rule => ({ ...rule })), specification } };
}

export function buildCadCandidates(input, options) {
  const normalizedOptions = normalizeCadCandidateOptions(options);
  if (!normalizedOptions.ok) return normalizedOptions;
  options = normalizedOptions.value;
  const { specification } = options;
  const mappings = new Map(options.layerMappings.map(rule => [rule.layer, rule.semantic]));
  const normalized = normalizeCadInventory(input);
  if (!normalized.ok) return normalized;
  const drawing = normalized.value;
  const knownUnits = drawing.coordinateInterpretation.output !== null;
  const entities = drawing.entities;

  const candidates = [], dispositions = [];
  const counts = { candidate: 0, ignored: 0, other_target: 0, unmapped_layer: 0,
    unsupported: 0, invalid: 0, unknown_units: 0, degenerate: 0 };
  const missingInputs = specificationKeys[options.targetKind]
    .filter(key => specification[key] === null);
  missingInputs.push('levelId', ...(options.targetKind === 'wall' ? ['wallTypeId'] : ['pipeTypeId', 'systemTypeId']));
  const seen = new Map();
  for (const entity of entities) {
    const sourceEntity = { ordinal: entity.ordinal, type: entity.type, layer: entity.layer,
      ...(drawing.source.format === 'ascii-dxf'
        ? { handle: entity.provenance.handle, sourceLine: entity.provenance.sourceLine }
        : { geometryPath: entity.provenance.geometryPath, segmentIndex: entity.provenance.segmentIndex,
          graphicsStyleId: entity.provenance.graphicsStyleId, importElementId: drawing.source.importElementId,
          importUniqueId: drawing.source.importUniqueId }) };
    const semantic = mappings.get(entity.layer) ?? null;
    let disposition;
    const issues = entity.issues.map(item => ({ ...item }));
    if (semantic === 'ignore') disposition = 'ignored';
    else if (issues.some(item => !['UNSUPPORTED_ENTITY', 'UNSUPPORTED_GEOMETRY'].includes(item.code))) disposition = 'invalid';
    else if (semantic === null) disposition = 'unmapped_layer';
    else if (semantic !== semanticByKind[options.targetKind]) disposition = 'other_target';
    else if (entity.type !== 'LINE') disposition = 'unsupported';
    else if (!knownUnits) {
      disposition = 'unknown_units';
      issues.push(issue('UNITS_UNKNOWN', 'Cannot convert source coordinates to millimetres without explicit source units.'));
    } else {
      const { from: fromMm, to: toMm, length: lengthMm } = entity.axisMm ?? {};
      if (!entity.axisMm) {
        disposition = 'invalid'; issues.push(issue('CONVERSION_OVERFLOW', 'Unit conversion exceeds finite coordinate range.'));
      } else if (lengthMm === 0) {
        disposition = 'degenerate'; issues.push(issue('ZERO_LENGTH', 'Zero-length lines cannot define an axis.'));
      } else {
        disposition = 'candidate';
        const pointKeys = [JSON.stringify(fromMm), JSON.stringify(toMm)].sort();
        const geometryKey = JSON.stringify(pointKeys);
        const duplicateOf = seen.get(geometryKey) ?? null;
        const id = entity.sourceKey;
        if (!duplicateOf) seen.set(geometryKey, id);
        candidates.push({ id, sourceKey: entity.sourceKey, sourceEntity, sourceProvenance: structuredClone(entity.provenance),
          objectKind: options.targetKind, semantic,
          sourceAxis: structuredClone(entity.sourceAxis),
          cadAxisMm: { from: fromMm, to: toMm, length: lengthMm },
          requestedParameters: { ...specification }, missingInputs: [...missingInputs], duplicateOf,
          warnings: duplicateOf ? [issue('DUPLICATE_AXIS', 'Coincident or reversed source axis; review before creating anything.')] : [] });
      }
    }
    counts[disposition]++;
    dispositions.push({ sourceKey: entity.sourceKey, sourceEntity, semantic, disposition, issues });
  }
  let totalLength = 0;
  for (const candidate of candidates) {
    totalLength += candidate.cadAxisMm.length;
    if (!Number.isFinite(totalLength)) { totalLength = null; break; }
  }
  const aggregateIssues = totalLength === null
    ? [issue('TOTAL_LENGTH_OVERFLOW', 'Candidate lengths are finite individually, but their total is outside the finite range.')]
    : [];
  return { ok: true, value: {
    schemaVersion: 1, source: { ...drawing.source }, sourceUnits: { ...drawing.sourceUnits },
    coordinateInterpretation: { ...drawing.coordinateInterpretation },
    sourceWarnings: drawing.warnings.map(item => ({ ...item })), sourceCoverage: { ...drawing.coverage },
    sourcePage: { ...drawing.page }, sourceCompleteness: { ...drawing.completeness },
    aggregateIssues,
    targetKind: options.targetKind, layerMappings: options.layerMappings.map(rule => ({ ...rule })),
    specification: { ...specification },
    candidates, dispositions, coverage: { examinedEntityCount: entities.length, counts,
      totalCandidateLengthMm: totalLength, totalCandidateLengthKnown: totalLength !== null },
    review: { required: true, modelCreationEnabled: false,
      unresolvedInputs: [...missingInputs], sourceGeometryConfirmed: false },
    limitations: [
      'Candidate interpretation is read-only; neither reader evidence nor a candidate preview proves native model creation.',
      'A page describes only its returned entities; global enumeration and interpretation completeness remain separate.',
      'Layer mappings are explicit user/test rules, not inferred engineering semantics.',
      'CAD coordinates and requested modelling dimensions/elevation are distinct; no source geometry is overwritten.',
      'No snapping, intersections, fittings, openings, type matching, creation or duplicate-model detection is performed.',
    ],
  } };
}
