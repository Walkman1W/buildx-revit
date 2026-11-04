import readline from 'node:readline';
import {connectionFromEnv, runReadonlyProbe} from './lib/argus-readonly-probe.mjs';

// Standalone verification tool; no change to the running panel or global config.
const tool = {
  name: 'argus_readonly_probe',
  description: 'Run one fixed read-only view-count script in the ORIGINAL Argus CodeRunner. Does not accept C# code. Requires explicitly provided local host authentication.',
  inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
};
async function call(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new Error('INVALID_ARGUMENTS');
  return runReadonlyProbe(connectionFromEnv());
}
if (process.argv.includes('--mcp')) {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  let busy = false;
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    let message;
    try { message = JSON.parse(line); } catch { send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); continue; }
    if (message.id === undefined) continue;
    const reply = result => send({jsonrpc: '2.0', id: message.id, result});
    if (message.method === 'initialize') reply({protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'argus-readonly-probe', version: '0.1.0'}});
    else if (message.method === 'ping') reply({});
    else if (message.method === 'tools/list') reply({tools: [tool]});
    else if (message.method === 'tools/call' && message.params?.name === tool.name) {
      if (busy) { reply({isError: true, content: [{type: 'text', text: 'PROBE_BUSY'}]}); continue; }
      busy = true;
      void call(message.params.arguments ?? {}).then(result => reply({content: [{type: 'text', text: JSON.stringify(result)}]}),
        error => reply({isError: true, content: [{type: 'text', text: error.code || 'PROBE_FAILED'}]})).finally(() => { busy = false; });
    } else send({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Unsupported method or tool'}});
  }
} else {
  try { console.log(JSON.stringify({ok: true, result: await call({})})); }
  catch (error) { console.log(JSON.stringify({ok: false, code: error.code || 'PROBE_FAILED', realArgusVerified: false})); process.exitCode = 1; }
}
