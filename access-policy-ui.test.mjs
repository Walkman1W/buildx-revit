import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,session,flush,UiEvent} from './test-support/model-input-ui-fixture.mjs';

const policy=(overrides={})=>({available:true,id:'policy-a',revision:0,mode:'read-only',roots:[],modelWritable:false,...overrides});
const permission=(overrides={})=>({available:true,level:'rollback',revision:1,conversationId:'chat-a',documentLabel:'项目一',expiresAt:null,...overrides});
async function setup(t,value=policy()){
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,connectionGeneration:1,codexAccount:{accountRevision:1},historyAvailable:true});
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:value,modelPermission:permission()});await flush();return ui;
}
const scopeModes=['read-only','project-write','full-access'];
const scopeButton=(ui,mode)=>ui.get('model-access-'+mode);
function assertCurrentScope(ui,mode){for(const candidate of scopeModes)assert.equal(scopeButton(ui,candidate).getAttribute('aria-pressed'),String(candidate===mode),candidate);}
async function choose(ui,mode){scopeButton(ui,mode).click();await flush();}
const posts=ui=>ui.requests.filter(item=>item.url==='/api/access-policy');

test('an idle permission snapshot clears a lost HTTP response without clearing the original model receipt',async t=>{
  const ui=await setup(t);
  const state={workspace:{kind:'model',supportsModelContext:true},ready:true,historyAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}};
  const receipt={ticket:'visual-a',conversationId:'chat-a',tool:'revit_inspect_elements',checking:false,checkRevision:1,check:{status:'unconfirmed',terminal:false}};
  ui.input('继续分析');
  ui.emit('conversation',{busy:false,session:session(),modelPermission:permission(),modelReceipt:receipt});
  const select=ui.get('model-permission-select');
  select.value='confirm';select.dispatchEvent(new UiEvent('change'));await flush();
  const change=ui.requests.find(request=>request.url==='/api/model-permission');
  assert.ok(change);assert.equal(select.value,'__pending');
  ui.emit('state',{...state,busy:true,busyOperation:'model-permission-check'});
  assert.equal(ui.get('send').disabled,true);
  assert.equal(ui.get('new-chat').disabled,true);
  ui.emit('conversation',{state:{...state,busy:false,busyOperation:null},busy:false,session:session(),modelPermission:permission({level:'confirm',revision:2}),modelReceipt:receipt});
  await flush();
  assert.equal(select.value,'confirm');
  assert.equal(ui.get('send').disabled,false);
  assert.equal(ui.get('new-chat').disabled,false);
  assert.equal(ui.get('model-receipt-panel').hidden,false);
  assert.match(ui.get('model-receipt-panel').textContent,/视图检查结果待核查/);
  assert.equal(ui.requests.filter(request=>request.url==='/api/model-permission').length,1);
  await ui.respond(change,{ok:true,modelPermission:permission({level:'confirm',revision:2})});
});

test('visual recovery requires a current original receipt capability and a specific user click',async t=>{
  const ui=await setup(t);
  const receipt={ticket:'visual-a',conversationId:'chat-a',tool:'revit_inspect_elements',checking:false,checkRevision:1,check:{status:'unconfirmed',terminal:false}};
  const show=modelReceipt=>ui.emit('conversation',{busy:false,session:session(),modelPermission:permission(),modelReceipt});
  show(receipt);
  const panel=ui.get('model-receipt-panel'),check=panel.querySelectorAll('.model-receipt-check')[0],restore=panel.querySelectorAll('.model-receipt-recover')[0];
  assert.equal(restore.hidden,true);
  assert.equal(check.textContent,'核查原回执');
  check.click();await flush();
  const lookup=ui.requests.find(request=>request.url==='/api/model-receipt/check');
  assert.deepEqual(lookup.body,{client:lookup.body.client,conversationId:'chat-a',ticket:'visual-a'});
  await ui.respond(lookup);
  show({...receipt,checkRevision:2,check:{...receipt.check,canRestoreVisual:true}});
  assert.equal(restore.hidden,false);
  assert.equal(restore.textContent,'恢复临时检查视图');
  assert.equal(ui.requests.some(request=>request.url==='/api/model-receipt/restore-visual'),false);
  restore.click();await flush();
  const recovery=ui.requests.find(request=>request.url==='/api/model-receipt/restore-visual');
  assert.deepEqual(recovery.body,{client:recovery.body.client,conversationId:'chat-a',ticket:'visual-a',checkRevision:2,confirmed:true});
  restore.click();await flush();
  assert.equal(ui.requests.filter(request=>request.url==='/api/model-receipt/restore-visual').length,1);
  assert.equal(ui.requests.some(request=>request.url==='/api/command'),false);
  await ui.respond(recovery);
});

test('access scope is a separate server projection and never assumes full or write access',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  assert.equal(ui.get('model-access-options').disabled,true);assertCurrentScope(ui,null);
  for(const mode of scopeModes)assert.equal(scopeButton(ui,mode).disabled,true);
  await choose(ui,'full-access');assert.equal(ui.get('model-access-confirm').hidden,true);assert.equal(posts(ui).length,0);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy(),modelPermission:permission()});
  assertCurrentScope(ui,'read-only');assert.equal(ui.get('model-permission-select').value,'rollback');
  const group=ui.get('model-access-options');assert.equal(group.tagName,'FIELDSET');assert.equal(group.getAttribute('aria-label'),'访问权限');
  assert.equal(ui.get('model-permission-select').getAttribute('aria-label'),'执行方式');
  assert.equal(group.children.filter(child=>child.tagName==='BUTTON').length,3);
  for(const mode of scopeModes){assert.equal(scopeButton(ui,mode).tagName,'BUTTON');assert.equal(scopeButton(ui,mode).type,'button');}
  const descendants=element=>[element,...element.children.flatMap(descendants)];
  assert.equal(descendants(ui.document.body).some(element=>element.id==='model-access-select'||element.tagName==='SELECT'&&element.getAttribute('aria-label')==='访问权限'),false);
  assert.equal(posts(ui).length,0);
  await choose(ui,'read-only');assert.equal(posts(ui).length,0);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:{available:true,loading:true}});
  assert.equal(scopeButton(ui,'full-access').disabled,true);assertCurrentScope(ui,null);assert.match(ui.get('model-access-status').textContent,/正在读取/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy()});
  assert.equal(scopeButton(ui,'full-access').disabled,false);
});

test('full access needs explicit range confirmation; cancel never submits and a receipt remains authoritative',async t=>{
  const ui=await setup(t);await choose(ui,'full-access');
  assert.equal(posts(ui).length,0);assertCurrentScope(ui,'read-only');assert.equal(ui.get('model-access-confirm').hidden,false);
  assert.match(ui.get('model-access-confirm').textContent,/不限于资料库/);
  assert.match(ui.get('model-access-status').textContent,/当前仍为只读，待确认完全访问/);
  assert.match(ui.get('model-access-status').textContent,/确认卡点击“启用完全访问”/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy(),modelPermission:permission()});
  assert.equal(ui.get('model-access-confirm').hidden,false);assert.equal(posts(ui).length,0);
  ui.get('model-access-confirm-cancel').click();await flush();assert.equal(posts(ui).length,0);
  assert.equal(ui.get('model-access-confirm').hidden,true);assertCurrentScope(ui,'read-only');
  assert.match(ui.get('model-access-status').textContent,/文件与模型只读/);assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  await choose(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();
  assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'full-access',confirmed:true,expectedRevision:0});
  assert.equal(posts(ui).length,1);assertCurrentScope(ui,'read-only');assert.equal(ui.get('model-access-options').getAttribute('aria-busy'),'true');
  for(const mode of scopeModes)assert.equal(scopeButton(ui,mode).disabled,true);
  assert.equal(ui.get('model-permission-select').disabled,true);
  assert.equal(ui.get('model-access-confirm').hidden,true);assert.equal(ui.get('model-access-status').textContent,'正在更新访问范围…');
  assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,1);
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({mode:'full-access',revision:1,modelMessage:'需要加载宿主 0.8.0。'})});
  assertCurrentScope(ui,'full-access');assert.equal(ui.get('model-access-options').getAttribute('aria-busy'),'false');assert.match(ui.get('model-access-status').textContent,/0\.8\.0/);
  assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  assert.doesNotMatch(ui.get('model-access-status').textContent,/权限未修改/);
  assert.equal(ui.get('model-permission-select').value,'rollback');
});

test('canonical conversation busy is merged before any combined snapshot publishes a draft checkpoint',async t=>{
  const ui=await setup(t),state={workspace:{kind:'model',supportsModelContext:true},ready:true,busy:false,directCommandsAvailable:true,commandsReady:true,historyAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}};
  ui.emit('state',state);await choose(ui,'full-access');
  const before=ui.views.length,savedSession=session();savedSession.conversation.persistence={status:'saved'};
  ui.emit('conversation',{workspace:state.workspace,state:{...state,busy:true},busy:false,session:savedSession,accessPolicy:policy(),modelPermission:permission()});
  await flush();
  assert.equal(ui.get('model-access-confirm').hidden,false,'a history-write busy flag must not invalidate the idle conversation review');
  assert.equal(posts(ui).length,0);assertCurrentScope(ui,'read-only');
  assert.match(ui.get('model-access-status').textContent,/待确认完全访问/);
  const published=ui.views.slice(before);assert.ok(published.length>0);
  assert.equal(published.some(view=>view.busy===true||view.blocked===true),false,'no transient busy projection may escape the combined idle payload');
});

test('canonical active work and changed connection identity still invalidate a scope review without a POST',async t=>{
  for(const reason of ['active-work','connection-changed']){
    const ui=await setup(t),state={workspace:{kind:'model',supportsModelContext:true},ready:true,busy:false,directCommandsAvailable:true,commandsReady:true,historyAvailable:true,connectionGeneration:1,codexAccount:{accountRevision:1}};
    ui.emit('state',state);await choose(ui,'full-access');assert.equal(ui.get('model-access-confirm').hidden,false);
    ui.emit('conversation',{workspace:state.workspace,state:{...state,...reason==='connection-changed'?{connectionGeneration:2}:{},busy:false},busy:reason==='active-work',session:session(),accessPolicy:policy(),modelPermission:permission()});
    await flush();assert.equal(ui.get('model-access-confirm').hidden,true,reason);
    assert.match(ui.get('model-access-status').textContent,/状态已变化，权限未修改，请重新选择/,reason);
    assertCurrentScope(ui,'read-only');ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0,reason);
  }
});

test('scope review scrolls and focuses the neutral card without selecting an authorization button',async t=>{
  const ui=await setup(t),card=ui.get('model-access-confirm'),apply=ui.get('model-access-confirm-apply'),scrolled=[];
  card.scrollIntoView=options=>scrolled.push(options);
  card.focus=()=>{ui.document.activeElement=card;};
  apply.focus=()=>{ui.document.activeElement=apply;};
  await choose(ui,'full-access');
  assert.equal(card.tagName,'SECTION');assert.equal(card.tabIndex,-1);assert.equal(ui.document.activeElement,card);
  assert.deepEqual(scrolled,[{block:'nearest'}]);assert.equal(posts(ui).length,0);
  card.dispatchEvent(new UiEvent('keydown',{key:'Enter'}));await flush();
  assert.equal(ui.document.activeElement,card);assert.equal(posts(ui).length,0);assertCurrentScope(ui,'read-only');
});

test('project write selects a library root and submits its ID only after reviewing the exact directory',async t=>{
  const ui=await setup(t);await choose(ui,'project-write');assert.equal(ui.document.body.dataset.modelView,'knowledge');assert.equal(posts(ui).length,0);
  await ui.intent('buildx-access-project-request',{rootId:'trusted-directory',path:'D:\\项目\\工作区',label:'工作区'});
  assert.equal(ui.document.body.dataset.modelView,'chat');assert.match(ui.get('model-access-confirm').textContent,/D:\\项目\\工作区/);assert.equal(posts(ui).length,0);
  assertCurrentScope(ui,'read-only');assert.match(ui.get('model-access-status').textContent,/当前仍为只读，待确认项目读写/);
  assert.match(ui.get('model-access-status').textContent,/确认卡点击“授权此工作区”/);
  ui.get('model-access-confirm-apply').click();await flush();
  assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'project-write',confirmed:true,expectedRevision:0,rootId:'trusted-directory'});
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({revision:1,mode:'project-write',roots:[{path:'D:\\项目\\工作区'}],modelWritable:true})});
  assertCurrentScope(ui,'project-write');assert.match(ui.get('model-access-status').textContent,/当前模型可编辑/);
  assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
});

test('stale scope reviews clear their hint and cannot authorize after policy or context replacement',async t=>{
  const ui=await setup(t,policy({mode:'full-access',revision:3}));
  await ui.intent('buildx-access-project-request',{rootId:'trusted-directory',path:'D:\\项目\\工作区'});
  assert.equal(posts(ui).length,0);assertCurrentScope(ui,'full-access');
  assert.match(ui.get('model-access-status').textContent,/当前仍为完全访问，待确认项目读写/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({revision:4}),modelPermission:permission()});
  assert.equal(ui.get('model-access-confirm').hidden,true);assertCurrentScope(ui,'read-only');
  assert.match(ui.get('model-access-status').textContent,/文件与模型只读/);assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  assert.match(ui.get('model-access-status').textContent,/状态已变化，权限未修改，请重新选择/);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0);
  await choose(ui,'full-access');ui.emit('state',{busy:true});
  assert.equal(ui.get('model-access-confirm').hidden,true);assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  assert.match(ui.get('model-access-status').textContent,/状态已变化，权限未修改，请重新选择/);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0);
  ui.emit('state',{busy:false});await choose(ui,'full-access');
  ui.emit('conversation',{busy:false,session:{...session(),contextEpoch:1},accessPolicy:policy({revision:4}),modelPermission:permission()});
  assert.equal(ui.get('model-access-confirm').hidden,true);assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  assert.match(ui.get('model-access-status').textContent,/状态已变化，权限未修改，请重新选择/);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0);
});

test('an open range review and a late accepted response cannot cross conversations or accounts',async t=>{
  const ui=await setup(t);await choose(ui,'full-access');ui.conversation('chat-b');assert.equal(ui.get('model-access-confirm').hidden,true);
  assert.doesNotMatch(ui.get('model-access-status').textContent,/待确认/);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy(),modelPermission:permission()});await choose(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();const first=posts(ui)[0];
  ui.conversation('chat-b');await ui.respond(first,{ok:true,accessPolicy:policy({mode:'full-access',revision:1})});assertCurrentScope(ui,null);assert.equal(scopeButton(ui,'full-access').disabled,true);
  ui.emit('conversation',{busy:false,session:session('chat-b'),accessPolicy:policy()});await choose(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();const second=posts(ui)[1];
  await ui.close();await ui.respond(second,{ok:true,accessPolicy:policy({mode:'full-access',revision:1})});assertCurrentScope(ui,null);assert.equal(scopeButton(ui,'full-access').disabled,true);
});

test('policy downgrade and state corruption do not reuse or invent prior write scopes',async t=>{
  const ui=await setup(t,policy({mode:'full-access',revision:3,modelWritable:true}));await choose(ui,'read-only');
  assert.equal(ui.get('model-access-confirm').hidden,true);assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'read-only',confirmed:true,expectedRevision:3});
  assertCurrentScope(ui,'full-access');assert.equal(posts(ui).length,1);
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({revision:4})});assertCurrentScope(ui,'read-only');
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({revision:4,mode:'full-access'})});assertCurrentScope(ui,null);assert.match(ui.get('model-access-status').textContent,/不一致/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({revision:5,mode:'project-write',roots:[{path:'D:\\bad\npath'}]})});assert.equal(scopeButton(ui,'full-access').disabled,true);
});

test('full access covers only the explicit script and command set while confirm-mode commit still requires review',async t=>{
  for(const [tool,effect,level,requires] of [
    ['revit_execute_csharp','script_or_command','automatic',false],
    ['revit_run_command','script_or_command','automatic',false],
    ['revit_save_command','local_file','automatic',false],
    ['revit_execute_csharp','script_or_command','confirm',true],
    ['revit_family_load_job','family','automatic',true],
    ['revit_smart_annotate','other_effects','automatic',true]
  ]){
    const ui=await setup(t,policy({mode:'full-access',revision:1,modelWritable:true}));
    const command={id:tool,tool,label:'测试操作',description:'测试',group:'测试',readOnly:false,enabled:true,effectKind:effect,inputSchema:{type:'object',properties:{mode:{type:'string',enum:['rollback','commit'],default:'rollback'}},required:[]}};
    ui.emit('state',{ready:true,commandsReady:true,directCommandsAvailable:true,commandCatalog:[command]});
    ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({mode:'full-access',revision:1,modelWritable:true}),modelPermission:permission({level,revision:2})});await flush();
    const mode=ui.get('model-command-'+tool+'-mode'),row=ui.document.body.querySelectorAll('.model-command-item')[0];mode.value='commit';mode.dispatchEvent(new UiEvent('change'));
    assert.equal(row.querySelectorAll('.model-command-confirm')[0].hidden,!requires,tool+' '+level);
  }
});
