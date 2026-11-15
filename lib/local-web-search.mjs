import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, realpath, rmdir} from 'node:fs/promises';
import {isIP} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TextDecoder} from 'node:util';

const PACKAGE = '@brave/brave-search-mcp-server';
const VERSION = '2.1.4';
const ENTRY_SHA256 = 'fcf201a52a9989ee228f0461dc1f5cf8f27c9e398c56cb75e2c26b6c0a261f50';
const WEB_TOOL = 'brave_web_search';
const PROTOCOL_VERSION = '2025-11-25';
const KNOWN_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULTS = 8;
const STARTUP_AND_CALL_TIMEOUT_MS = 30000;

const errorMessages = Object.freeze({
  WEB_SEARCH_QUERY_INVALID: '请输入单行公开搜索词，最多 400 字符及 50 个词，不能包含本机文件路径。',
  WEB_SEARCH_NOT_CONFIGURED: '此工作台尚未配置 Brave Search 密钥。',
  WEB_SEARCH_PROVIDER_UNAVAILABLE: '未找到通过验证的 Brave Search MCP 2.1.4 本机安装。',
  WEB_SEARCH_INVALID_RESPONSE: 'Brave Search MCP 返回的内容不符合预期。',
  WEB_SEARCH_PROVIDER_ERROR: 'Brave Search MCP 请求失败，请检查搜索服务与额度。',
  WEB_SEARCH_TIMEOUT: 'Brave Search MCP 等待超时。',
  WEB_SEARCH_CANCELLED: '搜索已取消。',
  WEB_SEARCH_PROCESS_UNCONFIRMED: '无法确认本机搜索进程已关闭。',
});

function error(code) {
  return Object.assign(new Error(errorMessages[code]), {code, localToolCode: code});
}

export function validateLocalWebQuery(query) {
  if (typeof query !== 'string' || !query || query !== query.trim() || query.length > 400 ||
      query.split(/\s+/u).length > 50 || /[\p{Cc}\u2028\u2029]/u.test(query) ||
      /(?:\bfile:\/\/|\b[A-Z]:[\\/]|\\\\|(?:^|\s)\/(?:Users|home|private|mnt|workspace|tmp)\/)/iu.test(query)) {
    throw error('WEB_SEARCH_QUERY_INVALID');
  }
  return query;
}

function containsKey(value, apiKey) {
  return value.toLowerCase().includes(apiKey.toLowerCase());
}

function validApiKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,512}$/u.test(value);
}

async function locateBraveEntry(braveRoot) {
  if (typeof braveRoot !== 'string' || !path.isAbsolute(braveRoot) || braveRoot.includes('\0')) {
    throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
  }
  try {
    const root = await realpath(braveRoot);
    const manifestPath = path.join(root, 'package.json');
    const entry = path.join(root, 'dist', 'index.js');
    for (const file of [manifestPath, entry]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size < 1 || info.size > 65536) {
        throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
      }
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const digest = createHash('sha256').update(await readFile(entry)).digest('hex');
    if (manifest.name !== PACKAGE || manifest.version !== VERSION || manifest.bin?.['brave-search-mcp-server'] !== 'dist/index.js' ||
        digest !== ENTRY_SHA256) {
      throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
    }
    return entry;
  } catch {
    throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
  }
}

export async function localWebAvailability({braveRoot, apiKey} = {}) {
  if (!validApiKey(apiKey)) return {available: false, code: 'WEB_SEARCH_NOT_CONFIGURED'};
  try {
    await locateBraveEntry(braveRoot);
    return {available: true};
  } catch {
    return {available: false, code: 'WEB_SEARCH_PROVIDER_UNAVAILABLE'};
  }
}

function displayText(value, maxLength, apiKey) {
  if (typeof value !== 'string' || containsKey(value, apiKey)) return '';
  const text = value.replace(/<\/?[a-z][^<>]{0,150}>/gi, '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return containsKey(text, apiKey) ? '' : text.slice(0, maxLength);
}

function publicLink(value, apiKey) {
  if (typeof value !== 'string' || value.length > 2048 || containsKey(value, apiKey)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') ||
        isIP(host) || /\.(?:local|localhost|internal)$/u.test(host) || containsKey(decodeURIComponent(url.href), apiKey)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function searchSources(result, apiKey) {
  if (!Array.isArray(result?.content) || result.content.length > 25) throw error('WEB_SEARCH_INVALID_RESPONSE');
  if (result.isError) {
    if (result.content.length === 1 && result.content[0]?.type === 'text' && result.content[0]?.text === 'No web results found') return [];
    throw error('WEB_SEARCH_PROVIDER_ERROR');
  }
  const sources = [];
  const seen = new Set();
  for (const item of result.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    let entry;
    try { entry = JSON.parse(item.text); } catch { continue; }
    const url = publicLink(entry?.url, apiKey);
    const title = displayText(entry?.title, 300, apiKey);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    sources.push({title, url, snippet: displayText(entry?.description, 650, apiKey)});
    if (sources.length === MAX_RESULTS) break;
  }
  if (!sources.length && result.content.length) throw error('WEB_SEARCH_INVALID_RESPONSE');
  return sources;
}

async function waitForClose(closed) {
  let timer;
  try {
    return await Promise.race([closed.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 3000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// A small one-request stdio client for a fixed optional provider. It does not
// load provider modules into the BuildX process or expose an MCP command runner.
async function searchBrave(entry, query, apiKey, signal) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'buildx-brave-'));
  let child;
  let closed;
  let timer;
  let onAbort;
  try {
    if (signal?.aborted) throw error('WEB_SEARCH_CANCELLED');
    const env = {BRAVE_API_KEY: apiKey};
    if (process.platform === 'win32') {
      // Node passes selected Windows shell variables even with an explicit env.
      Object.assign(env, {HOMEDRIVE: '', HOMEPATH: '', PATH: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', TEMP: cwd, TMP: cwd});
      if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    }
    child = spawn(process.execPath, [entry, '--transport', 'stdio', '--enabled-tools', WEB_TOOL, '--logging-level', 'error'], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    closed = new Promise(resolve => child.once('close', resolve));
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let received = 0;
    let remainder = Buffer.alloc(0);
    let nextId = 0;
    let pending;
    let failure;

    function fail(code) {
      failure ??= error(code);
      pending?.reject(failure);
      pending = null;
    }

    function write(message) {
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
    }

    function request(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending = {id, resolve, reject};
        write({id, method, params});
      });
    }

    child.once('error', () => fail('WEB_SEARCH_PROVIDER_UNAVAILABLE'));
    child.once('close', () => fail('WEB_SEARCH_PROVIDER_ERROR'));
    child.stdin.on('error', () => fail('WEB_SEARCH_PROVIDER_ERROR'));
    child.stdout.on('error', () => fail('WEB_SEARCH_PROVIDER_ERROR'));
    child.stdout.on('data', chunk => {
      if (failure) return;
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) return fail('WEB_SEARCH_INVALID_RESPONSE');
      remainder = Buffer.concat([remainder, chunk]);
      try {
        let newline;
        while ((newline = remainder.indexOf(10)) !== -1) {
          const line = remainder.subarray(0, newline);
          remainder = remainder.subarray(newline + 1);
          const message = JSON.parse(decoder.decode(line));
          if (message?.jsonrpc !== '2.0') return fail('WEB_SEARCH_INVALID_RESPONSE');
          if (!Object.hasOwn(message, 'id') && typeof message.method === 'string' && message.method.startsWith('notifications/')) continue;
          if (!pending || message.id !== pending.id || message.method) return fail('WEB_SEARCH_INVALID_RESPONSE');
          if (message.error) return fail('WEB_SEARCH_PROVIDER_ERROR');
          const current = pending;
          pending = null;
          current.resolve(message.result);
        }
      } catch {
        fail('WEB_SEARCH_INVALID_RESPONSE');
      }
    });
    timer = setTimeout(() => fail('WEB_SEARCH_TIMEOUT'), STARTUP_AND_CALL_TIMEOUT_MS);
    onAbort = () => fail('WEB_SEARCH_CANCELLED');
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();

    const info = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'buildx-local-web-search', version: '1.0.0'},
    });
    if (failure) throw failure;
    if (!KNOWN_PROTOCOLS.has(info?.protocolVersion) || info.serverInfo?.name !== 'brave-search-mcp-server' ||
        info.serverInfo.version !== VERSION || !info.capabilities?.tools) throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
    write({method: 'notifications/initialized'});

    const listing = await request('tools/list');
    if (listing?.nextCursor || !Array.isArray(listing?.tools) || listing.tools.length !== 1 ||
        listing.tools[0]?.name !== WEB_TOOL) throw error('WEB_SEARCH_PROVIDER_UNAVAILABLE');
    const result = await request('tools/call', {name: WEB_TOOL, arguments: {
      query, count: MAX_RESULTS, result_filter: ['web'], text_decorations: false, spellcheck: false,
    }});
    if (failure) throw failure;
    return searchSources(result, apiKey);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const didClose = await waitForClose(closed);
      await rmdir(cwd).catch(() => {});
      if (!didClose) throw error('WEB_SEARCH_PROCESS_UNCONFIRMED');
    } else {
      await rmdir(cwd).catch(() => {});
    }
  }
}

// The optional locator is a trusted composition dependency used by protocol
// tests. Conversation arguments can never supply the locator or provider root.
export function createLocalWebSearch({locate = locateBraveEntry} = {}) {
  return async function searchLocalWeb({query, signal, braveRoot, apiKey} = {}) {
    const exactQuery = validateLocalWebQuery(query);
    if (signal?.aborted) throw error('WEB_SEARCH_CANCELLED');
    if (!validApiKey(apiKey)) throw error('WEB_SEARCH_NOT_CONFIGURED');
    if (containsKey(exactQuery, apiKey)) throw error('WEB_SEARCH_QUERY_INVALID');
    try {
      const entry = await locate(braveRoot);
      const sources = await searchBrave(entry, exactQuery, apiKey, signal);
      return {query: exactQuery, provider: 'brave', sources};
    } catch (cause) {
      if (Object.hasOwn(errorMessages, cause?.code)) throw error(cause.code);
      throw error('WEB_SEARCH_PROVIDER_ERROR');
    }
  };
}

export const searchLocalWeb = createLocalWebSearch();
