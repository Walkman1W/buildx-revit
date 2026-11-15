import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTypeParameterWriteReview,renderTypeParameterWriteReview} from '../public/type-parameter-write-review.mjs';
import {modelCommandCatalog} from '../public/model-workspace.mjs';
import {assertTypeParameterWriteReview,NATIVE_TYPE_PARAMETER_WRITE_TOOLS} from '../lib/native-type-parameter-writes.mjs';
import {createInputUi,session,flush} from '../test-support/model-input-ui-fixture.mjs';

const tool='revit_set_type_parameter',typeId='9007199254740993',parameterId='-9223372036854775808';
const workspace={kind:'model',supportsModelContext:true};
const review=(patch={})=>({schema_version:1,document:{session:'a'.repeat(32),title:'类型审阅样例',path:'D:\\review.rvt'},
  type_id:typeId,type_name:'墙类型 <示例>',parameter:{parameter_id:parameterId,name:'类型备注 <script>',storage_type:'String',is_read_only:false,
    has_value:false,data_type:null,unit_type:null,value_internal:null,value_display:null},mode:'commit',value:'完整拟议值 <img src=x> & "引号"\n下一行',value_unit:null,
  instance_ids:['9007199254740995'],instance_count:1,scope:'current_document_direct_type_references',indirect_effects:'not_assessed',...patch});
const packet=(body=review(),patch={})=>({id:'type-review-a',digest:'b'.repeat(64),kind:'model',action:tool,target:'类型审阅样例 · D:\\review.rvt',
  cwd:'',source:'所有执行方式均须逐次确认；间接影响未评估。',parameters:'请核对完整类型审阅卡。',typeParameterReview:JSON.stringify(body),
  deadline:Date.now()+30000,conversationId:'chat-a',...patch});
const descendants=node=>[node,...node.children.flatMap(descendants)];
function clock(){
  const live=new Set();
  return {setTimeout(fn,ms){const item={fn,ms};live.add(item);return item;},clearTimeout(item){live.delete(item);},
    expireApproval(){for(const item of [...live])if(item.ms>20000&&item.ms<=30000){live.delete(item);item.fn();}}};
}
async function setup(t,{dynamicImports=true,layout=false}={}){
  const timers=clock(),ui=await createInputUi({dynamicImports,layout,timers});t.after(()=>ui.close());
  ui.emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:1}});
  const show=(value=packet(),extra={})=>ui.emit('conversation',{workspace,busy:true,session:session(),modelPermission:{available:true,level:'automatic',conversationId:'chat-a',expiresAt:null},dynamicApproval:value,...extra});
  const box=ui.get('dynamic-approval'),actions=()=>box.querySelectorAll('.dynamic-approval-actions')[0];
  return {...ui,timers,show,box,actions};
}

test('the actual Node review contract and UI preserve full raw values and exact identities',()=>{
  const body=review({value:'拟'.repeat(8192)}),serialized=JSON.stringify(assertTypeParameterWriteReview(body));
  const parsed=parseTypeParameterWriteReview(serialized);
  assert.equal(parsed.type_id,typeId);assert.equal(parsed.parameter.parameter_id,parameterId);assert.equal(parsed.instance_ids[0],'9007199254740995');
  assert.equal(parsed.value.length,8192);assert.equal(parsed.value,body.value);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.parameter));assert.ok(Object.isFrozen(parsed.instance_ids));
  assert.equal(parseTypeParameterWriteReview(JSON.stringify(review({type_id:42,parameter:{...body.parameter,parameter_id:-123}}))).type_id,42);
});

test('review validation rejects missing, additional, mismatched and unsupported raw facts',()=>{
  const base=review();
  for(const patch of [{schema_version:2},{extra:true},{document:{...base.document,path:''}},{document:{...base.document,session:'x\ny'}},
    {type_id:'9223372036854775808'},{type_id:9007199254740992},{type_id:'042'},{parameter:{...base.parameter,parameter_id:'-1'}},
    {parameter:{...base.parameter,is_read_only:true}},{parameter:{...base.parameter,storage_type:'ElementId'}},
    {parameter:{...base.parameter,has_value:false,value_internal:''}},{parameter:{...base.parameter,value_display:'x'.repeat(8193)}},
    {parameter:{...base.parameter,data_type:'x'.repeat(1025)}},{parameter:{...base.parameter,storage_type:'Integer',has_value:true,value_internal:0},value:2147483648},
    {parameter:{...base.parameter,storage_type:'Double',has_value:true,value_internal:0},value:1,value_unit:null},
    {parameter:{...base.parameter,storage_type:'Double',has_value:true,value_internal:0},value:1e400,value_unit:'internal'},
    {scope:'all_effects'},{indirect_effects:'none'},{mode:'automatic'}])assert.throws(()=>parseTypeParameterWriteReview(JSON.stringify({...base,...patch})));
  const missing=review();delete missing.parameter.has_value;assert.throws(()=>parseTypeParameterWriteReview(JSON.stringify(missing)));
});

test('zero and 500 direct references stay explicit; IDs must be sorted canonical strings distinct from the type',()=>{
  assert.equal(parseTypeParameterWriteReview(JSON.stringify(review({instance_ids:[],instance_count:0}))).instance_count,0);
  const ids=Array.from({length:500},(_,index)=>(BigInt(typeId)+2n+BigInt(index)).toString());
  assert.deepEqual(parseTypeParameterWriteReview(JSON.stringify(review({instance_ids:ids,instance_count:500}))).instance_ids,ids);
  for(const ids of [[42],['042'],[typeId],['43','42'],['42','42'],['9223372036854775808'],Array.from({length:501},(_,index)=>String(index+1))])
    assert.throws(()=>parseTypeParameterWriteReview(JSON.stringify(review({instance_ids:ids,instance_count:ids.length}))));
  assert.throws(()=>parseTypeParameterWriteReview(JSON.stringify(review({instance_count:0}))));
});

test('both serialized character and UTF8 budgets fail closed without truncating review values',()=>{
  assert.throws(()=>parseTypeParameterWriteReview(' '.repeat(60001)));
  const unicode=review({document:{...review().document,path:'D:\\'+'文'.repeat(32760)},value:'x'.repeat(8192)});
  const serialized=JSON.stringify(unicode);assert.ok(serialized.length<60000);assert.ok(Buffer.byteLength(serialized)>100000);
  assert.throws(()=>parseTypeParameterWriteReview(serialized));
  const many=review({document:{...review().document,path:'D:\\'+'x'.repeat(32760)},type_name:'x'.repeat(1024),value:'x'.repeat(8192),
    parameter:{...review().parameter,name:'x'.repeat(1024),data_type:'x'.repeat(1024),unit_type:'x'.repeat(1024),has_value:true,value_internal:'x'.repeat(8192),value_display:'x'.repeat(8192)}});
  assert.ok(JSON.stringify(many).length>60000);assert.throws(()=>parseTypeParameterWriteReview(JSON.stringify(many)));
});

test('the actual renderer uses only text and distinguishes null, empty strings, integer zero and unit-bearing doubles',async t=>{
  const ui=await setup(t);
  for(const [body,before,after] of [[review({instance_ids:[],instance_count:0}),'null（原始值）','字符串：'],
    [review({parameter:{...review().parameter,has_value:true,value_internal:''},value:''}),'空字符串（""）','空字符串（""）'],
    [review({parameter:{...review().parameter,storage_type:'Integer',has_value:true,value_internal:0},value:1}),'0','1'],
    [review({parameter:{...review().parameter,storage_type:'Double',has_value:true,value_internal:0,data_type:'autodesk.spec.aec:length-2.0.0'},value:2,value_unit:'internal',mode:'rollback'}),'0','2']]){
    const card=renderTypeParameterWriteReview(ui.document,parseTypeParameterWriteReview(JSON.stringify(body)));
    const rows=card.children[1].children,facts=Object.fromEntries(rows.filter((_,index)=>index%2===0).map((row,index)=>[row.textContent,rows[index*2+1].textContent]));
    assert.equal(facts['写前原始内部值'],before);assert.ok(facts['拟议原始内部值'].startsWith(after));
    assert.equal(facts['是否有值（HasValue）'],body.parameter.has_value?'是（true）':'否（false）');
    assert.ok(card.textContent.includes(body.parameter.name));assert.ok(card.textContent.includes(body.type_name));
    assert.equal(descendants(card).some(node=>['INPUT','TEXTAREA','SELECT','BUTTON','IMG','SCRIPT'].includes(node.tagName)),false);
    assert.match(card.textContent,/间接影响未评估/);assert.doesNotMatch(card.textContent,/无影响/);
    if(body.mode==='rollback')assert.match(facts['执行方式'],/rollback.*不保留/);
    if(body.value_unit==='internal')assert.match(facts['拟议值单位'],/内部单位.*internal/);
  }
  const ids=Array.from({length:500},(_,index)=>(BigInt(typeId)+2n+BigInt(index)).toString());
  const card=renderTypeParameterWriteReview(ui.document,parseTypeParameterWriteReview(JSON.stringify(review({instance_ids:ids,instance_count:500}))));
  assert.match(card.textContent,/显示 50 \/ 500/);assert.ok(card.textContent.includes(ids[49]));assert.equal(card.textContent.includes(ids[50]),false);
});

test('the actual app shows the full type review in automatic mode and submits only one original decision',async t=>{
  const ui=await setup(t),proposal=packet();ui.show(proposal);
  assert.equal(ui.box.hidden,true);assert.equal(ui.actions(),undefined);assert.equal(ui.requests.length,0);
  await flush();assert.equal(ui.box.hidden,false);assert.equal(ui.requests.length,0);
  assert.match(ui.box.textContent,/请逐项审阅/);assert.ok(ui.box.textContent.includes(typeId));assert.ok(ui.box.textContent.includes(parameterId));
  assert.ok(ui.box.textContent.includes('字符串：'+JSON.stringify(review().value)));assert.match(ui.box.textContent,/D:\\review\.rvt/);
  assert.equal(descendants(ui.box).some(node=>['INPUT','TEXTAREA','SELECT','IMG','SCRIPT'].includes(node.tagName)),false);
  const accept=ui.actions().children[0];accept.click();accept.click();await flush();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].url,'/api/dynamic-approval');
  assert.deepEqual(ui.requests[0].body,{client:'ui-id-1',conversationId:'chat-a',requestId:proposal.id,digest:proposal.digest,decision:'accept'});
  await ui.respond(ui.requests[0],{ok:true,requestId:proposal.id,decision:'accept',status:'submitted'});
  assert.match(ui.box.textContent,/等待模型操作结果/);ui.show(proposal);accept.click();await flush();assert.equal(ui.requests.length,1);
});

test('decline uses the same one-use channel without returning review facts or proposed parameters',async t=>{
  const ui=await setup(t),proposal=packet(review({mode:'rollback'}));ui.show(proposal);await flush();
  ui.actions().children[1].click();await flush();assert.equal(ui.requests.length,1);
  assert.deepEqual(Object.keys(ui.requests[0].body).sort(),['client','conversationId','decision','digest','requestId']);assert.equal(ui.requests[0].body.decision,'decline');
  await ui.respond(ui.requests[0],{ok:true,requestId:proposal.id,decision:'decline',status:'submitted'});
  ui.actions().children[0].click();await flush();assert.equal(ui.requests.length,1);assert.match(ui.box.textContent,/拒绝已提交/);
});

test('missing, forged, malformed and oversized type review packets never fall back to a generic approval',async t=>{
  const ui=await setup(t),badBodies=[{typeParameterReview:undefined},{typeParameterReview:'not JSON'},{typeParameterReview:JSON.stringify({...review(),ack:true})},
    {typeParameterReview:' '.repeat(60001)},{kind:'terminal'},
    {typeParameterReview:JSON.stringify(review({document:{...review().document,path:'D:\\'+'文'.repeat(32760)},value:'x'.repeat(8192)}))}];
  for(let index=0;index<badBodies.length;index++){
    ui.show(packet(review(),{id:'bad-review-'+index,...badBodies[index]}));await flush();assert.equal(ui.box.hidden,true);assert.equal(ui.actions(),undefined);
  }
  assert.equal(ui.requests.length,0);
});

test('changed review, digest or parameters for the same request invalidate the original controls permanently',async t=>{
  for(const patch of [{typeParameterReview:JSON.stringify(review({value:'更改后的值'}))},{digest:'c'.repeat(64)},{parameters:'变更后的参数'}]){
    const ui=await setup(t),proposal=packet();ui.show(proposal);await flush();const accept=ui.actions().children[0];
    ui.show({...proposal,...patch});assert.equal(ui.box.hidden,true);accept.click();await flush();assert.equal(ui.requests.length,0);
    ui.show(proposal);await flush();assert.equal(ui.box.hidden,true);accept.click();await flush();assert.equal(ui.requests.length,0);
  }
});

test('lazy validation cannot revive an owner after conversation, context, connection or account changes',async t=>{
  for(const change of ['conversation','context','connection','account']){
    const ui=await setup(t),proposal=packet();ui.show(proposal);assert.equal(ui.box.hidden,true);
    if(change==='conversation')ui.emit('conversation',{workspace,busy:true,session:session('chat-b'),dynamicApproval:null});
    if(change==='context')ui.emit('conversation',{workspace,busy:true,session:{...session(),contextEpoch:1},dynamicApproval:null});
    if(change==='connection')ui.emit('state',{workspace,ready:true,connectionGeneration:2,codexAccount:{accountRevision:1}});
    if(change==='account')ui.emit('state',{workspace,ready:true,connectionGeneration:1,codexAccount:{accountRevision:2}});
    await flush();assert.equal(ui.box.hidden,true);assert.equal(ui.actions(),undefined);assert.equal(ui.requests.length,0);
  }
});

test('expiration before and after lazy validation prevents approval',async t=>{
  const loading=await setup(t);loading.show(packet());loading.timers.expireApproval();await flush();assert.equal(loading.box.hidden,true);assert.equal(loading.requests.length,0);
  const ui=await setup(t),proposal=packet();ui.show(proposal);await flush();const accept=ui.actions().children[0];ui.timers.expireApproval();
  assert.equal(accept.disabled,true);accept.click();await flush();assert.equal(ui.requests.length,0);assert.match(ui.box.textContent,/超时/);
});

test('a disconnected submission stays unknown even when a late HTTP acceptance arrives',async t=>{
  const ui=await setup(t),proposal=packet();ui.show(proposal);await flush();const accept=ui.actions().children[0];accept.click();await flush();
  ui.emit('state',{workspace,ready:false,connectionGeneration:2,codexAccount:{accountRevision:1}});await flush();assert.match(ui.box.textContent,/尚未核对/);
  await ui.respond(ui.requests[0],{ok:true,requestId:proposal.id,decision:'accept',status:'submitted'});assert.match(ui.box.textContent,/尚未核对/);
  accept.click();await flush();assert.equal(ui.requests.length,1);
});

test('failure to load the literal review helper leaves the actual app unable to approve',async t=>{
  const ui=await setup(t,{dynamicImports:false});ui.show(packet());await flush();assert.equal(ui.box.hidden,true);assert.equal(ui.actions(),undefined);assert.equal(ui.requests.length,0);
});

test('the actual manual command row is informational while existing read controls remain available',async t=>{
  const ui=await setup(t,{layout:true}),contract=NATIVE_TYPE_PARAMETER_WRITE_TOOLS[0];
  const catalog=[{id:tool,tool,label:'修改类型参数',description:'需要本次类型审阅',readOnly:false,enabled:true,manualExecution:false,
    manualUnavailableReason:'请在对话中发起，逐次审阅类型影响并确认。',inputSchema:contract.inputSchema},
    {id:'revit_get_type_parameter_impact',tool:'revit_get_type_parameter_impact',label:'类型参数影响核查',description:'只读',readOnly:true,enabled:true,
      inputSchema:{type:'object',properties:{type_id:{type:'integer',minimum:1}},required:['type_id']}}];
  const projected=modelCommandCatalog(catalog);assert.equal(projected[0].enabled,true);assert.equal(projected[0].manualExecution,false);assert.equal(projected[1].manualExecution,true);
  ui.emit('state',{workspace,ready:true,commandsReady:true,commandReadiness:'local',directCommandsAvailable:true,commandCatalog:catalog,historyAvailable:true,
    account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{workspace,busy:false,session:session()});await flush();
  const rows=ui.document.body.querySelectorAll('.model-command-item'),row=rows.find(item=>item.dataset.commandId===tool);assert.ok(row);
  assert.match(row.textContent,/对话中发起.*逐次审阅/);assert.equal(descendants(row).some(node=>['INPUT','TEXTAREA','SELECT','BUTTON'].includes(node.tagName)),false);
  const read=rows.find(item=>item.dataset.commandId==='revit_get_type_parameter_impact');assert.ok(read.querySelectorAll('.model-command-run').length);
  await ui.intent('buildx-model-command',{commandId:tool,parameters:{},confirmed:true});assert.equal(ui.requests.length,0);
});
