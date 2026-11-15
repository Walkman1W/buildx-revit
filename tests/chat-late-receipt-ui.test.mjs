import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { receiptNoticeState } from '../public/chat-view.mjs';

test('structured operation cards distinguish known refusal, timeout and execution evidence from an unknown result', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start=source.indexOf('const originalReadReceiptLabels='),end=source.indexOf('\nconst generatedFileName',start);
  const context=vm.createContext({openedTools:new Set(),toolStatus:()=>'',node(tag,className='',text=''){
    return {tag,className,text,children:[],append(...nodes){this.children.push(...nodes);},addEventListener(){}};
  }});
  vm.runInContext(source.slice(start,end),context);
  for(const [outcome,status,code,label] of [
    ['not_started','failed','MODEL_APPROVAL_EXPIRED','确认超时，未执行'],
    ['not_started','failed','MODEL_OPERATION_UNSUPPORTED','工具未开放，未执行'],
    ['unconfirmed','unknown','MODEL_REVIT_EXECUTION_FAILED','Revit 执行失败，结果待核对'],
    ['unconfirmed','unknown',undefined,'结果待核对'],
  ]){
    const card=context.toolCard('message',{id:'operation',name:'buildx_model_operation',label:'模型操作回执',status,operationReceipt:{outcome,code,tool:'revit_set_parameter_value',requestId:'request'}});
    const [summary,content]=card.children;
    assert.equal(summary.children.at(-1).text,label);
    assert.match(card.className,new RegExp(status+'$'));
    assert.ok(content.children.some(child=>child.text==='request'));
    if(outcome==='unconfirmed')assert.ok(content.children.some(child=>child.text.includes('避免重复提交')));
  }
});

test('manual auto apply submits only an explicitly eligible current project commit',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function runCommand('),end=source.indexOf('\nasync function checkCommandReceipt(',start);
  const captured=[];
  const context=vm.createContext({modelUiEnabled:true,modelContextAllowed:true,directCommandsAvailable:true,commandsReady:true,
    busy:false,commandPending:()=>false,modelPermissionPending:null,pendingRequests:new Set(),historyEnabled:()=>false,
    commandConversationId:()=> 'current',knownCommand:()=>true,confirmedWrite:true,scopedAutomatic:true,accountEpoch:0,contextEpoch:0,
    commandRevision:0,busyRevision:0,commandResults:new Map(),activeCommand:null,beginRequest:(_name,value)=>value,
    modelPermission:{available:true,conversationId:'current',expiresAt:null,level:'automatic'},accessPolicy:{mode:'project-write',modelWritable:true},
    updateButtons(){},finishRequest(){},ownsRequest:()=>true,setTimeout,clearTimeout,
    post:async(name,data)=>{captured.push({name,data});return {ok:true,executionId:'actual-response'};}});
  vm.runInContext(source.slice(start,end),context);
  const definition={id:'operation',tool:'revit_create_group',effectKind:'model_transaction',readOnly:false,scopedAutoApplyEligible:true};
  const detail={commandId:'operation',parameters:{mode:'commit'}};
  for(const changes of [{scopedAutoApplyEligible:false},{tool:'revit_set_type_parameter',requiresTypeParameterReview:true}]){
    context.commandCatalog=[{...definition,...changes}];await context.runCommand(detail);
  }
  context.commandCatalog=[definition];
  await context.runCommand({...detail,parameters:{mode:'rollback'}});
  context.accessPolicy={mode:'full-access',modelWritable:true};await context.runCommand(detail);
  context.accessPolicy={mode:'project-write',modelWritable:false};await context.runCommand(detail);
  context.accessPolicy={mode:'project-write',modelWritable:true};
  context.modelPermission={...context.modelPermission,conversationId:'previous'};await context.runCommand(detail);
  assert.equal(captured.length,0);
  context.modelPermission={...context.modelPermission,conversationId:'current'};await context.runCommand(detail);
  assert.equal(captured.length,1);assert.equal(captured[0].name,'command');assert.equal(captured[0].data.confirmed,undefined);
});

test('late receipt updates only its original tool card without changing message or other cards', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderConversation() {'), source.indexOf('\nfunction renderContext()', source.indexOf('function renderConversation() {')));
  const nodes = new Map();
  const make = () => ({
    children: [], className: '', hidden: false, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    get childElementCount() { return this.children.length; },
    insertBefore(item, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, item); },
    remove() {}, setAttribute() {}, addEventListener() {},
  });
  const elements = new Map(['welcome', 'history-note', 'transcript'].map(id => [id, make()]));
  const opened = new Set(['m:a']);
  const context = { messages: [{ id: 'm', role: 'assistant', text: 'answer', tools: [{ id: 'a' }, { id: 'b' }] }], lastSession: {}, generatedFilesView: null, messageNodes: nodes, openedTools: opened, accountEpoch: 0, contextEpoch: 0, modelUiEnabled: false, modelContextAllowed: false, commandIdentityKey: () => '', commandConversationId: () => '', nearBottom: () => false, scrollBottom() {}, $: id => elements.get(id), node: make, messageStatus: () => '', receiptNoticeState, renderMarkdown(el, text) { el.textContent = text; }, toolCard(messageId, tool, receipt) { return { id: tool.id, receipt, open: opened.has(messageId + ':' + tool.id) }; } };
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
