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
async function select(ui,mode){const control=ui.get('model-access-select');control.value=mode;control.dispatchEvent(new UiEvent('change'));await flush();}
const posts=ui=>ui.requests.filter(item=>item.url==='/api/access-policy');

test('access scope is a separate server projection and never assumes full or write access',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  assert.equal(ui.get('model-access-select').disabled,true);assert.equal(ui.get('model-access-select').value,'');
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy(),modelPermission:permission()});
  assert.equal(ui.get('model-access-select').value,'read-only');assert.equal(ui.get('model-permission-select').value,'rollback');
  assert.equal(ui.get('model-access-select').getAttribute('aria-label'),'访问权限');assert.equal(ui.get('model-permission-select').getAttribute('aria-label'),'执行方式');
  assert.equal(posts(ui).length,0);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:{available:true,loading:true}});
  assert.equal(ui.get('model-access-select').disabled,true);assert.match(ui.get('model-access-status').textContent,/正在读取/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy()});
  assert.equal(ui.get('model-access-select').disabled,false);
});

test('full access needs explicit range confirmation; cancel never submits and a receipt remains authoritative',async t=>{
  const ui=await setup(t);await select(ui,'full-access');
  assert.equal(posts(ui).length,0);assert.equal(ui.get('model-access-select').value,'read-only');assert.equal(ui.get('model-access-confirm').hidden,false);
  assert.match(ui.get('model-access-confirm').textContent,/不限于资料库/);
  ui.get('model-access-confirm-cancel').click();await flush();assert.equal(posts(ui).length,0);
  await select(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();
  assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'full-access',confirmed:true,expectedRevision:0});
  assert.equal(ui.get('model-access-select').value,'__pending');assert.equal(ui.get('model-permission-select').disabled,true);
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({mode:'full-access',revision:1,modelMessage:'需要加载宿主 0.8.0。'})});
  assert.equal(ui.get('model-access-select').value,'full-access');assert.match(ui.get('model-access-status').textContent,/0\.8\.0/);
  assert.equal(ui.get('model-permission-select').value,'rollback');
});

test('project write selects a library root and submits its ID only after reviewing the exact directory',async t=>{
  const ui=await setup(t);await select(ui,'project-write');assert.equal(ui.document.body.dataset.modelView,'knowledge');assert.equal(posts(ui).length,0);
  await ui.intent('buildx-access-project-request',{rootId:'trusted-directory',path:'D:\\项目\\工作区',label:'工作区'});
  assert.equal(ui.document.body.dataset.modelView,'chat');assert.match(ui.get('model-access-confirm').textContent,/D:\\项目\\工作区/);assert.equal(posts(ui).length,0);
  ui.get('model-access-confirm-apply').click();await flush();
  assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'project-write',confirmed:true,expectedRevision:0,rootId:'trusted-directory'});
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({revision:1,mode:'project-write',roots:[{path:'D:\\项目\\工作区'}],modelWritable:true})});
  assert.equal(ui.get('model-access-select').value,'project-write');assert.match(ui.get('model-access-status').textContent,/当前模型可编辑/);
});

test('an open range review and a late accepted response cannot cross conversations or accounts',async t=>{
  const ui=await setup(t);await select(ui,'full-access');ui.conversation('chat-b');assert.equal(ui.get('model-access-confirm').hidden,true);
  ui.get('model-access-confirm-apply').click();await flush();assert.equal(posts(ui).length,0);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy(),modelPermission:permission()});await select(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();const first=posts(ui)[0];
  ui.conversation('chat-b');await ui.respond(first,{ok:true,accessPolicy:policy({mode:'full-access',revision:1})});assert.equal(ui.get('model-access-select').value,'');assert.equal(ui.get('model-access-select').disabled,true);
  ui.emit('conversation',{busy:false,session:session('chat-b'),accessPolicy:policy()});await select(ui,'full-access');ui.get('model-access-confirm-apply').click();await flush();const second=posts(ui)[1];
  await ui.close();await ui.respond(second,{ok:true,accessPolicy:policy({mode:'full-access',revision:1})});assert.equal(ui.get('model-access-select').value,'');assert.equal(ui.get('model-access-select').disabled,true);
});

test('policy downgrade and state corruption do not reuse or invent prior write scopes',async t=>{
  const ui=await setup(t,policy({mode:'full-access',revision:3,modelWritable:true}));await select(ui,'read-only');
  assert.equal(ui.get('model-access-confirm').hidden,true);assert.deepEqual(posts(ui)[0].body,{client:'ui-id-1',mode:'read-only',confirmed:true,expectedRevision:3});
  await ui.respond(posts(ui)[0],{ok:true,accessPolicy:policy({revision:4})});assert.equal(ui.get('model-access-select').value,'read-only');
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({revision:4,mode:'full-access'})});assert.equal(ui.get('model-access-select').value,'');assert.match(ui.get('model-access-status').textContent,/不一致/);
  ui.emit('conversation',{busy:false,session:session(),accessPolicy:policy({revision:5,mode:'project-write',roots:[{path:'D:\\bad\npath'}]})});assert.equal(ui.get('model-access-select').disabled,true);
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
