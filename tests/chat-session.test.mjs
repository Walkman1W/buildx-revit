import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ChatSession,CHAT_LIMITS,previewChatValue,previewMcpResult,boundedChatNotification} from '../lib/chat-session.mjs';
import {panelConversationEvents,panelSnapshot,projectPanelConversation} from '../lib/panel-chat-format.mjs';

function started(){const s=new ChatSession();s.threadId='thread-1';const run=s.begin('检查模型');run.turnId='turn-1';return {s,run};}
const owned=(extra={})=>({threadId:'thread-1',turnId:'turn-1',...extra});
const label=name=>name==='revit_get_selection'?'当前选择':null;
test('native model receipts preserve owned reasons and unknown results in conversation history',()=>{
  const {s,run}=started(),foreign=started();
  const timeout={id:randomUUID(),tool:'revit_set_parameter_value',outcome:'not_started',code:'MODEL_APPROVAL_EXPIRED'};
  const missing={id:randomUUID(),tool:'revit_create_wall',outcome:'not_started',code:'MODEL_OPERATION_UNSUPPORTED'};
  const execution={id:randomUUID(),tool:'revit_create_group',outcome:'unconfirmed',code:'MODEL_REVIT_EXECUTION_FAILED',requestId:randomUUID()};
  assert.equal(s.recordModelOperationReceipt(foreign.run,timeout),false);
  assert.equal(s.recordModelOperationReceipt(run,{...execution,outcome:'timeout'}),false);
  for(const receipt of [timeout,missing,execution])assert.equal(s.recordModelOperationReceipt(run,receipt),true);
  assert.equal(s.recordModelOperationReceipt(run,execution),false);
  assert.equal(s.finish(run,'completed'),true);
  assert.equal(s.recordModelOperationReceipt(run,{...timeout,id:randomUUID()}),false);
  const snapshot=s.view(), saved=panelConversationEvents(s.conversationId,[],snapshot,undefined,new Date().toISOString());
  assert.equal(saved.ok,true);
  const projected=projectPanelConversation(s.conversationId,saved.events);
  const tools=projected.session.messages.find(message=>message.role==='assistant').tools;
  assert.deepEqual(tools.map(tool=>tool.status),['failed','failed','unknown']);
  assert.deepEqual(tools.map(({id,operationReceipt})=>({id,...operationReceipt})),[timeout,missing,execution]);
  const tampered=structuredClone(snapshot);tampered.messages[1].tools.at(-1).status='failed';
  assert.equal(panelSnapshot(tampered).ok,false);
});
test('terminal with an event ID survives a full deduplication budget without hiding dropped events',()=>{
  for(const drops of [false,true]){
    const {s,run}=started();
    for(let i=0;i<1024;i++)s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'x',eventId:'e-'+i}));
    assert.equal(run.seen.size,1024);
    if(drops)s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'lost',eventId:'overflow'}));
    const result=s.notification(run,'turn/completed',owned({eventId:'terminal',turn:{id:'turn-1',status:'completed'}}));
    assert.equal(result.terminal,drops?'unknown':'completed');
    if(drops)assert.match(result.error,/不完整/);
    assert.equal(s.finish(run,result.terminal,result.error),true);
    assert.equal(s.run,null);assert.equal(s.view().messages[1].status,drops?'unknown':'completed');
  }
});
test('a 41st assistant item cannot be silently reported as a complete answer',()=>{
  const {s,run}=started();
  for(let i=0;i<40;i++)s.notification(run,'item/agentMessage/delta',owned({itemId:'item-'+i,delta:'part'}));
  assert.equal(s.notification(run,'item/agentMessage/delta',owned({itemId:'item-40',delta:'not retained'})).changed,true);
  assert.match(s.activity,/未显示/);
  const terminal=s.notification(run,'turn/completed',owned({turn:{id:'turn-1',status:'completed'}}));
  s.finish(run,terminal.terminal);assert.equal(s.view().messages[1].status,'unknown');assert.match(s.view().messages.at(-1).text,/截断/);
});
test('a 41st tool cannot make an incomplete execution record look complete',()=>{
  const {s,run}=started();
  for(let i=0;i<40;i++){
    const item={id:'tool-'+i,type:'mcpToolCall',tool:'revit_get_selection',status:'completed'};
    s.notification(run,'item/completed',owned({item}),label);
  }
  // An unrecorded write may have entered the host before the turn ends.
  s.notification(run,'item/started',owned({item:{id:'tool-40',type:'mcpToolCall',tool:'revit_execute_csharp',status:'inProgress'}}),name=>name==='revit_execute_csharp'?'脚本':label(name));
  assert.equal(s.view().messages[1].tools.length,40);assert.equal(s.view().messages[1].toolHistoryTruncated,true);
  assert.match(s.activity,/后续记录未显示/);
  assert.equal(s.view().historyTruncated,false);
  const terminal=s.notification(run,'turn/completed',owned({turn:{id:'turn-1',status:'completed'}}));s.finish(run,terminal.terminal);
  assert.equal(s.view().messages[1].status,'completed');assert.equal(s.run,null);
});
test('tool display overflow preserves failed and unknown terminal outcomes',()=>{
  for(const status of ['failed','unknown','interrupted']){
    const {s,run}=started();
    for(let i=0;i<41;i++)s.notification(run,'item/started',owned({item:{id:'tool-'+i,type:'mcpToolCall',tool:'revit_get_selection'}}),label);
    s.finish(run,status,status==='unknown'?'连接结果未知':null);
    const message=s.view().messages[1];assert.equal(message.status,status);assert.equal(message.toolHistoryTruncated,true);assert.equal(message.tools[0].status,'unknown');
  }
});
test('workbench tool errors retain unknown operation outcome unless the named producer supplies a valid fact',()=>{
  for(const [outcome,expected] of [[null,'unknown'],['unconfirmed','unknown'],['failed','failed'],['expired','failed'],['not_started','failed'],['forged','unknown']]){
    const {s,run}=started();const item={id:'tool',type:'mcpToolCall',server:'revit_workbench',tool:'revit_get_selection',status:'failed',error:{message:'tool call failed'}};
    const structuredContent=outcome?{buildxToolOutcome:{schemaVersion:1,outcome}}:undefined;
    const event=boundedChatNotification('item/completed',owned({item:{...item,result:{content:[{type:'text',text:'original detail'}],...(structuredContent?{structuredContent}:{})}}}));
    s.notification(run,'item/completed',event,label);assert.equal(s.view().messages[1].tools[0].status,expected,outcome);
  }
  const {s,run}=started(),event=boundedChatNotification('item/completed',owned({item:{id:'tool',type:'mcpToolCall',server:'other',tool:'revit_get_selection',status:'failed',error:{message:'outside workbench'}}}));
  s.notification(run,'item/completed',event,label);assert.equal(s.view().messages[1].tools[0].status,'failed');
  const missing=started(),withoutServer=boundedChatNotification('item/completed',owned({item:{id:'tool',type:'mcpToolCall',tool:'revit_get_selection',status:'failed',result:{content:[],structuredContent:{buildxToolOutcome:{schemaVersion:1,outcome:'failed'}}}}}));
  missing.s.notification(missing.run,'item/completed',withoutServer,label);assert.equal(missing.s.view().messages[1].tools[0].status,'unknown');
});
test('session owns every public event by exact run/thread/turn and hides reasoning',()=>{
  const {s,run}=started();
  for(const params of [{itemId:'a',delta:'坏数据'},owned({threadId:'foreign',itemId:'a',delta:'坏数据'}),owned({turnId:'old',itemId:'a',delta:'坏数据'})])assert.equal(s.notification(run,'item/agentMessage/delta',params).changed,false);
  s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'正在核对',eventId:'delta-1'}));
  s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'正在核对',eventId:'delta-1'}));
  s.notification(run,'item/started',owned({item:{id:'private',type:'reasoning',text:'秘密推理'}}));
  s.notification(run,'item/completed',owned({item:{id:'a',type:'agentMessage',text:'已核对'}}));
  s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'迟到'}));
  s.notification(run,'item/agentMessage/delta',owned({itemId:'b',delta:'第二段'}));
  assert.equal(s.view().messages[1].text,'已核对\n\n第二段');
  s.finish(run,'completed');assert.equal(s.notification(run,'item/agentMessage/delta',owned({itemId:'b',delta:'迟到'})).changed,false);
});
test('tool cards update by item id, complete means returned, errors fail and duplicate completion is idempotent',()=>{
  const {s,run}=started();const item={id:'tool-1',type:'mcpToolCall',tool:'revit_get_selection',arguments:{expected_document:'D:\\sample.rvt',token:'private-value'}};
  s.notification(run,'item/started',owned({item}),label);
  s.notification(run,'item/completed',owned({item:{...item,status:'completed',result:{content:[{type:'text',text:'{"count":2}'}]}}}),label);
  s.notification(run,'item/completed',owned({item:{...item,status:'failed',error:'迟到错误'}}),label);
  s.notification(run,'item/started',owned({item:{...item,id:'tool-2'}}),label);
  s.notification(run,'item/completed',owned({item:{...item,id:'tool-2',status:'completed',result:{isError:true,content:[]}}}),label);
  s.notification(run,'item/started',owned({item:{...item,id:'tool-3'}}),label);
  s.finish(run,'interrupted');
  const message=s.view().messages[1];assert.deepEqual(message.tools.map(tool=>tool.status),['returned','failed','unknown']);
  assert.match(message.tools[0].argumentsPreview,/private-value/);assert.equal(message.status,'interrupted');assert.match(s.view().messages[2].text,/不代表|需要核对/);
});
test('reset preserves visible history with new context epoch while new chat clears only its session',()=>{
  const {s,run}=started();s.finish(run,'completed');s.context={document:{title:'sample',path:'D:\\s.rvt'},selection:null,capturedAt:'now'};
  s.resetContext();assert.equal(s.contextEpoch,1);assert.equal(s.threadId,null);assert.equal(s.messages.length,3);assert.match(s.messages.at(-1).text,/AI 上下文已重置/);assert.equal(s.context.document,null);
  s.newChat();assert.equal(s.contextEpoch,2);assert.deepEqual(s.messages,[]);
});
test('history and tool previews are bounded; pending payload excludes private and full object fields',()=>{
  const s=new ChatSession();for(let index=0;index<100;index++)s.add('user','x'.repeat(12000));assert.ok(s.messages.length<=CHAT_LIMITS.messages);assert.ok(s.messages.reduce((sum,m)=>sum+m.text.length,0)<=CHAT_LIMITS.totalText);assert.equal(s.historyTruncated,true);
  const value={api_key:'plain-key',authorization:'Bearer private',payload:'x'.repeat(20000)};value.loop=value;
  const preview=previewChatValue(value);assert.ok(preview.length<=CHAT_LIMITS.preview+20);assert.match(preview,/预览已截断/);
  assert.equal(boundedChatNotification('item/reasoning/delta',{delta:'private'}),null);
  const event=boundedChatNotification('item/completed',owned({account:{name:'private'},item:{id:'tool',type:'mcpToolCall',tool:'revit_get_selection',status:'completed',arguments:value,result:{apiKey:'raw-secret'},other:'private'}}));
  assert.doesNotMatch(JSON.stringify(event),/"account"|"other"/);assert.equal(boundedChatNotification('account/read',{account:{name:'private'}}),null);
});
test('ordinary token/secret design parameter names and user/code text remain exact',()=>{
  const input='token = "sample"; // secret means a design parameter\nreturn new { password = "label" };';
  const s=new ChatSession();const run=s.begin(input);assert.equal(s.view().messages[0].text,input);
  assert.equal(previewChatValue(input),input);assert.match(previewChatValue({token:'design-value',secret:'design-value'}),/design-value/);
  run.threadId='thread-1';run.turnId='turn-1';
  s.notification(run,'item/agentMessage/delta',owned({itemId:'a',delta:'x'.repeat(CHAT_LIMITS.text+5)}));s.finish(run,'completed');
  assert.equal(s.view().messages[1].status,'unknown');assert.match(s.view().messages[1].text,/预览已截断/);
});
test('MCP text blocks remain readable data, non-text keeps its type, and every truncation is explicit',()=>{
  const text='{"element_ids":[1,2],"token":"design value"}';
  const preview=previewMcpResult({isError:false,content:[{type:'text',text},{type:'image',data:'private-large-binary'}]});
  assert.match(preview,/\[text\]/);assert.ok(preview.includes(text));assert.match(preview,/image/);assert.doesNotMatch(preview,/private-large-binary/);
  assert.match(previewChatValue(Array.from({length:20},(_,i)=>i)),/后续数组预览已截断/);
  assert.match(previewChatValue(Object.fromEntries(Array.from({length:20},(_,i)=>['key'+i,i]))),/后续字段预览已截断/);
});
