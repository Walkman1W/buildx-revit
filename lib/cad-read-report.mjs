import { isDeepStrictEqual } from 'node:util';
import { isSavedCadDocumentPath, sameCadDocumentPath } from './cad-document-path.mjs';
import { normalizeCadCandidateOptions } from './cad-candidates.mjs';

const MAX_RETAINED_ENTITIES = 15000;
const dispositions = ['candidate', 'ignored', 'other_target', 'unmapped_layer', 'unsupported', 'invalid', 'unknown_units', 'degenerate'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const nonempty = x => typeof x === 'string' && x.length > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const positiveId = x => {
  if (typeof x === 'number' && !Number.isSafeInteger(x)) return null;
  if (!['number', 'string'].includes(typeof x)) return null;
  const value = String(x);
  return /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : null;
};
const finitePoint = x => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);

/**
 * Account for an already fetched sequence of production candidate-read results.
 * This is not a fetch loop, inventory merger, CAD interpreter or model authority.
 * On failure only the accepted prefix contributes to partial totals/evidence.
 */
export function summarizeCadCandidateRead(pages, options) {
  const accepted = [], evidence = [], seenKeys = new Set();
  const counts = Object.fromEntries(dispositions.map(k => [k, 0]));
  let first = null, expectedOffset = 0, terminal = false;
  let candidateCount = 0, totalLength = 0, lengthOverflow = false;
  let enumerationComplete = null, interpretationComplete = null;

  function summary() {
    return {
      schemaVersion: 1, kind: 'cad-candidate-read-report', pages: [...accepted], source_evidence: [...evidence],
      acceptedPageCount: accepted.length, expectedNextOffset: terminal ? null : expectedOffset,
      source: first?.source ?? null, hostSession: first?.hostSession ?? null, snapshotId: first?.snapshotId ?? null,
      targetKind: first?.targetKind ?? options?.targetKind ?? null,
      layerMappings: first?.layerMappings ?? null, specification: first?.specification ?? null,
      sourceWarnings: first?.sourceWarnings ?? null, sourceCoverage: first?.sourceCoverage ?? null,
      sourceUnits: first?.sourceUnits ?? null, coordinateInterpretation: first?.coordinateInterpretation ?? null,
      examinedEntityCount: expectedOffset, totalRetainedEntities: first?.totalRetainedEntities ?? null,
      candidateCount, dispositionCounts: { ...counts }, totalCandidateLengthMm: lengthOverflow ? null : totalLength,
      totalCandidateLengthKnown: !lengthOverflow,
      aggregateIssues: lengthOverflow ? [{ code: 'TOTAL_LENGTH_OVERFLOW',
        message: 'Accepted candidate lengths exceed the finite numeric range; no finite total is claimed.' }] : [],
      completeness: { enumerationComplete, interpretationComplete,
        pageSetComplete: accepted.length > 0 && terminal, dwgCompleteness: null, realRevitExecution: null },
      review: { required: true, modelCreationEnabled: false },
      limitations: [
        'A complete page sequence accounts only for the retained native inventory; it does not prove complete DWG contents.',
        'No cross-page geometry deduplication is performed; each candidate duplicateOf remains page-local.',
        'Read reports do not authorize model creation or establish actual Revit execution.',
      ],
    };
  }
  const fail = (code, message, pageIndex = null) => {
    const partial = summary();
    partial.completeness.pageSetComplete = false;
    return { ok: false, error: { code, message, ...(pageIndex === null ? {} : { pageIndex }) }, partial };
  };
  if (!object(options) || Object.keys(options).some(k => !['expectedDocument', 'importElementId', 'targetKind'].includes(k)) ||
      !isSavedCadDocumentPath(options.expectedDocument) || !positiveId(options.importElementId) || !['wall', 'pipe'].includes(options.targetKind))
    return fail('INVALID_READ_EXPECTATION', 'Specify the saved Windows document, positive ImportInstance Int64 ID and one target kind.');
  if (!Array.isArray(pages) || pages.length === 0) return fail('MISSING_PAGES', 'At least one candidate-read page from offset0 is required.');
  if (pages.length > MAX_RETAINED_ENTITIES) return fail('PAGE_LIMIT', 'Page count exceeds the native retained-entity budget.');
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const envelope = pages[pageIndex], value = envelope?.value;
    if (terminal) return fail('EXTRA_PAGE', 'A page follows the terminal retained-inventory page.', pageIndex);
    if (!object(envelope) || envelope.operation !== 'read_cad_geometry' || envelope.logical_tool !== 'revit_preview_cad_candidates' ||
        envelope.modifiedByOperation !== false || Object.hasOwn(envelope, 'mode') || Object.hasOwn(envelope, 'committed') ||
        !nonempty(envelope.hostSession) || !sameCadDocumentPath(envelope.document?.path, options.expectedDocument) ||
        !nonempty(envelope.source_evidence) || envelope.value_derivation !== 'cad-inventory-v1-to-review-only-candidates')
      return fail('INVALID_READ_ENVELOPE', 'A production read-only candidate result with document, session and source evidence is required.', pageIndex);
    if (!object(value) || value.schemaVersion !== 1 || !object(value.source) || value.source.format !== 'revit-import-instance' ||
        !sameCadDocumentPath(value.source.documentPath, options.expectedDocument) ||
        positiveId(value.source.importElementId) !== positiveId(options.importElementId) ||
        !nonempty(value.source.importUniqueId) ||
        !(value.source.documentFingerprint === null || nonempty(value.source.documentFingerprint)) ||
        value.targetKind !== options.targetKind || !object(value.review) || value.review.required !== true ||
        value.review.modelCreationEnabled !== false || value.review.sourceGeometryConfirmed !== false)
      return fail('INVALID_CANDIDATE_IDENTITY', 'Candidate source identity, target or review-only boundary is inconsistent.', pageIndex);
    const normalizedOptions = normalizeCadCandidateOptions({ targetKind: value.targetKind,
      layerMappings: value.layerMappings, specification: value.specification });
    if (!Object.hasOwn(value, 'specification') || !normalizedOptions.ok ||
        !isDeepStrictEqual(normalizedOptions.value.specification, value.specification))
      return fail('INVALID_CANDIDATE_OPTIONS', 'The result must retain normalized explicit mappings and specification.', pageIndex);
    const page = value.sourcePage, complete = value.sourceCompleteness, coverage = value.sourceCoverage;
    if (!object(page) || !integer(page.offset) || !integer(page.limit) || page.limit < 1 || page.limit > 50 ||
        !integer(page.returned) || page.returned > page.limit || !integer(page.totalRetainedEntities) ||
        page.totalRetainedEntities > MAX_RETAINED_ENTITIES || page.offset + page.returned > page.totalRetainedEntities ||
        !hash(page.snapshotId) || value.source.snapshotId !== page.snapshotId ||
        typeof page.enumerationComplete !== 'boolean' || !object(complete) ||
        typeof complete.enumerationComplete !== 'boolean' || typeof complete.interpretationComplete !== 'boolean' ||
        typeof complete.pageComplete !== 'boolean' || !object(coverage) ||
        coverage.retainedEntityCount !== page.totalRetainedEntities || coverage.enumerationComplete !== page.enumerationComplete ||
        complete.enumerationComplete !== page.enumerationComplete || typeof coverage.interpretationComplete !== 'boolean' ||
        (complete.interpretationComplete && coverage.interpretationComplete !== true) ||
        !Array.isArray(value.sourceWarnings) || !object(value.sourceUnits) || !object(value.coordinateInterpretation))
      return fail('INVALID_PAGE_EVIDENCE', 'Native page, snapshot, global coverage and completeness evidence is malformed.', pageIndex);
    const expectedNext = page.offset + page.returned < page.totalRetainedEntities ? page.offset + page.returned : null;
    if (page.nextOffset !== expectedNext || (page.returned === 0 && expectedNext !== null))
      return fail('INVALID_PAGE_PROGRESS', 'A nonterminal page must advance and expose the next retained offset.', pageIndex);
    if (complete.pageComplete !== (page.offset === 0 && page.nextOffset === null && page.returned === page.totalRetainedEntities))
      return fail('INVALID_PAGE_EVIDENCE', 'The producer pageComplete flag contradicts its retained page range.', pageIndex);
    if (page.offset !== expectedOffset)
      return fail('PAGE_ORDER_MISMATCH', 'Pages must begin at offset0 and continue at the preceding nextOffset without gaps or repeats.', pageIndex);
    const descriptor = { source: value.source, hostSession: envelope.hostSession, snapshotId: page.snapshotId,
      totalRetainedEntities: page.totalRetainedEntities, sourceCoverage: coverage, sourceWarnings: value.sourceWarnings,
      targetKind: value.targetKind, layerMappings: value.layerMappings, specification: value.specification,
      sourceUnits: value.sourceUnits, coordinateInterpretation: value.coordinateInterpretation };
    if (first) {
      if (descriptor.hostSession !== first.hostSession) return fail('HOST_SESSION_CHANGED', 'Host session changed between pages.', pageIndex);
      if (descriptor.snapshotId !== first.snapshotId) return fail('SNAPSHOT_CHANGED', 'A changed snapshot requires a fresh read from offset0.', pageIndex);
      if (!isDeepStrictEqual(descriptor.source, first.source)) return fail('SOURCE_IDENTITY_CHANGED', 'Source document/import identity or metadata changed between pages.', pageIndex);
      if (!isDeepStrictEqual(descriptor.sourceCoverage, first.sourceCoverage) || !isDeepStrictEqual(descriptor.sourceWarnings, first.sourceWarnings) ||
          descriptor.totalRetainedEntities !== first.totalRetainedEntities)
        return fail('GLOBAL_EVIDENCE_CHANGED', 'Native global coverage or warnings changed between pages.', pageIndex);
      for (const key of ['targetKind', 'layerMappings', 'specification', 'sourceUnits', 'coordinateInterpretation'])
        if (!isDeepStrictEqual(descriptor[key], first[key])) return fail('READ_SEMANTICS_CHANGED', 'Candidate options or coordinate semantics changed between pages.', pageIndex);
    }
    if (!Array.isArray(value.dispositions) || value.dispositions.length !== page.returned ||
        !Array.isArray(value.candidates) || !object(value.coverage) ||
        value.coverage.examinedEntityCount !== page.returned || !object(value.coverage.counts) ||
        Object.keys(value.coverage.counts).length !== dispositions.length ||
        dispositions.some(k => !integer(value.coverage.counts[k])) ||
        Object.values(value.coverage.counts).reduce((a, b) => a + b, 0) !== page.returned ||
        value.coverage.counts.candidate !== value.candidates.length)
      return fail('INVALID_PAGE_ACCOUNTING', 'Every returned entity must have one disposition and candidate counts must agree.', pageIndex);
    const localKeys = new Set(), candidateDispositions = new Map();
    const observed = Object.fromEntries(dispositions.map(k => [k, 0]));
    for (let index = 0; index < value.dispositions.length; index++) {
      const item = value.dispositions[index], ordinal = page.offset + index + 1;
      const sourceKey = `revit-import-instance:${page.snapshotId}:${ordinal}`;
      if (!object(item) || !object(item.sourceEntity) || item.sourceEntity.ordinal !== ordinal || item.sourceKey !== sourceKey ||
          positiveId(item.sourceEntity.importElementId) !== positiveId(options.importElementId) ||
          item.sourceEntity.importUniqueId !== value.source.importUniqueId || !dispositions.includes(item.disposition) ||
          seenKeys.has(item.sourceKey) || localKeys.has(item.sourceKey))
        return fail('ENTITY_IDENTITY_MISMATCH', 'Entity ordinals/sourceKeys must be unique and agree with this snapshot, import and page.', pageIndex);
      localKeys.add(item.sourceKey); observed[item.disposition]++;
      if (item.disposition === 'candidate') candidateDispositions.set(item.sourceKey, item.sourceEntity);
    }
    if (!isDeepStrictEqual(observed, value.coverage.counts))
      return fail('INVALID_PAGE_ACCOUNTING', 'Disposition counts do not match retained disposition records.', pageIndex);
    let pageLength = 0, pageOverflow = false;
    const candidateKeys = new Set();
    for (const candidate of value.candidates) {
      if (!object(candidate) || candidate.id !== candidate.sourceKey || !candidateDispositions.has(candidate.sourceKey) ||
          !isDeepStrictEqual(candidate.sourceEntity, candidateDispositions.get(candidate.sourceKey)) || candidateKeys.has(candidate.sourceKey) ||
          candidate.objectKind !== options.targetKind || !isDeepStrictEqual(candidate.requestedParameters, value.specification) ||
          !object(candidate.cadAxisMm) || !finitePoint(candidate.cadAxisMm.from) || !finitePoint(candidate.cadAxisMm.to) ||
          !Number.isFinite(candidate.cadAxisMm.length) || candidate.cadAxisMm.length <= 0)
        return fail('INVALID_CANDIDATE_ACCOUNTING', 'Candidate identity, explicit parameters or finite length is inconsistent.', pageIndex);
      candidateKeys.add(candidate.sourceKey);
      if (!pageOverflow) { pageLength += candidate.cadAxisMm.length; pageOverflow = !Number.isFinite(pageLength); }
    }
    if (value.coverage.totalCandidateLengthKnown !== !pageOverflow ||
        value.coverage.totalCandidateLengthMm !== (pageOverflow ? null : pageLength))
      return fail('INVALID_LENGTH_ACCOUNTING', 'Page length accounting does not agree with its retained candidates.', pageIndex);
    // Accept atomically only after all identity/accounting checks for this page.
    first ??= descriptor;
    accepted.push(envelope); evidence.push(envelope.source_evidence);
    for (const key of localKeys) seenKeys.add(key);
    for (const key of dispositions) counts[key] += observed[key];
    candidateCount += value.candidates.length;
    if (!lengthOverflow) { totalLength += pageLength; lengthOverflow = pageOverflow || !Number.isFinite(totalLength); }
    expectedOffset = page.offset + page.returned; terminal = page.nextOffset === null;
    enumerationComplete = (enumerationComplete ?? true) && complete.enumerationComplete;
    interpretationComplete = (interpretationComplete ?? true) && complete.interpretationComplete;
  }
  if (!terminal) return fail('MISSING_PAGES', `Accepted pages end before retained offset ${expectedOffset}; continue with the same snapshot.`);
  return { ok: true, value: summary() };
}
