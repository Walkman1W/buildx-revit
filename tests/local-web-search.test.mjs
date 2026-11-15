import assert from 'node:assert/strict';
import {copyFile, mkdtemp, readFile, rmdir, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createLocalWebSearch, localWebAvailability, searchLocalWeb, validateLocalWebQuery} from '../lib/local-web-search.mjs';

const key = 'synthetic-fixture-key-only';

async function fixture(t, name = 'provider') {
  const directory = await mkdtemp(path.join(tmpdir(), 'buildx-local-search-test-'));
  const entry = path.join(directory, `${name}.mjs`);
  t.after(async () => {
    for (const file of [entry, path.join(directory, 'package.json'), path.join(directory, 'observed.json')]) {
      await unlink(file).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    }
    await rmdir(directory);
  });
  await copyFile(new URL('../test-support/local-web-provider-fixture.mjs', import.meta.url), entry);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({name: '@brave/brave-search-mcp-server', version: '2.1.4'}));
  const search = createLocalWebSearch({locate: async () => entry});
  const readObserved = async () => JSON.parse(await readFile(path.join(directory, 'observed.json'), 'utf8'));
  return {directory, search, readObserved};
}

test('authorized public query is passed unchanged through stdio and original sources are normalized', async t => {
  const {search, readObserved} = await fixture(t);
  const query = 'site:example.com  水泵 DN100 “performance”';
  const result = await search({query, apiKey: key});
  assert.deepEqual(result, {query, provider: 'brave', sources: [
    {title: 'Example Pump', url: 'https://example.com/docs/pump', snippet: 'Bilingual pump 公制水泵'},
    {title: 'Second source', url: 'https://example.org/pumps', snippet: ''},
  ]});
  const observations = await readObserved();
  assert.equal(observations.forwardedHome, false);
  assert.deepEqual(observations.flags, ['--transport', 'stdio', '--enabled-tools', 'brave_web_search', '--logging-level', 'error']);
  assert.deepEqual(observations.calls, [{name: 'brave_web_search', arguments: {
    query, count: 8, result_filter: ['web'], text_decorations: false, spellcheck: false,
  }}]);
  assert.throws(() => process.kill(observations.pid, 0), {code: 'ESRCH'});
});

test('scope validation rejects empty, multiline, oversized and local-file queries before dispatch', async t => {
  let located = 0;
  const search = createLocalWebSearch({locate: async () => { located++; }});
  for (const query of ['', ' query', 'line\nnext', 'C:\\Clients\\Confidential.pdf', 'file:///tmp/local.txt', '/home/buildx/a.pdf', 'x'.repeat(401), Array(51).fill('pump').join(' '), key]) {
    await assert.rejects(search({query, apiKey: key}), {code: 'WEB_SEARCH_QUERY_INVALID'});
  }
  assert.equal(located, 0);
  assert.equal(validateLocalWebQuery('公开 资料'), '公开 资料');
});

test('missing credentials and incorrect provider installation are surfaced safely', async t => {
  const {directory} = await fixture(t);
  assert.deepEqual(await localWebAvailability({}), {available: false, code: 'WEB_SEARCH_NOT_CONFIGURED'});
  assert.deepEqual(await localWebAvailability({braveRoot: directory, apiKey: key}), {available: false, code: 'WEB_SEARCH_PROVIDER_UNAVAILABLE'});
  await assert.rejects(searchLocalWeb({query: 'public query', braveRoot: directory, apiKey: key}), {code: 'WEB_SEARCH_PROVIDER_UNAVAILABLE'});
});

test('extra tools advertised by the child block search dispatch', async t => {
  const {search, readObserved} = await fixture(t, 'wide-provider');
  await assert.rejects(search({query: 'public query', apiKey: key}), {code: 'WEB_SEARCH_PROVIDER_UNAVAILABLE'});
  assert.deepEqual((await readObserved()).calls, []);
});

test('empty result, provider error and oversized response remain distinct', async t => {
  const {search} = await fixture(t);
  assert.deepEqual((await search({query: 'test no result', apiKey: key})).sources, []);
  await assert.rejects(search({query: 'test provider failure', apiKey: key}), failure => {
    assert.equal(failure.code, 'WEB_SEARCH_PROVIDER_ERROR');
    assert.doesNotMatch(failure.message, new RegExp(key));
    return true;
  });
  await assert.rejects(search({query: 'test large response', apiKey: key}), {code: 'WEB_SEARCH_INVALID_RESPONSE'});
});

test('cancellation closes the scoped provider and never replays a dispatched query', async t => {
  const {search, readObserved} = await fixture(t);
  const controller = new AbortController();
  const searchResult = search({query: 'test wait for cancellation', apiKey: key, signal: controller.signal});
  const rejection = assert.rejects(searchResult, {code: 'WEB_SEARCH_CANCELLED'});
  let observed;
  for (let i = 0; i < 100; i++) {
    try { observed = await readObserved(); } catch { /* The fixture is not ready. */ }
    if (observed?.calls.length) break;
    await delay(20);
  }
  controller.abort();
  await rejection;
  assert.equal(observed?.calls.length, 1);
  assert.throws(() => process.kill(observed.pid, 0), {code: 'ESRCH'});
});
