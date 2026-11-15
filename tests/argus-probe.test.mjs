import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectionFromEnv, parseProbeEvents, runReadonlyProbe, PROBE_CODE} from '../lib/argus-readonly-probe.mjs';

const payload = {probe: 'argus-codex-readonly-v1', viewCount: 183, isModified: false, isReadOnly: false};
const stream = `event: start\r\ndata: {}\r\n\r\nevent: result\r\ndata: ${JSON.stringify({return_value: JSON.stringify(payload), error: null})}\r\n\r\n`;
test('requires explicit authentication and rejects remote or credential-bearing URLs', () => {
  assert.throws(() => connectionFromEnv({}), /AUTH_CONTEXT_REQUIRED/);
  for (const url of ['https://example.com/', 'http://127.0.0.1@evil.com/', 'http://localhost/path', 'http://localhost/?token=x']) {
    assert.throws(() => connectionFromEnv({ARGUS_PROBE_URL: url, ARGUS_PROBE_TOKEN: 'test'}), /INVALID_LOCAL_ENDPOINT/);
  }
});
test('terminal result required; progress, errors, malformed or duplicate results never pass', () => {
  assert.deepEqual(parseProbeEvents(stream), payload);
  for (const invalid of ['event: start\ndata: {}\n\n', 'event: error\ndata: {}\n\n', 'event: result\ndata: {"error": {"message":"failed"}}\n\n', stream + stream, 'event: result\ndata: invalid\n\n']) {
    assert.throws(() => parseProbeEvents(invalid));
  }
});
test('production HTTP boundary sends fixed script, no retained context, and preserves parsed result', async () => {
  const connection = connectionFromEnv({ARGUS_PROBE_URL: 'http://localhost:8865/', ARGUS_PROBE_TOKEN: 'test-token'});
  const result = await runReadonlyProbe(connection, {fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/revit/code/execute');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.code, PROBE_CODE);
    assert.equal(body.context_id, undefined);
    assert.equal(body.timeout, 15);
    return new Response(stream, {headers: {'content-type': 'text/event-stream; charset=utf-8'}});
  }});
  assert.equal(result.viewCount, 183);
  assert.equal(result.source, 'argus-original-coderunner');
});
test('authentication and transport errors do not expose secrets', async () => {
  const connection = {url: new URL('http://localhost:8865/'), token: 'private-token'};
  await assert.rejects(runReadonlyProbe(connection, {fetchImpl: async () => new Response('', {status: 401})}), /ARGUS_AUTH_REJECTED/);
  await assert.rejects(runReadonlyProbe(connection, {fetchImpl: async () => { throw new Error('private-token'); }}), error => error.message === 'ARGUS_TRANSPORT_FAILED');
});
