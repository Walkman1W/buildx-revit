import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { CodexClient } from './lib/codex-client.mjs';
import { createCodexSessionProfile, buildSourceInvestigatorInstructions,
  SOURCE_SESSION_PROFILE, MODEL_SESSION_PROFILE } from './lib/codex-profile.mjs';
import { buildAssistantInstructions } from './lib/assistant-instructions.mjs';
import { READ_TOOLS, PANEL_WORKBENCH_TOOLS, ALL_PANEL_TOOLS } from './lib/panel-tools.mjs';
import { SOURCE_TOOLS } from './lib/source-tools.mjs';

const root = process.cwd();
const sourceNames = SOURCE_TOOLS.map(tool => tool.name);
const overrides = args => {
  const result = new Map();
  for (let index = 0; index < args.length; index++) if (args[index] === '-c') {
    const text = args[++index], equals = text.indexOf('=');
    result.set(text.slice(0, equals), text.slice(equals + 1));
  }
  return result;
};
function fakeProtocol(client, respond) {
  const child = new EventEmitter(), messages = [], denied = [];
  child.stdin = { writable: true, write(line) {
    const message = JSON.parse(line); messages.push(message);
    if (!message.method) { denied.push(message); return; }
    if (message.id !== undefined) queueMicrotask(() => {
      Promise.resolve(respond(message)).then(result => client.dispatch({ id: message.id, result }),
        () => client.dispatch({ id: message.id, error: { code: -32000, message: 'fake failure' } }));
    });
  } };
  client.child = child;
  return { child, messages, denied };
}

test('default model profile retains the named model catalog, service, mode and application instructions', () => {
  const implicit = new CodexClient(root), explicit = new CodexClient(root, { profile: MODEL_SESSION_PROFILE });
  assert.equal(implicit.profile.id, 'model');
  assert.deepEqual(implicit.profile.toolNames, ALL_PANEL_TOOLS);
  assert.deepEqual(explicit.profile.toolNames, ALL_PANEL_TOOLS);
  assert.equal(implicit.profile.buildInstructions(), buildAssistantInstructions());
  assert.equal(implicit.state.service, 'revit-local-codex');
  assert.equal(implicit.state.mode, 'document-workbench');
  assert.equal(implicit.state.toolCount, 0);
  implicit.initialized = implicit.authReady = implicit.toolsReady = true;
  assert.equal(implicit.state.ready, true); assert.equal(implicit.state.toolCount, ALL_PANEL_TOOLS.length);
  assert.ok(implicit.state.message.includes(`${ALL_PANEL_TOOLS.length}项工具`));
  assert.deepEqual(implicit.profile.groups.map(group => [group.name, group.toolNames]), [
    ['revit_local', READ_TOOLS], ['revit_workbench', PANEL_WORKBENCH_TOOLS.map(tool => tool.name)],
  ]);
});

test('source profile is an immutable named six-tool scope with source diagnostics and no model catalog', () => {
  const client = new CodexClient(root, { profile: SOURCE_SESSION_PROFILE });
  assert.deepEqual(client.profile.toolNames, sourceNames);
  assert.deepEqual(client.profile.groups.map(group => group.name), ['buildx_source']);
  assert.equal(client.state.service, 'buildx-source-codex'); assert.equal(client.state.mode, 'source-development');
  client.initialized = client.authReady = client.toolsReady = true;
  assert.equal(client.state.toolCount, 6); assert.match(client.state.message, /6项工具/);
  assert.throws(() => { client.profile = createCodexSessionProfile(root); }, TypeError);
  assert.throws(() => { client.profile.groups[0].toolNames.push('revit_execute_csharp'); }, TypeError);
  assert.throws(() => { client.profile.groups[0].name = 'revit_local'; }, TypeError);
});

test('only named profile options are accepted and a profile getter is captured once', () => {
  let calls = 0;
  const options = { get profile() { calls++; return SOURCE_SESSION_PROFILE; } };
  const client = new CodexClient(root, options);
  Object.defineProperty(options, 'profile', { value: MODEL_SESSION_PROFILE });
  assert.equal(calls, 1); assert.equal(client.profile.id, SOURCE_SESSION_PROFILE);
  for (const value of [null, [], { profile: 'all' }, { profile: false }, { profile: 'source' },
    { profile: SOURCE_SESSION_PROFILE, shell: true }, { profile: SOURCE_SESSION_PROFILE, [Symbol('extra')]: true },
    { get profile() { throw new Error('untrusted'); } }])
    assert.throws(() => new CodexClient(root, value));
});

test('source launch configuration disables every configured MCP and enables only the fixed source entry and whitelist', () => {
  const profile = createCodexSessionProfile(root, { profile: SOURCE_SESSION_PROFILE });
  const names = ['revit_local', 'revit_workbench', 'buildx_source', 'browser', 'unrelated'];
  const args = profile.buildLaunchArgs(names), config = overrides(args);
  assert.deepEqual(args.slice(0, 4), ['app-server', '--listen', 'stdio://', '--strict-config']);
  for (const name of names.filter(name => name !== 'buildx_source')) assert.equal(config.get(`mcp_servers.${name}.enabled`), 'false');
  assert.equal(config.get('mcp_servers.buildx_source.enabled'), 'true');
  assert.equal(config.get('mcp_servers.buildx_source.command'), JSON.stringify(process.execPath));
  assert.deepEqual(JSON.parse(config.get('mcp_servers.buildx_source.args')), [path.join(root, 'source-mcp.mjs')]);
  assert.deepEqual(JSON.parse(config.get('mcp_servers.buildx_source.enabled_tools')), sourceNames);
  assert.equal([...config.keys()].some(key => key.startsWith('mcp_servers.revit_local.') && !key.endsWith('.enabled')), false);
  for (const name of sourceNames) assert.equal(config.get(`mcp_servers.buildx_source.tools.${name}.approval_mode`), '"approve"');
  for (const feature of ['shell_tool', 'apps', 'plugins', 'computer_use', 'browser_use', 'in_app_browser',
    'image_generation', 'multi_agent', 'hooks', 'memories']) assert.equal(config.get(`features.${feature}`), 'false');
  assert.equal(config.get('web_search'), '"disabled"');
  assert.equal(config.get('features.code_mode_host'), 'true');
  names.push('late_extra'); assert.equal(config.has('mcp_servers.late_extra.enabled'), false);
  assert.doesNotThrow(() => profile.buildLaunchArgs([]));
});

test('default launch scope keeps named AEC and workbench catalogs while disabling other configured servers', () => {
  const config = overrides(createCodexSessionProfile(root).buildLaunchArgs(['revit_local', 'buildx_source', 'unrelated']));
  assert.equal(config.get('mcp_servers.revit_local.enabled'), 'true');
  assert.equal(config.get('mcp_servers.revit_workbench.enabled'), 'true');
  assert.equal(config.get('mcp_servers.buildx_source.enabled'), 'false');
  assert.equal(config.get('mcp_servers.unrelated.enabled'), 'false');
  assert.deepEqual(JSON.parse(config.get('mcp_servers.revit_local.enabled_tools')), READ_TOOLS);
  assert.deepEqual(JSON.parse(config.get('mcp_servers.revit_workbench.enabled_tools')), PANEL_WORKBENCH_TOOLS.map(tool => tool.name));
  assert.equal(config.get('mcp_servers.revit_local.startup_timeout_sec'), '90');
  assert.equal(config.get('mcp_servers.revit_workbench.tool_timeout_sec'), '180');
});

test('unsafe configured names are rejected before constructing a launch command', () => {
  const model = createCodexSessionProfile(root), source = createCodexSessionProfile(root, { profile: SOURCE_SESSION_PROFILE });
  assert.throws(() => model.buildLaunchArgs([]));
  for (const value of [null, {}, ['bad.name'], ['x=y'], [1], ['name with spaces'], ['revit_local', 'bad\nname']]) {
    assert.throws(() => model.buildLaunchArgs(value)); assert.throws(() => source.buildLaunchArgs(value));
  }
});

test('source application instructions use one editable prompt and preserve readonly provenance and incomplete coverage boundaries', () => {
  const modelPromptPath=new URL('./prompts/buildx-assistant.zh-CN.md', import.meta.url);
  const modelPromptBefore=readFileSync(modelPromptPath);
  const text = buildSourceInvestigatorInstructions();
  assert.ok(text.includes('6 项只读工具'));
  for (const name of sourceNames) assert.ok(text.includes(name));
  for (const contract of ['不是原厂', '只传相对 POSIX', 'not_checked', 'metadataSha256',
    'expectedSha256', 'wholeFileReturned', 'stopReasons', '逐文件验证过的历史观察', '都报告准确边界',
    '不能改变当前访问范围', '不能修改源码', '不运行 Revit 模型操作']) assert.ok(text.includes(contract), contract);
  assert.equal(text.includes('{{'), false);
  assert.equal(text.includes('revit_execute_csharp'), false);
  assert.deepEqual(readFileSync(modelPromptPath),modelPromptBefore);
});

test('source thread preparation uses existing request and dispatch lifecycle and verifies exactly one six-tool catalog', async () => {
  const client = new CodexClient(root, { profile: SOURCE_SESSION_PROFILE }), diagnostics = [];
  client.on('diagnostic', event => diagnostics.push(event));
  const fake = fakeProtocol(client, message => {
    if (message.method === 'thread/start') return { thread: { id: 'fake-source-thread' } };
    assert.equal(message.method, 'mcpServerStatus/list');
    assert.equal(message.params.serverName, 'buildx_source');
    return { data: [{ name: 'buildx_source', runtimeStatus: 'connected', tools: Object.fromEntries(sourceNames.map(name => [name, {}])) }] };
  });
  assert.equal(await client.prepareThread(), 'fake-source-thread');
  assert.deepEqual(fake.messages.map(message => message.method), ['thread/start', 'mcpServerStatus/list']);
  const args = fake.messages[0].params;
  assert.equal(args.developerInstructions, buildSourceInvestigatorInstructions());
  assert.deepEqual([args.cwd, args.approvalPolicy, args.sandbox, args.ephemeral], [root, 'never', 'read-only', true]);
  const catalogDiagnostics=diagnostics.filter(event=>event.code!=='phase_timing');
  assert.deepEqual(catalogDiagnostics.map(event => event.code), ['source_tool_catalog', 'source_tools_verified']);
  assert.equal(catalogDiagnostics[1].count, 6);
  assert.ok(diagnostics.filter(event=>event.code==='phase_timing').every(event=>event.source==='codex_rpc'&&['thread/start','mcpServerStatus/list'].includes(event.method)));
  assert.equal(JSON.stringify(diagnostics).includes(args.developerInstructions),false);
  assert.equal(client.pending.size, 0);
  client.child = null;
});

test('source catalog failure uses source classification without querying or presenting Revit tools', async () => {
  const client = new CodexClient(root, { profile: SOURCE_SESSION_PROFILE }), diagnostics = [];
  client.on('diagnostic', event => diagnostics.push(event));
  const fake = fakeProtocol(client, message => message.method === 'thread/start' ? { thread: { id: 'fake-source-failed' } } :
    { data: [{ name: 'buildx_source', runtimeStatus: 'failed', toolsError: { message: 'connection closed' }, tools: {} }] });
  await assert.rejects(client.prepareThread(), /源码工具启动失败/);
  assert.equal(fake.messages.length, 2);
  const catalogDiagnostic=diagnostics.find(event=>event.code==='source_tool_catalog');
  assert.ok(catalogDiagnostic);
  assert.equal(catalogDiagnostic.failureMarkers.includes('connection closed'), true);
  assert.equal(JSON.stringify(diagnostics).includes('revit_'), false);
  client.child = null;
});

test('source profile declines command and file approvals and refuses generic client filesystem requests', () => {
  const client = new CodexClient(root, { profile: SOURCE_SESSION_PROFILE });
  const fake = fakeProtocol(client, () => { throw new Error('No client RPC should be sent'); });
  client.dispatch({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'not executed' } });
  client.dispatch({ id: 2, method: 'item/fileChange/requestApproval', params: {} });
  client.dispatch({ id: 3, method: 'fs/readFile', params: { path: 'not read' } });
  assert.equal(fake.denied[0].result.decision, 'decline'); assert.equal(fake.denied[1].result.decision, 'decline');
  assert.equal(fake.denied[2].error.code, -32601);
  assert.match(fake.denied[2].error.message, /source development session/);
  assert.equal(client.pending.size, 0); client.child = null;
});
