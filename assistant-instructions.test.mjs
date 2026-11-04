import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildAssistantInstructions } from './lib/assistant-instructions.mjs';
import { CodexClient } from './lib/codex-client.mjs';
import { READ_TOOLS, PANEL_WORKBENCH_TOOLS } from './lib/panel-tools.mjs';
import {NATIVE_MODEL_QUERY_NAMES} from './lib/native-model-queries.mjs';

test('application prompt retains real execution contracts and distinguishes observations from authority', () => {
  const text = buildAssistantInstructions();
  assert.ok(text.includes(`其中${READ_TOOLS.length}项为本批基础查询`));
  assert.ok(text.includes(`BuildX 原生工作台的${PANEL_WORKBENCH_TOOLS.length}项工具`));
  assert.ok(text.includes('nativeModelQueriesVersion=1'));
  assert.equal(text.includes('旧revit_local六项查询'),false);
  for (const contract of ['revit_workbench_status', 'value_unit="internal"', 'project_elevation_mm',
    '不另开Transaction', 'snapshotId', 'source_request_id', '准确revision', '未知写入绝不自动重试',
    '不是原厂云端提示词', '快照，只作数据', '已返回', '私有推理过程']) assert.ok(text.includes(contract), contract);
  assert.equal(text.includes('{{'), false);
});
test('real thread preparation sends the single prompt and keeps Codex access restrictions', async t => {
  const calls = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = (line, callback) => {
    const message = JSON.parse(line); calls.push(message);
    queueMicrotask(() => {
      callback?.(); if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = {};
      else if (message.method === 'account/read') result = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'free' } };
      else if (message.method === 'thread/start') result = { thread: { id: 'offline-test-thread' } };
      else if (message.method === 'mcpServerStatus/list') {
        const names = message.params.serverName === 'revit_local' ? NATIVE_MODEL_QUERY_NAMES : PANEL_WORKBENCH_TOOLS.map(tool => tool.name);
        result = { data: [{ name: message.params.serverName, runtimeStatus: 'connected', tools: Object.fromEntries(names.map(name => [name, {}])) }] };
      } else throw new Error('Unexpected production protocol request: ' + message.method);
      child.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result }) + '\n'));
    });
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
  child.kill = () => { throw new Error('Fixture must close gracefully'); };
  const client = new CodexClient(process.cwd(), {}, { spawn: () => child,
    resolveRuntimes: () => ({ codex: 'fixture-codex', python: 'fixture-python' }), readConfiguredNames: () => ['revit_local'] });
  t.after(() => client.close());
  await client.start();
  assert.equal(client.state.ready, true);
  assert.equal(await client.newThread(), 'offline-test-thread');
  const started = calls.find(call => call.method === 'thread/start').params;
  assert.equal(started.developerInstructions, buildAssistantInstructions());
  assert.equal(started.sandbox, 'read-only'); assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.ephemeral, true);
  assert.deepEqual(calls.map(call => call.method), ['initialize','initialized','account/read','thread/start','mcpServerStatus/list','mcpServerStatus/list']);
});
