import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';
import {crc32, deflateSync} from 'node:zlib';
import {createLocalImageGeneration, LOCAL_IMAGE_PROVIDER, localImageAvailability} from './lib/local-image-generation.mjs';

const fakeKey = 'synthetic-images-key-never-remote';

function png({width = 3, height = 2, content = Buffer.alloc((width * 4 + 1) * height)} = {}) {
  function chunk(type, bytes) {
    const framed = Buffer.alloc(bytes.length + 12);
    framed.writeUInt32BE(bytes.length, 0);
    framed.write(type, 4, 'ascii');
    bytes.copy(framed, 8);
    framed.writeUInt32BE(crc32(framed.subarray(4, framed.length - 4)), framed.length - 4);
    return framed;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(content)), chunk('IEND', Buffer.alloc(0))]);
}

const pngResponse = image => JSON.stringify({data: [{b64_json: image.toString('base64')}]});

async function fixture(t, {image = png(), status = 200} = {}) {
  const calls = [];
  const endpoint = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({path: req.url, headers: req.headers, method: req.method, body: Buffer.concat(chunks)});
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(status === 200 ? pngResponse(image) : JSON.stringify({error: {message: `Private provider failure with ${fakeKey}`}}));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => new Promise((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())));
  const productionUrls = [];
  const generate = createLocalImageGeneration({fetcher: (url, options) => {
    const apiUrl = new URL(url);
    productionUrls.push(apiUrl.href);
    assert.equal(apiUrl.origin, 'https://api.openai.com');
    assert.equal(options.redirect, 'error');
    return fetch(`http://127.0.0.1:${endpoint.address().port}${apiUrl.pathname}`, options);
  }});
  return {calls, generate, image, productionUrls};
}

test('text-only uses one bounded generations request and returns a structurally verified PNG', async t => {
  const {calls, generate, image, productionUrls} = await fixture(t);
  const prompt = 'A bilingual pump catalogue cover. 水泵目录';
  assert.deepEqual(await generate({prompt, apiKey: fakeKey}), image);
  assert.deepEqual(productionUrls, ['https://api.openai.com/v1/images/generations']);
  assert.equal(calls[0].path, '/v1/images/generations');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, `Bearer ${fakeKey}`);
  assert.match(calls[0].headers['x-client-request-id'], /^[a-f0-9-]{36}$/u);
  assert.deepEqual(JSON.parse(calls[0].body.toString()), {prompt, model: LOCAL_IMAGE_PROVIDER.model,
    size: '1024x1024', quality: 'medium', n: 1, output_format: 'png'});
});

test('editing uploads only the selected reference bytes in the documented image[] multipart field', async t => {
  const {calls, generate, image, productionUrls} = await fixture(t);
  const reference = png({width: 2, height: 1});
  const prompt = 'Keep the reference pump outline; replace the background.';
  assert.deepEqual(await generate({prompt, apiKey: fakeKey, reference: {bytes: reference, mediaType: 'image/png'}}), image);
  assert.deepEqual(productionUrls, ['https://api.openai.com/v1/images/edits']);
  const fields = await new Response(calls[0].body, {headers: {'content-type': calls[0].headers['content-type']}}).formData();
  assert.deepEqual([...fields.keys()], ['model', 'prompt', 'n', 'size', 'quality', 'output_format', 'image[]']);
  assert.equal(fields.get('prompt'), prompt);
  const selected = fields.getAll('image[]');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, 'reference.png');
  assert.equal(selected[0].type, 'image/png');
  assert.deepEqual(Buffer.from(await selected[0].arrayBuffer()), reference);
});

test('missing configuration, miscoded attachment and pre-dispatch cancellation make no request', async t => {
  const {generate, calls} = await fixture(t);
  assert.deepEqual(localImageAvailability({}), {available: false, code: 'IMAGE_NOT_CONFIGURED'});
  await assert.rejects(generate({prompt: 'Test'}), {localToolCode: 'IMAGE_NOT_CONFIGURED', outcome: 'not_started'});
  await assert.rejects(generate({prompt: 'Test', apiKey: fakeKey, reference: {bytes: png(), mediaType: 'image/jpeg'}}),
    {localToolCode: 'IMAGE_INPUT_INVALID', outcome: 'not_started'});
  await assert.rejects(generate({prompt: 'Test', apiKey: fakeKey, signal: AbortSignal.abort()}),
    {localToolCode: 'IMAGE_CANCELLED', outcome: 'not_started'});
  assert.equal(calls.length, 0);
});

test('bogus PNG, compressed expansion, and oversized dimensions fail closed after exactly one call', async t => {
  const damaged = png(); damaged[damaged.length - 1] ^= 1;
  const variants = [damaged, png({content: Buffer.alloc(500000)}), png({width: 9000, height: 1, content: Buffer.alloc(1)})];
  for (const candidate of variants) {
    const {generate, calls} = await fixture(t, {image: candidate});
    await assert.rejects(generate({prompt: 'Test', apiKey: fakeKey}), {localToolCode: 'IMAGE_RESPONSE_INVALID', outcome: 'unknown'});
    assert.equal(calls.length, 1);
  }
});

test('provider errors omit private response body, distinguish rejection from unknown, and do not retry', async t => {
  for (const [status, code, outcome] of [[401, 'IMAGE_PROVIDER_REJECTED', 'not_started'], [503, 'IMAGE_PROVIDER_UNCONFIRMED', 'unknown']]) {
    const {generate, calls} = await fixture(t, {status});
    await assert.rejects(generate({prompt: 'Test', apiKey: fakeKey}), error => {
      assert.equal(error.localToolCode, code);
      assert.equal(error.outcome, outcome);
      assert.doesNotMatch(error.message, new RegExp(fakeKey));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});
