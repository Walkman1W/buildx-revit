import test from 'node:test';
import assert from 'node:assert/strict';
import {createManualTypeParameterWriteField} from './public/manual-type-parameter-write-field.mjs';
import {NATIVE_TYPE_PARAMETER_WRITE_TOOLS,assertNativeTypeParameterWriteArguments,buildTypeParameterWriteReview} from './lib/native-type-parameter-writes.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const write='revit_set_type_parameter',read='revit_get_type_parameter_impact',typeId='9007199254740993',parameterId='-9223372036854775808';
const workspace={kind:'model',supportsModelContext:true},source={session:'a'.repeat(32),title:'手动类型写样例',path:'D:\\manual-type-write.rvt'};
const permission=(patch={})=>({available:true,level:'automatic',revision:1,conversationId:'chat-a',documentLabel:source.title,expiresAt:null,...patch});
const descriptor=(patch={})=>({parameter_id:parameterId,name:'类型备注 <script>',storage_type:'String',is_read_only:false,has_value:false,
  data_type:null,unit_type:null,value_internal:null,value_display:null,...patch});
const impact=(patch={})=>({schema_version:1,type_id:typeId,type_name:'类型 <A>',parameter:descriptor(),instance_ids:['9007199254740995'],instance_count:1,
  coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:4,indirect_effects:'not_assessed'},write_authorization:'not_granted',...patch});
const result=(body=impact(),document=source)=>({hostSession:document.session,document:{title:document.title,path:document.path},data:{value:body}});
const timerOwner={setTimeout:()=>({unref(){}}),clearTimeout(){}};
const all=node=>[node,...node.children.flatMap(all)];

async function fieldFixture(t){
  const ui=await createInputUi({layout:false,timers:timerOwner});t.after(()=>ui.close());const calls=[];let sequence=0;
  let snapshot={accountEpoch:1,contextEpoch:1,commandIdentityKey:'identity-a',commandConversationId:'chat-a',modelPermission:permission(),commands:[],busy:false,blocked:false};
  const field=createManualTypeParameterWriteField({document:ui.document,Event:UiEvent,id:'manual',schema:NATIVE_TYPE_PARAMETER_WRITE_TOOLS[0].inputSchema,
    onCommand:value=>{calls.push(value);return true;}});field.update(snapshot);
  const get=suffix=>all(field.element).find(node=>node.id==='manual-'+suffix),set=(suffix,value)=>{get(suffix).value=value;get(suffix).dispatchEvent(new UiEvent('input'));};
  const update=patch=>{snapshot={...snapshot,...patch};field.update(snapshot);};
  const command=(commandId,status,executionId,data)=>update({commands:[...snapshot.commands.filter(item=>item.commandId!==commandId),{commandId,status,executionId,...data}],busy:false,blocked:false});
  const begin=()=>{get('read-impact').click();const id='read-'+(++sequence);command(read,'running',id);return id;};
  const complete=(id,body=impact(),document=source)=>command(read,'completed',id,{result:result(body,document)});
  const load=(body=impact(),document=source)=>{const id=begin();complete(id,body,document);return id;};
  set('type-id',typeId);set('parameter-id',parameterId);
  return {ui,field,calls,get,set,update,command,begin,complete,load};
}

test('manual type controls read first, preserve exact IDs and build hidden guards only from the complete native result',async t=>{
  const f=await fieldFixture(t);assert.equal(f.get('type-id').type,'text');assert.equal(f.get('parameter-id').type,'text');assert.equal(f.get('submit').disabled,true);
  f.load();assert.deepEqual(f.calls[0],{commandId:read,parameters:{type_id:typeId,parameter_id:parameterId}});
  f.set('value','新值 <img src=x>');const args=f.field.parameters();
  assert.deepEqual(args,{type_id:typeId,parameter_id:parameterId,value:'新值 <img src=x>',mode:'rollback',
    expected_state:{storage_type:'String',has_value:false,value_internal:null,data_type:null},expected_instance_ids:['9007199254740995']});
  assert.deepEqual(f.field.sourceDocument(),source);assert.equal(Object.hasOwn(args,'expected_document'),false);
  assert.doesNotThrow(()=>assertNativeTypeParameterWriteArguments(write,{...args,expected_document:source.path}));
  assert.equal(all(f.field.element).some(node=>node.tagName==='TEXTAREA'||node.type==='checkbox'),false);
  f.field.input.value='{"expected_state":"forged"}';assert.equal(f.field.sourceDocument(),null);assert.equal(f.field.validate().ok,false);
  f.set('type-id','42');f.set('parameter-id','-123');f.get('read-impact').click();assert.deepEqual(f.calls.at(-1).parameters,{type_id:42,parameter_id:-123});
});

test('String empty values, Int32 and all Double specs use raw facts and explicit internal units without conversion',async t=>{
  const f=await fieldFixture(t);
  f.load();f.set('value','');assert.equal(f.field.parameters().value,'');assert.equal(f.field.parameters().expected_state.value_internal,null);
  f.load(impact({parameter:descriptor({storage_type:'Integer',has_value:true,value_internal:0})}));f.set('number','2147483647');
  assert.equal(f.field.parameters().value,2147483647);f.set('number','2147483648');assert.equal(f.field.validate().ok,false);
  f.set('number','1.5');assert.equal(f.field.validate().ok,false);
  for(const data_type of ['autodesk.spec.aec:length-2.0.0','autodesk.spec.aec:area-2.0.0',null]){
    f.load(impact({parameter:descriptor({storage_type:'Double',has_value:true,value_internal:2,data_type})}));f.set('number','914.4');
    const args=f.field.parameters();assert.equal(args.value,914.4);assert.equal(args.value_unit,'internal');assert.equal(args.expected_state.value_internal,2);
    assert.match(f.field.element.textContent,/Revit 内部单位 internal/);assert.doesNotMatch(f.field.element.textContent,/毫米|mm/);
    f.set('number','Infinity');assert.equal(f.field.validate().ok,false);f.set('number','');assert.equal(f.field.validate().ok,false);
  }
});

test('partial, wrong-target, unsafe and over-budget impact facts cannot enable a manual write',async t=>{
  const f=await fieldFixture(t),base=impact();
  for(const body of [impact({type_id:'42'}),impact({parameter:descriptor({parameter_id:'-123'})}),impact({instance_count:2}),
    impact({coverage:{...base.coverage,complete:false}}),impact({coverage:{...base.coverage,scanned_elements:0}}),impact({write_authorization:'granted'}),
    impact({parameter:descriptor({is_read_only:true})}),impact({parameter:descriptor({storage_type:'ElementId',value_internal:'42'})}),
    impact({parameter:descriptor({value_display:'x'.repeat(8193)})}),impact({instance_ids:[typeId]}),impact({instance_ids:[9007199254740992]})]){
    f.load(body);assert.equal(f.field.validate().ok,false);assert.equal(f.get('submit').disabled,true);assert.equal(f.field.sourceDocument(),null);
  }
  f.set('type-id','9223372036854775808');f.get('read-impact').click();assert.match(f.field.element.textContent,/精确类型 ID/);
  const ids=Array.from({length:500},(_,index)=>(BigInt(typeId)+2n+BigInt(index)).toString());f.set('type-id',typeId);
  f.load(impact({instance_ids:ids,instance_count:500,coverage:{...base.coverage,scanned_elements:500}}));assert.equal(f.field.parameters().expected_instance_ids.length,500);
});

test('target, identity, permission and execution changes retire late read results',async t=>{
  for(const change of ['target','context','account','conversation','permission','execution']){
    const f=await fieldFixture(t),id=f.begin();
    if(change==='target')f.set('type-id','42');
    if(change==='context')f.update({contextEpoch:2});
    if(change==='account')f.update({accountEpoch:2});
    if(change==='conversation')f.update({commandConversationId:'chat-b'});
    if(change==='permission')f.update({modelPermission:permission({revision:2})});
    if(change==='execution')f.command(read,'running','another-read');
    f.complete(id);assert.equal(f.field.validate().ok,false);assert.equal(f.field.sourceDocument(),null);
  }
  const f=await fieldFixture(t);const prior=f.load();f.get('read-impact').click();f.command(read,'pending');f.complete(prior);
  assert.equal(f.field.sourceDocument(),null);assert.equal(f.field.validate().ok,false);
});

test('a submitted draft is locked through unknown and stale terminal receipts, then clears only on its own terminal result',async t=>{
  const f=await fieldFixture(t);f.load();f.set('value','锁定值');f.field.lock();f.command(write,'pending');f.command(write,'running','write-a');
  f.set('value','不能覆盖');f.set('type-id','42');f.set('mode','commit');
  assert.equal(f.get('value').value,'锁定值');assert.equal(f.get('type-id').value,typeId);assert.equal(f.get('mode').value,'rollback');assert.equal(f.get('read-impact').disabled,true);
  f.command(write,'unknown','write-a');f.update({modelReceipt:null});assert.equal(f.get('value').disabled,true);assert.equal(f.get('submit').disabled,true);
  f.command(write,'completed','other-write');assert.equal(f.get('read-impact').disabled,true);
  f.command(write,'completed','write-a');assert.equal(f.get('read-impact').disabled,false);assert.equal(f.field.sourceDocument(),null);assert.equal(f.get('submit').disabled,true);
});

async function actual(t){
  const ui=await createInputUi({dynamicImports:true,timers:timerOwner});t.after(()=>ui.close());
  const catalog=MODEL_COMMAND_CATALOG,definition=catalog.find(item=>item.tool===write);assert.equal(definition.manualExecution,true);assert.equal(definition.requiresTypeParameterReview,true);
  ui.emit('state',{workspace,ready:true,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,commandCatalog:catalog,historyAvailable:true,
    account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1}});
  const emit=(patch={})=>ui.emit('conversation',{workspace,busy:false,session:session(),modelPermission:permission(),...patch});emit();await flush();
  const prefix='model-command-'+write+'-type-write-',get=suffix=>ui.get(prefix+suffix),set=(suffix,value)=>{get(suffix).value=value;get(suffix).dispatchEvent(new UiEvent('input'));};
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===write);
  const readImpact=async(body=impact())=>{set('type-id',typeId);set('parameter-id',parameterId);get('read-impact').click();await flush();
    const request=ui.requests.at(-1);assert.equal(request.body.commandId,read);await ui.respond(request,{ok:true,executionId:'actual-read'});
    emit({command:{commandId:read,conversationId:'chat-a',executionId:'actual-read',status:'completed',result:result(body)}});await flush();};
  return {...ui,project:emit,global:ui.get,get,set,row,readImpact};
}

test('actual manual UI submits an intent then waits for the shared final review even under automatic commit',async t=>{
  const ui=await actual(t);assert.equal(ui.row.querySelectorAll('.model-command-confirm').length,0);assert.equal(ui.row.querySelectorAll('.model-command-run').length,0);
  await ui.readImpact();ui.set('value','拟议手动类型值');ui.set('mode','commit');ui.get('submit').click();ui.get('submit').click();await flush();
  assert.equal(ui.requests.length,2);const request=ui.requests[1];assert.equal(request.url,'/api/command');assert.equal(request.body.commandId,write);
  assert.equal(request.body.confirmed,true);assert.deepEqual(request.body.sourceDocument,source);assert.equal(Object.hasOwn(request.body.parameters,'expected_document'),false);
  assert.deepEqual(request.body.parameters.expected_instance_ids,impact().instance_ids);assert.deepEqual(request.body.parameters.expected_state,{storage_type:'String',has_value:false,value_internal:null,data_type:null});
  assert.equal(ui.get('value').disabled,true);ui.set('value','不得改变已提案内容');assert.equal(ui.get('value').value,'拟议手动类型值');
  await ui.respond(request,{ok:true,executionId:'actual-write'});
  const review=buildTypeParameterWriteReview({...request.body.parameters,expected_document:source.path},impact(),source),proposal={id:'manual-review',digest:'b'.repeat(64),
    kind:'model',action:write,target:source.title,cwd:'',source:'逐次确认，间接影响未评估。',parameters:'核对完整审阅卡。',typeParameterReview:JSON.stringify(review),deadline:Date.now()+30000,conversationId:'chat-a'};
  ui.project({busy:true,command:{commandId:write,conversationId:'chat-a',executionId:'actual-write',status:'running',progress:{phase:'awaiting_approval'}},dynamicApproval:proposal});await flush();
  const box=ui.global('dynamic-approval');assert.equal(box.hidden,false);assert.match(box.textContent,/拟议手动类型值/);assert.equal(ui.requests.length,2);
  const buttons=box.querySelectorAll('.dynamic-approval-actions')[0].children;buttons[0].click();buttons[0].click();await flush();
  assert.equal(ui.requests.length,3);assert.equal(ui.requests[2].url,'/api/dynamic-approval');
  assert.deepEqual(Object.keys(ui.requests[2].body).sort(),['client','conversationId','decision','digest','requestId']);
  await ui.respond(ui.requests[2],{ok:true,requestId:proposal.id,decision:'accept',status:'submitted'});
  const completed={commandId:write,conversationId:'chat-a',executionId:'actual-write',status:'completed'};
  ui.project({command:completed,dynamicApproval:null});await flush();assert.match(box.textContent,/等待模型操作结果/);assert.doesNotMatch(box.textContent,/模型操作已完成/);
  for(const foreign of [{requestId:'other-review'},{digest:'f'.repeat(64)},{conversationId:'other-chat'}]){
    ui.project({command:completed,dynamicApproval:null,dynamicApprovalResult:{requestId:proposal.id,digest:proposal.digest,conversationId:'chat-a',status:'completed',...foreign}});await flush();
    assert.match(box.textContent,/等待模型操作结果/);assert.doesNotMatch(box.textContent,/模型操作已完成/);
  }
  ui.project({command:completed,dynamicApproval:null,dynamicApprovalResult:{requestId:proposal.id,digest:proposal.digest,conversationId:'chat-a',status:'completed'}});await flush();
  assert.match(box.textContent,/模型操作已完成，请查看执行结果/);assert.doesNotMatch(box.textContent,/等待模型操作结果/);
  buttons[0].click();await flush();assert.equal(ui.requests.length,3);
  assert.equal(ui.get('read-impact').disabled,false);assert.equal(ui.get('submit').disabled,true);assert.equal(ui.requests.length,3);
});

test('an accepted manual review stays unconfirmed on matching unknown evidence and ignores foreign completion packets',async t=>{
  const ui=await actual(t);await ui.readImpact();ui.set('value','未知结果原值');ui.get('submit').click();await flush();
  const request=ui.requests[1];await ui.respond(request,{ok:true,executionId:'unknown-manual-write'});
  const review=buildTypeParameterWriteReview({...request.body.parameters,expected_document:source.path},impact(),source),proposal={id:'unknown-manual-review',digest:'e'.repeat(64),kind:'model',action:write,
    target:source.title,cwd:'',source:'逐次确认',parameters:'审阅',typeParameterReview:JSON.stringify(review),deadline:Date.now()+30000,conversationId:'chat-a'};
  const command={commandId:write,conversationId:'chat-a',executionId:'unknown-manual-write',status:'running'};
  ui.project({busy:true,command,dynamicApproval:proposal});await flush();const box=ui.global('dynamic-approval'),accept=box.querySelectorAll('.dynamic-approval-actions')[0].children[0];
  accept.click();await flush();await ui.respond(ui.requests[2],{ok:true,requestId:proposal.id,decision:'accept',status:'submitted'});
  ui.project({command:{...command,status:'unknown'},dynamicApproval:null,dynamicApprovalResult:{requestId:proposal.id,digest:proposal.digest,conversationId:'chat-a',status:'unconfirmed'}});await flush();
  assert.match(box.textContent,/结果尚未确认.*核对原回执/);assert.doesNotMatch(box.textContent,/模型操作已完成/);assert.equal(ui.get('read-impact').disabled,true);
  ui.project({command:{...command,status:'completed'},dynamicApproval:null,dynamicApprovalResult:{requestId:'foreign-manual-review',digest:proposal.digest,conversationId:'chat-a',status:'completed'}});await flush();
  assert.match(box.textContent,/结果尚未确认/);assert.doesNotMatch(box.textContent,/模型操作已完成/);assert.equal(accept.disabled,true);accept.click();await flush();assert.equal(ui.requests.length,3);
});

test('actual default rollback still requires the final decision and permission changes invalidate its controls',async t=>{
  const ui=await actual(t);await ui.readImpact();assert.equal(ui.get('mode').value,'rollback');ui.set('value','预览值');ui.get('submit').click();await flush();
  const request=ui.requests[1];await ui.respond(request,{ok:true,executionId:'rollback-write'});
  const review=buildTypeParameterWriteReview({...request.body.parameters,expected_document:source.path},impact(),source),proposal={id:'rollback-review',digest:'c'.repeat(64),kind:'model',action:write,
    target:source.title,cwd:'',source:'逐次确认',parameters:'审阅',typeParameterReview:JSON.stringify(review),deadline:Date.now()+30000,conversationId:'chat-a'};
  ui.project({busy:true,command:{commandId:write,conversationId:'chat-a',executionId:'rollback-write',status:'running'},dynamicApproval:proposal});await flush();
  const accept=ui.global('dynamic-approval').querySelectorAll('.dynamic-approval-actions')[0].children[0];assert.equal(ui.requests.length,2);
  ui.project({busy:true,modelPermission:permission({revision:2}),dynamicApproval:proposal});await flush();assert.equal(accept.disabled,true);accept.click();await flush();assert.equal(ui.requests.length,2);
  assert.equal(ui.get('value').disabled,true);ui.project({command:{commandId:write,conversationId:'chat-a',executionId:'rollback-write',status:'failed'},dynamicApproval:null});await flush();
  assert.equal(ui.get('read-impact').disabled,false);assert.equal(ui.get('submit').disabled,true);
});

test('actual admission rejection unlocks only for a fresh read, and a missing manual marker provides no generic JSON fallback',async t=>{
  const ui=await actual(t);await ui.readImpact();ui.get('submit').click();await flush();await ui.respond(ui.requests[1],{error:'Controlled admission failure'},false);
  assert.equal(ui.get('read-impact').disabled,false);assert.equal(ui.get('submit').disabled,true);
  const catalog=MODEL_COMMAND_CATALOG.map(item=>item.tool===write?{...item,requiresTypeParameterReview:false}:item);
  ui.emit('state',{workspace,ready:true,commandsReady:true,directCommandsAvailable:true,commandCatalog:catalog,connectionGeneration:1,codexAccount:{accountRevision:1}});await flush();
  const row=ui.document.body.querySelectorAll('.model-command-item').find(item=>item.dataset.commandId===write);
  assert.equal(all(row).some(node=>['INPUT','TEXTAREA','SELECT','BUTTON'].includes(node.tagName)),false);
  await ui.intent('buildx-model-command',{commandId:write,parameters:{},confirmed:true});assert.equal(ui.requests.length,2);
});

test('access policy fallback and top-level precedence apply before a typed preview captures its permission identity',async t=>{
  for(const topLevel of [false,true]){
    const ui=await createInputUi({layout:false,dynamicImports:true,timers:timerOwner});t.after(()=>ui.close());
    ui.emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:1}});
    const fallback={available:true,id:'session-policy',revision:2,mode:'project-write',roots:['D:\\']};
    const top={available:true,id:'top-policy',revision:1,mode:'full-access',roots:[]};
    const args={expected_document:source.path,type_id:typeId,parameter_id:parameterId,value:'审阅值',mode:'rollback',
      expected_state:{storage_type:'String',has_value:false,value_internal:null,data_type:null},expected_instance_ids:impact().instance_ids};
    const proposal={id:'policy-review',digest:'d'.repeat(64),kind:'model',action:write,target:source.title,cwd:'',source:'逐次确认',parameters:'审阅',
      typeParameterReview:JSON.stringify(buildTypeParameterWriteReview(args,impact(),source)),deadline:Date.now()+30000,conversationId:'chat-a'};
    ui.emit('conversation',{workspace,busy:true,session:{...session(),accessPolicy:fallback},modelPermission:permission(),
      ...(topLevel?{accessPolicy:top}:{}),dynamicApproval:proposal,dynamicApprovalResult:null});await flush();
    assert.equal(ui.view().accessPolicy.id,topLevel?top.id:fallback.id);
    const box=ui.get('dynamic-approval');assert.equal(box.hidden,false);const accept=box.querySelectorAll('.dynamic-approval-actions')[0].children[0];
    assert.equal(accept.disabled,false);accept.click();await flush();assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].body.digest,proposal.digest);
  }
});
