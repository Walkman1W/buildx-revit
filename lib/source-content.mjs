import { createHash } from 'node:crypto';
import { SOURCE_FILE_MAX_BYTES } from './source-policy.mjs';

export const SOURCE_PAGE_MAX_BYTES = 32 * 1024;
export const SOURCE_PAGE_MAX_LINES = 200;
const plainObject = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ownKeysOnly = (value, keys) => Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const success = value => ({ ok: true, value });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const nativeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;
const nativeFailure = error => {
  const code = nativeCode(error?.code);
  return fail('SOURCE_NATIVE_READ_FAILED', 'The native source read failed; it was not retried.',
    code === null ? {} : { nativeCode: code });
};

function parseRequest(request) {
  let rootId, path, startLine, maxLines, expectedSha256, maxReadBytes;
  try {
    if (!plainObject(request) || !ownKeysOnly(request, ['rootId', 'path', 'startLine', 'maxLines', 'expectedSha256', 'maxReadBytes']))
      return fail('INVALID_SOURCE_REQUEST', 'Select a source root and relative path with only named content-page parameters.');
    ({ rootId, path, startLine = 1, maxLines = 80, expectedSha256, maxReadBytes = SOURCE_FILE_MAX_BYTES } = request);
  } catch { return fail('INVALID_SOURCE_REQUEST', 'Content-page parameters could not be captured.'); }
  if (typeof rootId !== 'string' || typeof path !== 'string')
    return fail('INVALID_SOURCE_REQUEST', 'Select a source root and relative path with only named content-page parameters.');
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) ||
      maxLines < 1 || maxLines > SOURCE_PAGE_MAX_LINES)
    return fail('INVALID_SOURCE_PAGE', 'startLine must be positive and maxLines must be between 1 and 200.');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(expectedSha256)))
    return fail('INVALID_SOURCE_HASH', 'expectedSha256 must be exactly 64 hexadecimal characters.');
  if (startLine > 1 && expectedSha256 === undefined)
    return fail('SOURCE_PAGE_HASH_REQUIRED', 'Continuation pages require the SHA256 returned by the first page.');
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 0 || maxReadBytes > SOURCE_FILE_MAX_BYTES)
    return fail('INVALID_SOURCE_READ_BUDGET', 'maxReadBytes must be an integer between zero and 512 KiB.');
  return success({ rootId, path, startLine, maxLines, expectedSha256: expectedSha256?.toLowerCase(), maxReadBytes });
}

function base64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

// Check expansion, exact decoded length, padding and unused pad bits before a
// Buffer allocation. Node's permissive base64 decoder alone is not a validator.
function decodeBase64(data, byteLength, maxBytes) {
  if (typeof data !== 'string')
    return fail('INVALID_SOURCE_NATIVE_RESPONSE', 'The native source read must return a base64 string.');
  const expectedLength = 4 * Math.ceil(byteLength / 3);
  if (data.length > 4 * Math.ceil(maxBytes / 3) || data.length > expectedLength)
    return fail('SOURCE_NATIVE_PAYLOAD_TOO_LARGE', 'Native base64 exceeds the preflight byte budget.');
  if (data.length !== expectedLength || data.length % 4 !== 0)
    return fail('SOURCE_READ_SIZE_MISMATCH', 'Native content length does not match the inspected file.');
  const padding = byteLength === 0 || byteLength % 3 === 0 ? 0 : 3 - byteLength % 3;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (base64Value(data.charCodeAt(index)) < 0)
      return fail('INVALID_SOURCE_BASE64', 'Native content is not canonical base64.');
  }
  for (let index = contentLength; index < data.length; index++) {
    if (data.charCodeAt(index) !== 61)
      return fail('SOURCE_READ_SIZE_MISMATCH', 'Native base64 padding does not match the inspected file length.');
  }
  if ((padding === 2 && (base64Value(data.charCodeAt(contentLength - 1)) & 15) !== 0) ||
      (padding === 1 && (base64Value(data.charCodeAt(contentLength - 1)) & 3) !== 0))
    return fail('INVALID_SOURCE_BASE64', 'Native content has noncanonical base64 padding bits.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength !== byteLength)
    return fail('SOURCE_READ_SIZE_MISMATCH', 'Decoded content does not match the inspected file length.');
  return success(bytes);
}

function contentPage(identity, sha256, text, request, hasUtf8Bom) {
  // A terminal line separator terminates its preceding logical line; it does not
  // invent another empty line. LF, CRLF and lone CR each count as one separator.
  const allLines = text === '' ? [] : text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) allLines.pop();
  const totalLines = allLines.length;
  if (request.startLine > totalLines + 1)
    return fail('SOURCE_LINE_OUT_OF_RANGE', 'startLine is beyond the end-of-file page.');
  const remaining = Math.max(0, totalLines - request.startLine + 1);
  const limit = Math.min(request.maxLines, remaining);
  const selected = [];
  function makePage(reason) {
    const endLine = selected.length === 0 ? null : request.startLine + selected.length - 1;
    const nextLine = selected.length < remaining ? request.startLine + selected.length : null;
    return success({ schemaVersion: 1, rootId: identity.rootId, path: identity.path, sha256,
      byteLength: identity.byteLength, totalLines, hasUtf8Bom, lineBreaksNormalized: true,
      startLine: request.startLine, endLine, lines: [...selected], nextLine,
      completeness: nextLine === null ? 'complete' : 'partial',
      wholeFileReturned: request.startLine === 1 && nextLine === null,
      truncationReasons: nextLine === null ? [] : [reason] });
  }
  const fits = page => Buffer.byteLength(JSON.stringify(page), 'utf8') <= SOURCE_PAGE_MAX_BYTES;
  let current = makePage('output_byte_budget');
  if (!fits(current))
    return fail('SOURCE_OUTPUT_METADATA_TOO_LARGE', 'Source provenance cannot fit within the output page budget.');
  for (let index = 0; index < limit; index++) {
    selected.push({ lineNumber: request.startLine + index, text: allLines[request.startLine + index - 1] });
    const candidate = makePage('output_byte_budget');
    if (!fits(candidate)) {
      selected.pop();
      if (selected.length === 0)
        return fail('SOURCE_LINE_TOO_LARGE', 'A complete logical line cannot fit within the output page budget.');
      return current;
    }
    current = candidate;
  }
  return makePage('max_lines');
}

/**
 * Read-only content owner. The internally injected native readFile must bound
 * its RPC frame BEFORE JSON parsing and base64 allocation using maxBytes plus
 * protocol expansion/overhead. This module receives an already parsed response:
 * its checks do not establish a transport-frame limit or an OS sandbox.
 *
 * Only policy.inspect creates the private snapshot passed to revalidate. Neither
 * client metadata nor a returned SHA256 is an authorization token. Same-user
 * filesystem races cannot be eliminated by these before/after checks.
 * maxReadBytes narrows the current preflight/response budget only; it does not
 * authorize a source or limit memory inside a server racing later file changes.
 */
export function createSourceContentReader(options) {
  const invalid = () => fail('INVALID_SOURCE_CONTENT_READER',
    'A trusted source policy and bounded native readFile callback are required.');
  if (!plainObject(options) || !ownKeysOnly(options, ['policy', 'readFile'])) return invalid();
  // Snapshot each trusted dependency exactly once before validating it. Wrappers
  // need not be frozen; later edits or accessor changes cannot expand this reader.
  let policy, readFile, inspectMethod, revalidateMethod, maxFileBytes;
  try {
    policy = options.policy;
    readFile = options.readFile;
    inspectMethod = policy?.inspect;
    revalidateMethod = policy?.revalidate;
    maxFileBytes = policy?.maxFileBytes;
  } catch { return invalid(); }
  if (typeof inspectMethod !== 'function' || typeof revalidateMethod !== 'function' ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > SOURCE_FILE_MAX_BYTES ||
      typeof readFile !== 'function')
    return invalid();
  const inspect = inspectMethod.bind(policy), revalidate = revalidateMethod.bind(policy);
  async function read(request) {
    const parsed = parseRequest(request);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    let inspected;
    try { inspected = await inspect({ rootId: input.rootId, path: input.path }); }
    catch { return fail('SOURCE_INSPECTION_FAILED', 'Source metadata inspection failed.'); }
    if (!inspected.ok) return inspected;
    const snapshot = inspected.value;
    if (snapshot.kind !== 'file')
      return fail('SOURCE_NOT_FILE', 'Content pages require an ordinary source file.');
    if (!Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 0 ||
        snapshot.byteLength > maxFileBytes)
      return fail('SOURCE_FILE_TOO_LARGE', 'Inspected source bytes exceed the configured pre-read budget.');
    if (snapshot.byteLength > input.maxReadBytes)
      return fail('SOURCE_READ_BUDGET_EXCEEDED', 'Inspected source bytes exceed the requested pre-read byte budget.');
    let native;
    try { native = await readFile(snapshot.absolutePath, { maxBytes: snapshot.byteLength }); }
    catch (error) { return nativeFailure(error); }
    if (!plainObject(native) || (native.ok !== true && native.ok !== false))
      return fail('INVALID_SOURCE_NATIVE_RESPONSE', 'The native source read must return a tagged result.');
    if (!native.ok) return nativeFailure(native.error);
    if (!plainObject(native.value) || !ownKeysOnly(native.value, ['dataBase64']))
      return fail('INVALID_SOURCE_NATIVE_RESPONSE', 'The native source read must return only dataBase64.');
    const decoded = decodeBase64(native.value.dataBase64, snapshot.byteLength, maxFileBytes);
    if (!decoded.ok) return decoded;
    const sha256 = createHash('sha256').update(decoded.value).digest('hex');
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256)
      return fail('SOURCE_CONTENT_CHANGED', 'Source SHA256 no longer matches the requested content snapshot.');
    let validated;
    try { validated = await revalidate(snapshot); }
    catch { return fail('SOURCE_REVALIDATION_FAILED', 'Source metadata revalidation failed.'); }
    if (!validated.ok) return validated;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded.value); }
    catch { return fail('SOURCE_INVALID_UTF8', 'Source content is not valid UTF-8.'); }
    if (text.includes('\0'))
      return fail('SOURCE_BINARY_CONTENT', 'NUL-containing content is not supported as source text.');
    const hasUtf8Bom = decoded.value.length >= 3 && decoded.value[0] === 239 && decoded.value[1] === 187 && decoded.value[2] === 191;
    if (hasUtf8Bom) text = text.slice(1);
    return contentPage(snapshot, sha256, text, input, hasUtf8Bom);
  }
  return success(Object.freeze({ read }));
}
