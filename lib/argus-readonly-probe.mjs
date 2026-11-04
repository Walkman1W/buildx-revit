import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function checkExecutionReadiness() {
  let readiness;
  try { readiness = JSON.parse(await readFile(new URL('../runtime/argus-execution-readiness.json', import.meta.url), 'utf8')); }
  catch { throw new ProbeError('EXECUTOR_ENTITLEMENT_NOT_CONFIRMED'); }
  if (readiness.status !== 'approved' || readiness.originalExecutorEntitlementConfirmed !== true) throw new ProbeError('EXECUTOR_ENTITLEMENT_NOT_CONFIRMED');
}

// Fixed program, not a user-supplied script or a heuristic C# allowlist.
// UIApp is supplied by Argus CodeRunnerGlobalContext.
export const PROBE_CODE = `var probeDoc = UIApp.ActiveUIDocument.Document;
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
  probe = "argus-codex-readonly-v1",
  viewCount = new Autodesk.Revit.DB.FilteredElementCollector(probeDoc).OfClass(typeof(Autodesk.Revit.DB.View)).GetElementCount(),
  isModified = probeDoc.IsModified,
  isReadOnly = probeDoc.IsReadOnly
});`;

export class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function connectionFromEnv(env = process.env) {
  if (!env.ARGUS_PROBE_URL || !env.ARGUS_PROBE_TOKEN) throw new ProbeError('AUTH_CONTEXT_REQUIRED');
  let url;
  try { url = new URL(env.ARGUS_PROBE_URL); } catch { throw new ProbeError('INVALID_LOCAL_ENDPOINT'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ProbeError('INVALID_LOCAL_ENDPOINT');
  }
  if (/[\r\n]/.test(env.ARGUS_PROBE_TOKEN)) throw new ProbeError('INVALID_AUTH_CONTEXT');
  return {url, token: env.ARGUS_PROBE_TOKEN};
}

export function parseProbeEvents(text) {
  let terminal;
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    if (!['result', 'error'].includes(event)) continue;
    if (terminal) throw new ProbeError('MULTIPLE_TERMINAL_EVENTS');
    let data;
    try { data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')); }
    catch { throw new ProbeError('INVALID_RESULT_JSON'); }
    if (event === 'error' || !data || typeof data !== 'object' || data.error) throw new ProbeError('ARGUS_EXECUTION_FAILED');
    terminal = data;
  }
  if (!terminal) throw new ProbeError('MISSING_RESULT_EVENT');
  let value;
  try { value = JSON.parse(terminal.return_value); }
  catch { throw new ProbeError('INVALID_PROBE_RESULT'); }
  if (!value || value.probe !== 'argus-codex-readonly-v1' || !Number.isSafeInteger(value.viewCount) ||
      value.viewCount < 0 || typeof value.isModified !== 'boolean' || typeof value.isReadOnly !== 'boolean') {
    throw new ProbeError('INVALID_PROBE_RESULT');
  }
  return {probe: value.probe, viewCount: value.viewCount, isModified: value.isModified, isReadOnly: value.isReadOnly};
}

export async function runReadonlyProbe(connection, {fetchImpl = fetch} = {}) {
  if (fetchImpl === fetch) await checkExecutionReadiness();
  const started = performance.now();
  const toolCallId = randomUUID();
  try {
    const response = await fetchImpl(new URL('revit/code/execute', connection.url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: {'Content-Type': 'application/json', 'X-Revit-Token': connection.token},
      body: JSON.stringify({code: PROBE_CODE, tool_call_id: toolCallId, timeout: 15, ui_refresh_rate: 5000}),
    });
    if (response.status === 401 || response.status === 403) throw new ProbeError('ARGUS_AUTH_REJECTED');
    if (!response.ok) throw new ProbeError('ARGUS_HTTP_FAILED');
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new ProbeError('UNEXPECTED_CONTENT_TYPE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new ProbeError('RESPONSE_LIMIT_EXCEEDED');
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return {source: 'argus-original-coderunner', toolCallId, ...parseProbeEvents(text), elapsedMs: Math.round(performance.now() - started)};
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    // Never expose transport exception text: it can contain headers/credentials.
    throw new ProbeError(error?.name === 'TimeoutError' ? 'TRANSPORT_TIMEOUT_EXECUTION_UNCONFIRMED' : 'ARGUS_TRANSPORT_FAILED');
  }
}
