import {randomUUID} from 'node:crypto';
import {crc32, inflateSync} from 'node:zlib';

const IMAGE_API = 'https://api.openai.com/v1/images/';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 65536;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_SCANLINE_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const PNG_DEPTHS = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export const LOCAL_IMAGE_PROVIDER = Object.freeze({
  provider: 'openai', model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'medium', format: 'png',
});

const messages = Object.freeze({
  IMAGE_NOT_CONFIGURED: '此候选尚未配置 Images API 凭据。',
  IMAGE_INPUT_INVALID: '请使用有效的短提示词和本轮选择的 PNG 或 JPEG。',
  IMAGE_CANCELLED: '发送前已取消生图。',
  IMAGE_PROVIDER_REJECTED: '生图服务拒绝了请求，请核对提示词、权限或额度。',
  IMAGE_PROVIDER_UNCONFIRMED: '生图服务结果尚未核实，请核对原回执。',
  IMAGE_RESPONSE_INVALID: '生成结果无法验证为完整 PNG，请核对原回执。',
});

function failure(code, outcome = 'not_started') {
  return Object.assign(new Error(messages[code]), {code, localToolCode: code, outcome});
}

function validApiKey(apiKey) {
  return typeof apiKey === 'string' && /^[A-Za-z0-9_-]{12,512}$/u.test(apiKey);
}

export function localImageAvailability({apiKey} = {}) {
  return validApiKey(apiKey) ? {available: true, ...LOCAL_IMAGE_PROVIDER} : {available: false, code: 'IMAGE_NOT_CONFIGURED'};
}

function scanlineLayout(width, height, depth, channels, interlace) {
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  return passes.map(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx), rows = Math.ceil((height - y) / dy);
    return columns > 0 && rows > 0 ? {rows, step: 1 + Math.ceil(columns * depth * channels / 8)} : {rows: 0, step: 0};
  });
}

// Validate all chunks and only inflate up to the exact scanline budget implied
// by the image dimensions and colour format. This is independent of response size.
function verifiedPng(bytes) {
  if (bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const [depth, colour, compression, filter, interlace] = bytes.subarray(24, 29);
  if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_IMAGE_PIXELS ||
      !PNG_DEPTHS[colour]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) return false;
  const scans = scanlineLayout(width, height, depth, PNG_CHANNELS[colour], interlace);
  const scanlineBytes = scans.reduce((sum, {rows, step}) => sum + rows * step, 0);
  if (scanlineBytes > MAX_SCANLINE_BYTES) return false;

  const compressed = [];
  let chunks = 0, sawPalette = false, dataClosed = false, offset = 8;
  while (offset + 12 <= bytes.length && ++chunks <= 4096) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) return false;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/u.test(type) || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
    if (type === 'IHDR' && offset !== 8) return false;
    if (type === 'PLTE') {
      if (sawPalette || compressed.length || !length || length % 3 || length > 768 || colour === 0 || colour === 4 || colour === 3 && length > 3 * 2 ** depth) return false;
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (dataClosed || colour === 3 && !sawPalette) return false;
      compressed.push(bytes.subarray(offset + 8, end));
    } else if (compressed.length) {
      dataClosed = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || end + 4 !== bytes.length || !compressed.length) return false;
      try {
        const inflated = inflateSync(Buffer.concat(compressed), {maxOutputLength: scanlineBytes});
        if (inflated.length !== scanlineBytes) return false;
        let rowOffset = 0;
        for (const {rows, step} of scans) {
          for (let row = 0; row < rows; row++, rowOffset += step) if (inflated[rowOffset] > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    if (type[0] === type[0].toUpperCase() && !['IHDR', 'PLTE', 'IDAT'].includes(type)) return false;
    offset = end + 4;
  }
  return false;
}

function validatedReference(reference) {
  if (reference === undefined) return null;
  const bytes = reference?.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_REFERENCE_BYTES) throw failure('IMAGE_INPUT_INVALID');
  const mediaType = reference.mediaType;
  const extension = mediaType === 'image/png' && bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png'
    : mediaType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
    : null;
  if (!extension) throw failure('IMAGE_INPUT_INVALID');
  return {file: new Blob([bytes], {type: mediaType}), name: `reference.${extension}`};
}

async function readPngResponse(response) {
  const length = Number(response.headers.get('content-length'));
  if (!response.body || length > MAX_RESPONSE_BYTES || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {});
    throw failure('IMAGE_RESPONSE_INVALID', 'unknown');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw failure('IMAGE_RESPONSE_INVALID', 'unknown');
    chunks.push(Buffer.from(chunk));
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('IMAGE_RESPONSE_INVALID', 'unknown'); }
  const encoded = result?.data?.[0]?.b64_json;
  if (!Array.isArray(result?.data) || result.data.length !== 1 || typeof encoded !== 'string' || encoded.length % 4 ||
      encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw failure('IMAGE_RESPONSE_INVALID', 'unknown');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || !verifiedPng(bytes)) throw failure('IMAGE_RESPONSE_INVALID', 'unknown');
  return bytes;
}

// fetcher is a trusted composition dependency for protocol fixtures. No image
// argument can change the provider, origin, model or authentication header.
export function createLocalImageGeneration({fetcher = fetch} = {}) {
  return async function generateLocalImage({prompt, reference, signal, apiKey} = {}) {
    if (!validApiKey(apiKey)) throw failure('IMAGE_NOT_CONFIGURED');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || prompt.includes('\0') || prompt.includes(apiKey)) {
      throw failure('IMAGE_INPUT_INVALID');
    }
    const inputImage = validatedReference(reference);
    const params = {model: LOCAL_IMAGE_PROVIDER.model, prompt, n: 1, size: LOCAL_IMAGE_PROVIDER.size,
      quality: LOCAL_IMAGE_PROVIDER.quality, output_format: LOCAL_IMAGE_PROVIDER.format};
    const headers = {authorization: `Bearer ${apiKey}`, accept: 'application/json', 'x-client-request-id': randomUUID()};
    let body;
    if (inputImage) {
      body = new FormData();
      for (const [key, value] of Object.entries(params)) body.append(key, String(value));
      body.append('image[]', inputImage.file, inputImage.name);
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }
    if (signal?.aborted) throw failure('IMAGE_CANCELLED');
    const timeout = AbortSignal.timeout(115000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(IMAGE_API + (inputImage ? 'edits' : 'generations'), {
        method: 'POST', headers, body, signal: requestSignal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) throw failure('IMAGE_PROVIDER_REJECTED');
        throw failure('IMAGE_PROVIDER_UNCONFIRMED', 'unknown');
      }
      return await readPngResponse(response);
    } catch (cause) {
      // Even if the client loses the response, the provider may have started.
      // Do not retry, or retain exception details containing headers or prompts.
      if (Object.hasOwn(messages, cause?.localToolCode)) throw failure(cause.localToolCode, cause.outcome);
      throw failure('IMAGE_PROVIDER_UNCONFIRMED', 'unknown');
    }
  };
}

export const generateLocalImage = createLocalImageGeneration();
