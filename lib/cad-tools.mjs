import { normalizeCadCandidateOptions, buildCadCandidates } from './cad-candidates.mjs';
import { normalizeCadInventory } from './cad-inventory.mjs';
import { CAD_DOCUMENT_PATH_MAX_LENGTH, isSavedCadDocumentPath, sameCadDocumentPath } from './cad-document-path.mjs';

export const CAD_RESPONSE_MAX_BYTES = 128 * 1024;
const savedDocument = { type: 'string', minLength: 1, maxLength: CAD_DOCUMENT_PATH_MAX_LENGTH };
const paging = {
  offset: { type: 'integer', minimum: 0, maximum: 15000, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  expected_snapshot: { type: 'string', minLength: 64, maxLength: 64 },
};
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const CAD_TOOLS = [
  {
    name: 'revit_list_cad_imports',
    description: 'List actual CAD ImportInstance identities in the saved current Revit document, including linked/imported state. Read-only; requires host 0.5.0+. Bounded pages and snapshot identity: for offset>0 reuse the returned snapshotId as expected_snapshot. A changed snapshot must be refreshed from offset0. Coverage concerns retained Revit imports, not all entities in an original DWG.',
    inputSchema: schema({ expected_document: savedDocument, name_contains: { type: 'string', maxLength: 200, default: '' }, ...paging }, ['expected_document']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'revit_preview_cad_candidates',
    description: 'Read bounded LINE/PolyLine geometry from one actual ImportInstance and derive review-only wall OR pipe axis candidates with explicit, case-sensitive layer mappings. Requires host0.5.0+ and a saved document. Uses Revit model millimetres already transformed once; original CAD units may remain unknown. No modelling, transaction, view change or file save. Missing dimensions/types/levels remain unresolved. A partial page/budget is never a whole-DWG result. Continue with nextOffset and the same expected_snapshot; refresh if changed. Candidates require review and never authorize creation.',
    inputSchema: schema({
      expected_document: savedDocument,
      import_element_id: { anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        { type: 'string', minLength: 1, maxLength: 19 }] },
      target_kind: { type: 'string', enum: ['wall', 'pipe'] },
      layer_mappings: { type: 'array', minItems: 1, maxItems: 100,
        items: schema({ layer: { type: 'string', minLength: 1, maxLength: 255 },
          semantic: { type: 'string', enum: ['wall_centerline', 'pipe_centerline', 'ignore'] } }, ['layer', 'semantic']) },
      specification: { ...schema({ heightMm: { type: 'number', exclusiveMinimum: 0 },
        thicknessMm: { type: 'number', exclusiveMinimum: 0 }, elevationMm: { type: 'number' },
        diameterMm: { type: 'number', exclusiveMinimum: 0 } }, []), default: {} },
      ...paging,
    }, ['expected_document', 'import_element_id', 'target_kind', 'layer_mappings']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];
export const CAD_OPERATION_BY_TOOL = {
  revit_list_cad_imports: 'list_cad_imports',
  revit_preview_cad_candidates: 'read_cad_geometry',
};
export const isCadTool = name => Object.hasOwn(CAD_OPERATION_BY_TOOL, name);
const samePath = sameCadDocumentPath;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimalId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertCadArguments(name, args) {
  if (!isSavedCadDocumentPath(args.expected_document))
    throw new Error('CAD tools require the exact saved absolute Windows document path');
  if (args.expected_snapshot !== undefined && !hash(args.expected_snapshot)) throw new Error('Invalid CAD expected_snapshot');
  if (args.offset > 0 && !hash(args.expected_snapshot)) throw new Error('CAD pages after offset0 require expected_snapshot');
  if (name === 'revit_preview_cad_candidates') {
    if (!decimalId(String(args.import_element_id))) throw new Error('CAD import_element_id must be a positive decimal Int64 identity');
    const result = normalizeCadCandidateOptions({ targetKind: args.target_kind,
      layerMappings: args.layer_mappings, specification: args.specification });
    if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  }
}

// Candidate rules belong to Node's common owner, not the native geometry reader.
export function cadHostArguments(name, args) {
  const { expected_document, offset, limit, expected_snapshot } = args;
  return { expected_document, offset, limit,
    ...(expected_snapshot === undefined ? {} : { expected_snapshot }),
    ...(name === 'revit_list_cad_imports' ? { name_contains: args.name_contains } : { import_element_id: String(args.import_element_id) }) };
}

function assertPage(page, args, length) {
  if (!object(page) || page.offset !== args.offset || page.limit !== args.limit ||
      page.returned !== length || !Number.isSafeInteger(page.returned) || page.returned < 0 || page.returned > args.limit ||
      !Number.isSafeInteger(page.totalRetainedEntities) || page.totalRetainedEntities < page.offset + length ||
      !hash(page.snapshotId) || typeof page.enumerationComplete !== 'boolean') throw new Error('CAD page contract mismatch');
  const next = page.offset + length < page.totalRetainedEntities ? page.offset + length : null;
  if (page.nextOffset !== next || (next !== null && length === 0)) throw new Error('CAD page does not advance or hides retained entities');
  if (args.expected_snapshot !== undefined && page.snapshotId !== args.expected_snapshot) throw new Error('CAD snapshot changed; refresh from offset0');
}

export function projectCadResult(name, result, args, { sessionId, responsePath }) {
  if (!object(result) || result.operation !== CAD_OPERATION_BY_TOOL[name] || result.hostSession !== sessionId ||
      !samePath(result.document?.path, args.expected_document) || result.modifiedByOperation !== false ||
      Object.hasOwn(result, 'mode') || Object.hasOwn(result, 'committed')) throw new Error('CAD read identity or read-only result mismatch');
  const native = result.value;
  if (!object(native)) throw new Error('CAD result value missing');
  if (name === 'revit_list_cad_imports') {
    if (!samePath(native.documentPath, args.expected_document) ||
        !(native.documentFingerprint === null || typeof native.documentFingerprint === 'string') || !Array.isArray(native.items))
      throw new Error('CAD import inventory identity missing');
    assertPage(native.page, args, native.items.length);
    if (!object(native.coverage) || typeof native.coverage.enumerationComplete !== 'boolean' ||
        native.coverage.enumerationComplete !== native.page.enumerationComplete ||
        !Number.isSafeInteger(native.coverage.examinedImports) || native.coverage.examinedImports < native.page.totalRetainedEntities ||
        native.coverage.examinedImports > 5000 || native.coverage.maxImports !== 5000) throw new Error('CAD import coverage missing');
    if (!Array.isArray(native.warnings) || native.warnings.length > 101 || native.warnings.some(warning =>
      !object(warning) || typeof warning.code !== 'string' || !warning.code || typeof warning.message !== 'string' ||
      !(warning.path === null || typeof warning.path === 'string'))) throw new Error('CAD import diagnostics missing or malformed');
    const identities = new Set();
    for (const item of native.items) {
      if (!object(item) || !decimalId(item.elementId) || typeof item.uniqueId !== 'string' || !item.uniqueId ||
          !(item.name === null || typeof item.name === 'string') || typeof item.isLinked !== 'boolean' || identities.has(item.elementId))
        throw new Error('CAD import item identity invalid');
      identities.add(item.elementId);
    }
    return { ...result, logical_tool: name, source_evidence: responsePath };
  }
  if (!samePath(native.source?.documentPath, args.expected_document) ||
      String(native.source?.importElementId) !== String(args.import_element_id) || native.source?.format !== 'revit-import-instance')
    throw new Error('CAD geometry source does not match requested document/import');
  assertPage(native.page, args, native.entities?.length);
  const inventory = normalizeCadInventory(native);
  if (!inventory.ok) throw new Error(inventory.error.code + ': ' + inventory.error.message);
  const candidates = buildCadCandidates(inventory.value, { targetKind: args.target_kind,
    layerMappings: args.layer_mappings, specification: args.specification });
  if (!candidates.ok) throw new Error(candidates.error.code + ': ' + candidates.error.message);
  // The raw host payload stays in outbox. Return one common candidate protocol,
  // retaining the real host operation and explicit derivation provenance.
  return { ...result, value: candidates.value, logical_tool: name, source_evidence: responsePath,
    value_derivation: 'cad-inventory-v1-to-review-only-candidates' };
}
