import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('late receipt updates only its original tool card without changing message or other cards', async () => {
  const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderConversation() {'), source.indexOf('\nfunction renderContext()', source.indexOf('function renderConversation() {')));
  const nodes = new Map();
  const make = () => ({ children: [], className: '', hidden: false, textContent: '', append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, get childElementCount() { return this.children.length; }, insertBefore(item, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, item); }, remove() {} });
  const elements = new Map(['welcome', 'history-note', 'transcript'].map(id => [id, make()]));
  const opened = new Set(['m:a']);
  const context = { messages: [{ id: 'm', role: 'assistant', text: 'answer', tools: [{ id: 'a' }, { id: 'b' }] }], lastSession: {}, messageNodes: nodes, openedTools: opened, accountEpoch: 0, contextEpoch: 0, modelUiEnabled: false, modelContextAllowed: false, commandIdentityKey: () => '', commandConversationId: () => '', nearBottom: () => false, scrollBottom() {}, $: id => elements.get(id), node: make, messageStatus: () => '', renderMarkdown(el, text) { el.textContent = text; }, toolCard(messageId, tool, receipt) { return { id: tool.id, receipt, open: opened.has(messageId + ':' + tool.id) }; } };
  vm.createContext(context);
  vm.runInContext(render, context);
  context.renderConversation();
  const entry = nodes.get('m'), [first, second] = entry.tools.children;
  context.lastSession = { toolReceipts: [{ messageId: 'm', itemId: 'a', requestId: 'original', status: 'received' }] };
  context.renderConversation();
  assert.notEqual(entry.tools.children[0], first);
  assert.equal(entry.tools.children[0].receipt.requestId, 'original');
  assert.equal(entry.tools.children[0].open, true);
  assert.equal(entry.tools.children[1], second);
  assert.equal(entry.body.textContent, 'answer');
  context.renderConversation();
  assert.equal(entry.tools.children[1], second);
});
