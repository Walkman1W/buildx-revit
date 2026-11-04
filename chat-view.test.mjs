import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineTokens, markdownBlocks, safeLink, toolStatus, messageStatus, sessionMessages, legacyDelta } from './public/chat-view.mjs';

test('assistant Markdown keeps raw HTML and executable links inert', () => {
  const script = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  assert.deepEqual(inlineTokens(script), [{ type: 'text', text: script }]);
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/private.txt', 'vbscript:msgbox(1)', '//outside.example/']) assert.equal(safeLink(value), null);
  assert.equal(safeLink('HTTPS://example.com/a?q=2'), 'https://example.com/a?q=2');
  assert.equal(inlineTokens('[不要执行](javascript:alert)')[0].type, 'text');
  const code = markdownBlocks('```csharp\n<script>literal</script>\n```')[0];
  assert.equal(code.type, 'code'); assert.equal(code.text, '<script>literal</script>');
});

test('lists, table cells, inline code and open code fences remain readable during streaming', () => {
  const blocks = markdownBlocks('先确认 **文档** 与 `ElementId`。\n\n1. 创建\n2. 回读\n3. 回滚\n\n| 对象 | 结果 |\n| --- | --- |\n| 墙\\|体 | **待验收** |\n\n```csharp\nvar wall = Wall.Create(');
  assert.deepEqual(blocks.map(block => block.type), ['paragraph', 'list', 'table', 'code']);
  assert.equal(blocks[1].ordered, true); assert.equal(blocks[1].items.length, 3);
  assert.equal(blocks[2].rows[0][0][0].text, '墙|体');
  assert.equal(blocks[2].rows[0][1][0].type, 'strong');
  assert.equal(blocks[3].text, 'var wall = Wall.Create(');
});

test('tool transport completion is shown as returned, never as modelling success', () => {
  assert.equal(toolStatus('returned'), '已返回');
  assert.equal(toolStatus('running'), '执行中');
  assert.equal(toolStatus('failed'), '失败');
  assert.equal(toolStatus('success'), '结果未知');
  assert.equal(toolStatus(undefined), '结果未知');
  assert.equal(messageStatus('interrupted'), '已停止');
});

test('authoritative history selects unique message identity and keeps every valid role', () => {
  const valid = [{ id: 'u1', role: 'user', text: '查看模型' }, { id: 'a1', role: 'assistant', text: '查询中' }, { id: 'e1', role: 'error', text: '未连接' }];
  const messages = sessionMessages({ messages: [...valid, { id: 'a1', role: 'assistant', text: '重复的回执' }, { id: 'bad', role: 'system', text: '不要渲染此角色' }, null] });
  assert.deepEqual(messages, valid);
  assert.deepEqual(sessionMessages({ messages: null }), []);
});

test('legacy deltas target message identity without appending duplicate assistant turns', () => {
  const initial = [{ id: 'u1', role: 'user', text: '问题' }];
  const first = legacyDelta(initial, '第一', 'a1');
  const second = legacyDelta(first, '段', 'a1');
  const third = legacyDelta(second, '另一个回答', 'a2');
  assert.equal(initial.length, 1); assert.equal(first[1].text, '第一');
  assert.equal(second.length, 2); assert.equal(second[1].text, '第一段');
  assert.equal(third.length, 3); assert.equal(third[2].id, 'a2');
});
