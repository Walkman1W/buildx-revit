// Executes the unchanged production app.js module body in an isolated VM.
// Its DOM/HTTP/SSE peers are fixtures; no browser, socket, Codex or Revit runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as chatView from './public/chat-view.mjs';
import { SOURCE_TOOLS } from './lib/source-tools.mjs';

const source = await fs.readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sourceWorkspace = { kind: 'source-development', supportsModelContext: false };
const modelWorkspace = { kind: 'model', supportsModelContext: true };
const customerWorkspace = { kind: 'customer-chat', supportsModelContext: false };
const catalog = SOURCE_TOOLS.map(tool => ({ name: tool.name, label: tool.name, description: tool.description, readOnly: true }));
const sourceState = extra => ({ workspace: sourceWorkspace, ready: true, error: false,
  message: '源码工具已就绪', toolCount: 6, toolCatalog: catalog, ...extra });
const customerState = extra => ({ workspace: customerWorkspace, ready: true, error: false,
  message: '聊天已就绪', toolCount: 0, toolCatalog: [], account: {configured:true,required:true,signedIn:true},
  codexConfirmation:{localConnectionConfirmed:true}, ...extra });
const session = (epoch = 0, messages = [], context = { document: null, selection: null, capturedAt: null }) =>
  ({ messages, context, contextEpoch: epoch, historyTruncated: false });

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = new Map(); this.style = {}; this.dataset = {};
    this.value = ''; this.textContent = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.className = ''; this.scrollHeight = 60; this.scrollTop = 0; this.clientHeight = 300; this.isConnected = true; }
  addEventListener(name, fn) { const list = this.events.get(name) ?? []; list.push(fn); this.events.set(name, list); }
  dispatchEvent(event) { event.target = this; for (const fn of this.events.get(event.type) ?? []) fn(event); return true; }
  append(...nodes) { for (let item of nodes) { if (typeof item === 'string') { const text = item; item = new Element('#text'); item.textContent = text; }
    item.remove(); item.parent = this; this.children.push(item); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  insertBefore(element, at) { element.remove(); element.parent = this; const index = this.children.indexOf(at);
    if (index < 0) this.children.push(element); else this.children.splice(index, 0, element); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  setAttribute(name, value) { this[name] = value; }
  get childElementCount() { return this.children.length; }
  focus() { this.focused = true; }
}
class UiEvent { constructor(type, extra = {}) { this.type = type; Object.assign(this, extra); } preventDefault() { this.defaultPrevented = true; } }
const textOf = element => element.textContent + element.children.map(textOf).join('');

async function setup(initialStatus = {}) {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
    const element = get(match[3]); element.tagName = match[1]; element.textContent = match[4]; element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    const placeholder = /\bplaceholder="([^"]*)"/.exec(match[2]); if (placeholder) element.placeholder = placeholder[1];
  }
  const suggestions = [...html.matchAll(/<button\b[^>]*data-prompt="([^"]+)"[^>]*>/g)].map(match => {
    const button = new Element('button'); button.dataset.prompt = match[1]; return button;
  });
  const requests = []; let identity = 0;
  let statusData = { csrf: 'offline-token', ready: true, error: false, message: '模型工具已就绪', toolCount: 31, toolCatalog: [], ...initialStatus };
  class FakeEventSource {
    static instances = [];
    constructor(url) { this.url = url; this.events = new Map(); FakeEventSource.instances.push(this); }
    addEventListener(name, fn) { const list = this.events.get(name) ?? []; list.push(fn); this.events.set(name, list); }
    emit(name, data) { for (const fn of this.events.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const document = { title: /<title>([^<]+)<\/title>/.exec(html)[1], getElementById: get,
    querySelectorAll: selector => {
      if (selector === '[data-prompt]') return suggestions;
      if (selector === '#skills-list input') {
        const found=[],pending=[...get('skills-list').children];
        while(pending.length){const item=pending.pop();if(item.tagName==='input')found.push(item);pending.push(...item.children);}
        return found;
      }
      assert.fail('Unexpected selector: '+selector);
    },
    createElement: tag => new Element(tag), createTextNode: text => { const item = new Element('#text'); item.textContent = text; return item; },
    createDocumentFragment: () => new Element('#fragment') };
  const sandbox = { __chatView: chatView, document, window: new Element('window'), AbortController, sessionStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => `test-${++identity}` }, Event: UiEvent, EventSource: FakeEventSource,
    navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url === '/api/status') return { ok: true, json: async () => statusData };
      const pending = deferred(); requests.push({ url, body: JSON.parse(options.body), ...pending }); return pending.promise;
    } };
  const context = vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/, 'const {$1} = __chatView;'), context,
    { filename: 'production/public/app.js' });
  await flush();
  const stream = () => FakeEventSource.instances.at(-1);
  const emit = (name, data) => stream().emit(name, data);
  return { get, document, suggestions, requests, stream, emit, setStatus: data => { statusData = data; },
    flags: () => JSON.parse(vm.runInContext('JSON.stringify(contextFlags())', context)),
    input(value) { get('prompt').value = value; get('prompt').dispatchEvent(new UiEvent('input')); },
    async click(id) { get(id).dispatchEvent(new UiEvent('click')); await flush(); },
    async submit() { get('composer').dispatchEvent(new UiEvent('submit')); await flush(); },
    async respond(request, data = { ok: true }, ok = true) { request.resolve({ ok, json: async () => data }); await flush(); } };
}

test('shared HTML preserves model defaults and assigns unique workspace hooks without a second chat implementation', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['workspace-name', 'workspace-subtitle', 'workspace-footnote', 'context-panel',
    'tools-boundary', 'welcome-section-label', 'welcome-description', 'welcome-hint']) assert.ok(ids.includes(id));
  assert.match(html, /<title>BuildX · 项目助手<\/title>/);
  assert.equal([...html.matchAll(/<form\b/g)].length, 1);
  assert.equal([...html.matchAll(/id="transcript"/g)].length, 1);
  assert.match(html, /src="\/app.js" type="module"/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});

test('known source profile shows the six source contracts, provenance guidance and no visible model suggestions', async () => {
  const ui = await setup(sourceState());
  assert.equal(ui.document.title, 'BuildX · 源码工作台');
  assert.equal(ui.get('workspace-name').textContent, '源码工作台');
  assert.equal(ui.get('workspace-subtitle').textContent, 'SOURCE WORKSPACE · CODEX');
  assert.equal(ui.get('tools-directory').hidden, false);
  assert.equal(ui.get('tool-list').childElementCount, 6);
  assert.equal(ui.get('tool-count').textContent, '已加载 6 / 6 项');
  assert.match(ui.get('welcome-hint').textContent, /原始 SHA256/); assert.match(ui.get('welcome-hint').textContent, /partial/);
  assert.match(ui.get('tools-boundary').textContent, /metadataSha256/);
  assert.match(ui.get('workspace-footnote').textContent, /只读源码研究/);
  assert.match(ui.get('workspace-footnote').textContent, /不连接 Revit，不写文件、不执行终端/);
  assert.equal(ui.suggestions.length, 3);
  assert.equal(ui.suggestions.every(button => !/当前 Revit|选中的对象|command/.test(button.dataset.prompt)), true);
  assert.match(ui.suggestions[0].dataset.prompt, /buildx_source_list_roots/);
  assert.match(ui.suggestions[1].dataset.prompt, /buildx-lib/);
  assert.match(ui.suggestions[2].dataset.prompt, /panel-tools\.mjs/);
});

test('switching from model catalog to a count-only source SSE clears stale rows until source HTTP catalog arrives', async () => {
  for (const mode of ['snapshot', 'state']) {
    const modelCatalog = Array.from({ length: 31 }, (_, index) => ({ name: `revit_tool_${index}`, description: '模型工具', readOnly: false }));
    const ui = await setup({ workspace: modelWorkspace, toolCount: 31, toolCatalog: modelCatalog });
    assert.equal(ui.get('tools-directory').hidden, true);
    assert.equal(ui.get('tool-list').childElementCount, 0);
    const countOnly = { workspace: sourceWorkspace, ready: true, toolCount: 6 };
    if (mode === 'snapshot') ui.emit('snapshot', { workspace: sourceWorkspace, state: countOnly, busy: false, session: session(1) });
    else ui.emit('state', countOnly);
    assert.equal(ui.get('workspace-name').textContent, '源码工作台');
    assert.equal(ui.get('tool-list').childElementCount, 0);
    assert.equal(ui.get('tool-count').textContent, '正在读取目录');
    assert.match(ui.get('tool-note').textContent, /尚未取得本工作区/);
    assert.doesNotMatch(textOf(ui.get('tool-list')), /revit_tool_/);
    assert.deepEqual(ui.flags(), { includeDocument: false, includeSelection: false });
    ui.setStatus({ csrf: 'offline-token', ...sourceState() });
    ui.stream().onopen(); await flush();
    assert.equal(ui.get('tool-list').childElementCount, 6);
    assert.equal(ui.get('tool-count').textContent, '已加载 6 / 6 项');
    assert.doesNotMatch(textOf(ui.get('tool-list')), /revit_tool_/);
  }
});

test('source context controls are hidden and disabled and cannot produce model flags or a context POST', async () => {
  const ui = await setup(sourceState());
  assert.equal(ui.get('context-panel').hidden, true);
  for (const id of ['include-document', 'include-selection']) {
    assert.equal(ui.get(id).disabled, true); ui.get(id).checked = true;
  }
  assert.deepEqual(ui.flags(), { includeDocument: false, includeSelection: false });
  await ui.click('refresh-context'); assert.equal(ui.requests.length, 0);
  ui.input('读取源码'); await ui.submit();
  assert.equal(ui.requests[0].url, '/api/turn');
  assert.deepEqual(ui.requests[0].body.context, { includeDocument: false, includeSelection: false });
  assert.equal(ui.get('include-document').checked, false); assert.equal(ui.get('include-selection').checked, false);
});

test('absence of workspace preserves the existing model default, context selection and editable suggestions', async () => {
  const ui = await setup();
  assert.equal(ui.get('workspace-name').textContent, '项目助手');
  assert.equal(ui.get('context-panel').hidden, false);
  assert.equal(ui.get('include-document').disabled, false);
  ui.get('include-document').checked = true;
  await ui.click('refresh-context');
  assert.equal(ui.requests[0].url, '/api/context'); assert.equal(ui.requests[0].body.includeDocument, true);
  ui.suggestions[0].dispatchEvent(new UiEvent('click'));
  assert.match(ui.get('prompt').value, /当前 Revit 文档/);
  assert.equal(ui.requests.length, 1);
});

test('explicit model profile works normally while unknown profiles never claim source mode or widen context', async () => {
  const model = await setup({ workspace: modelWorkspace });
  assert.equal(model.get('include-document').disabled, false);
  const unknown = await setup({ workspace: { kind: 'future-profile', supportsModelContext: true } });
  assert.equal(unknown.get('workspace-name').textContent, '项目助手');
  assert.notEqual(unknown.get('workspace-subtitle').textContent, 'SOURCE WORKSPACE · CODEX');
  assert.equal(unknown.get('context-panel').hidden, true);
  assert.deepEqual(unknown.flags(), { includeDocument: false, includeSelection: false });
  unknown.emit('state', { workspace: modelWorkspace, ready: true });
  assert.equal(unknown.get('include-document').disabled, true);
});

test('top-level source snapshot switches display and invalidates a pending model-context owner before a late HTTP response', async () => {
  const ui = await setup(); ui.get('include-document').checked = true;
  await ui.click('refresh-context'); const old = ui.requests[0];
  ui.emit('snapshot', { workspace: sourceWorkspace, state: { ...sourceState(), workspace: undefined },
    busy: false, session: session(1) });
  await ui.respond(old, { context: { document: { title: '旧项目不得复活' }, selection: null, capturedAt: 'old' } });
  assert.equal(ui.get('workspace-name').textContent, '源码工作台');
  assert.equal(ui.get('context-panel').hidden, true);
  assert.doesNotMatch(ui.get('context-summary').textContent, /旧项目/);
  assert.equal(ui.get('tool-count').textContent, '已加载 6 / 6 项');
  assert.deepEqual(ui.flags(), { includeDocument: false, includeSelection: false });
});

test('late model and missing-profile snapshots cannot restore model context or replace the source directory', async () => {
  const ui = await setup(sourceState());
  const staleContext = { document: { title: '旧模型' }, selection: { count: 1, elementIds: [2] }, capturedAt: 'old' };
  ui.emit('snapshot', { workspace: modelWorkspace, state: { workspace: modelWorkspace, ready: true,
    toolCount: 31, toolCatalog: [{ name: 'revit_write', readOnly: false }] }, session: session(2, [], staleContext) });
  ui.emit('state', { workspace: { kind: 'unknown', supportsModelContext: true }, ready: true, toolCount: 99 });
  ui.emit('conversation', { busy: false, state: { ready: true, toolCount: 31,
    toolCatalog: [{ name: 'revit_write', readOnly: false }] }, session: session(3, [], staleContext) });
  assert.equal(ui.get('workspace-name').textContent, '源码工作台');
  assert.equal(ui.get('tool-count').textContent, '已加载 6 / 6 项');
  assert.equal(ui.get('tool-list').childElementCount, 6);
  assert.doesNotMatch(textOf(ui.get('tool-list')), /revit_write/);
  assert.equal(ui.get('context-panel').hidden, true);
  assert.doesNotMatch(ui.get('context-summary').textContent, /旧模型/);
  assert.deepEqual(ui.flags(), { includeDocument: false, includeSelection: false });
});

test('reconnect and a late old stream preserve the fixed source ceiling even if a status response omits workspace', async () => {
  const ui = await setup(sourceState()), previous = ui.stream();
  ui.setStatus({ csrf: 'offline-token', ready: true, message: '旧状态', toolCount: 31,
    toolCatalog: [{ name: 'revit_write', readOnly: false }] });
  await ui.click('reconnect'); assert.equal(ui.requests[0].url, '/api/reconnect');
  await ui.respond(ui.requests[0]);
  assert.notEqual(ui.stream(), previous); assert.equal(previous.closed, true);
  previous.emit('snapshot', { workspace: modelWorkspace, state: { workspace: modelWorkspace, ready: true }, session: session(5) });
  assert.equal(ui.get('workspace-name').textContent, '源码工作台');
  assert.equal(ui.get('tool-count').textContent, '已加载 6 / 6 项');
  ui.get('include-document').checked = true; ui.input('继续读源码'); await ui.submit();
  assert.deepEqual(ui.requests[1].body.context, { includeDocument: false, includeSelection: false });
});

test('source chat reuses draft ownership, new-chat and stop controls without model-operation claims', async () => {
  const ui = await setup(sourceState());
  ui.emit('snapshot', { workspace: sourceWorkspace, state: sourceState(), busy: false, session: session() });
  ui.input('第一条源码问题'); await ui.submit(); const first = ui.requests[0];
  ui.input('保留的新草稿'); ui.emit('conversation', { workspace: sourceWorkspace, busy: true, session: session() });
  await ui.click('stop'); const interrupt = ui.requests[1];
  await ui.respond(interrupt); assert.match(ui.get('activity-text').textContent, /源码工具结果/);
  assert.doesNotMatch(ui.get('activity-text').textContent, /模型操作/);
  ui.emit('done', {}); await ui.respond(first); assert.equal(ui.get('prompt').value, '保留的新草稿');
  await ui.click('new-chat'); const fresh = ui.requests[2];
  await ui.respond(fresh, { ok: true, workspace: sourceWorkspace,
    session: session(1, [], { document: { title: '不能附加' }, selection: null, capturedAt: 'bad' }) });
  assert.equal(ui.get('context-panel').hidden, true);
  assert.doesNotMatch(ui.get('context-summary').textContent, /不能附加/);
  assert.equal(ui.get('prompt').value, '保留的新草稿');
});

test('source tool cards retain exact origin/hash/partial receipts and unknown results make no model success claim', async () => {
  const ui = await setup(sourceState()); const hash = 'a'.repeat(64);
  ui.emit('snapshot', { workspace: sourceWorkspace, state: sourceState(), busy: false,
    session: session(0, [{ id: 'answer', role: 'assistant', text: '源码结论与 `C#` 示例。', tools: [
      { id: 'returned', name: 'buildx_source_search', status: 'returned', argumentsPreview: { rootId: 'argus-source', path: '', query: 'Dimension' },
        resultPreview: { ok: true, value: { rootId: 'argus-source', path: 'Example.cs', sha256: hash, completeness: 'partial' } } },
      { id: 'unknown', name: 'buildx_source_read_file', status: 'unknown', argumentsPreview: { rootId: 'buildx-lib', path: 'panel-tools.mjs' } },
    ] }]) });
  const transcript = textOf(ui.get('transcript'));
  assert.match(transcript, /argus-source/); assert.ok(transcript.includes(hash)); assert.match(transcript, /partial/);
  assert.match(transcript, /已返回/); assert.match(transcript, /请按来源、哈希和覆盖状态回查/);
  assert.doesNotMatch(transcript, /模型写入结果未知|建模成功/);
});

test('source kind overrides a contradictory supportsModelContext=true flag and keeps context false', async () => {
  const ui = await setup(sourceState({ workspace: { kind: 'source-development', supportsModelContext: true } }));
  assert.equal(ui.get('workspace-name').textContent, '源码工作台');
  assert.equal(ui.get('include-document').disabled, true);
  assert.deepEqual(ui.flags(), { includeDocument: false, includeSelection: false });
});

test('customer chat owns distinct branding, zero tools and no model or source suggestions', async () => {
  const ui = await setup(customerState());
  assert.equal(ui.document.title,'BuildX · 聊天工作区');
  assert.equal(ui.get('workspace-name').textContent,'聊天工作区');
  assert.match(ui.get('workspace-subtitle').textContent,/聊天工作区 · 自有 Codex/);
  assert.match(ui.get('workspace-footnote').textContent,/BuildX 登录与本机 Codex/);
  assert.equal(ui.get('tool-count').textContent,'工具范围：0项');
  assert.equal(ui.get('tool-list').childElementCount,0);
  assert.match(ui.get('tools-boundary').textContent,/没有模型或源码工具/);
  assert.ok(ui.suggestions.every(button=>!/Revit|buildx_source_|当前模型|command/.test(button.dataset.prompt)));
  assert.deepEqual(ui.flags(),{includeDocument:false,includeSelection:false});
  assert.equal(ui.get('context-panel').hidden,true);
  assert.equal(ui.get('include-document').disabled,true);
  assert.equal(ui.get('include-selection').disabled,true);
});

test('customer ceiling clears old tools and pending context; foreign and missing workspace cannot resurrect them',async()=>{
  const oldTools=Array.from({length:37},(_,index)=>({name:'revit_old_'+index,label:'旧模型工具',readOnly:false}));
  const ui=await setup({workspace:modelWorkspace,toolCatalog:oldTools,toolCount:37});
  ui.get('include-document').checked=true;await ui.click('refresh-context');const old=ui.requests[0];
  ui.emit('snapshot',{workspace:customerWorkspace,state:customerState({toolCatalog:oldTools,toolCount:37}),busy:false,session:session(1)});
  await ui.respond(old,{context:{document:{title:'旧模型'},selection:null,capturedAt:'old'}});
  for(const state of [{workspace:modelWorkspace,ready:true,toolCatalog:oldTools,toolCount:37},sourceState(),
    {ready:true,toolCatalog:oldTools,toolCount:37},customerState({toolCatalog:oldTools,toolCount:37})])ui.emit('state',state);
  ui.emit('snapshot',{workspace:modelWorkspace,state:{workspace:modelWorkspace,ready:true,toolCatalog:oldTools},session:session(2,[],{document:{title:'迟到模型'},selection:null})});
  ui.emit('conversation',{state:{ready:true,toolCount:37,toolCatalog:oldTools},session:session(3)});
  assert.equal(ui.get('workspace-name').textContent,'聊天工作区');
  assert.equal(ui.get('tool-count').textContent,'工具范围：0项');assert.equal(ui.get('tool-list').childElementCount,0);
  assert.doesNotMatch(ui.get('context-summary').textContent,/旧模型|迟到模型/);
  assert.deepEqual(ui.flags(),{includeDocument:false,includeSelection:false});
  assert.ok(ui.suggestions.every(button=>!/buildx_source_|Revit/.test(button.dataset.prompt)));
});

test('customer submission always excludes context and stop copy makes no model operation claim',async()=>{
  const ui=await setup(customerState());
  ui.emit('snapshot',{workspace:customerWorkspace,state:customerState(),busy:false,session:session()});
  ui.get('include-document').checked=true;ui.get('include-selection').checked=true;
  await ui.click('refresh-context');assert.equal(ui.requests.length,0);
  ui.input('只进行聊天');await ui.submit();assert.equal(ui.requests.length,1);
  assert.deepEqual(ui.requests[0].body.context,{includeDocument:false,includeSelection:false});
  await ui.click('stop');await ui.respond(ui.requests[1]);
  assert.match(ui.get('activity-text').textContent,/停止本轮对话/);assert.doesNotMatch(ui.get('activity-text').textContent,/模型操作|源码工具/);
  ui.emit('done',{});await ui.respond(ui.requests[0]);
});

test('customer ready requires mandatory BuildX identity and explicit Codex proof even when transport says ready',async()=>{
  for(const extra of [{account:undefined},{account:{configured:false,required:true,signedIn:true}},{account:{configured:true,required:false,signedIn:true}},{account:{configured:true,required:true,signedIn:false}},
    {codexConfirmation:undefined},{codexConfirmation:{localConnectionConfirmed:false}}]){
    const ui=await setup(customerState(extra));ui.input('不可越过登录和确认');await ui.submit();
    assert.equal(ui.get('send').disabled,true);assert.equal(ui.requests.length,0);
  }
  const ui=await setup(customerState());ui.input('已核验');ui.emit('state',{ready:true,toolCount:37});
  await ui.submit();assert.equal(ui.requests.length,0);
  ui.emit('state',customerState());await ui.submit();assert.equal(ui.requests.length,1);await ui.respond(ui.requests[0]);
});
