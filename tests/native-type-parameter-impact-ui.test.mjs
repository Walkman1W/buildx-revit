import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCommandPresentation} from '../public/model-workspace.mjs';
import {NATIVE_MODEL_QUERY_RESULT_SCHEMAS} from '../lib/native-model-queries.mjs';
import {MODEL_COMMAND_CATALOG} from '../lib/model-command-catalog.mjs';
import {createInputUi,session,flush} from '../test-support/model-input-ui-fixture.mjs';

const name='revit_get_type_parameter_impact',typeId='9007199254740993',parameterId='-9223372036854775808';
const source={hostSession:'impact-fixture-host',document:{title:'类型影响核查样例',path:'D:\\type-impact.rvt'}};
const parameter=(patch={})=>({parameter_id:parameterId,name:'类型备注',storage_type:'String',is_read_only:false,has_value:true,
  data_type:null,unit_type:null,value_internal:' 原始值 ',value_display:'本地显示值',...patch});
const body=(patch={})=>({schema_version:1,type_id:typeId,type_name:'墙类型 A',parameter:parameter(),instance_ids:['9007199254741001'],instance_count:1,
  coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:12,indirect_effects:'not_assessed'},write_authorization:'not_granted',...patch});
const result=(value=body(),patch={})=>({commandId:name,status:'completed',conversationId:'chat-a',executionId:'impact-1',
  result:{...source,requestIds:['original-impact-request'],data:{operation:'get_type_parameter_impact',value}},...patch});
const rows=value=>Object.fromEntries(modelCommandPresentation(result(value)).rows);
const parameterSchema=NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters.properties.parameters.items.properties.parameter_id;
const command={id:name,tool:name,label:'类型参数影响核查',description:'只读核查当前文档直接类型引用',group:'模型查询',readOnly:true,enabled:true,
  inputSchema:{type:'object',properties:{type_id:NATIVE_MODEL_QUERY_RESULT_SCHEMAS.revit_get_element_parameters.properties.element_id,
    parameter_id:{...parameterSchema,not:{enum:[0,-1,'0','-1']}}},required:['type_id','parameter_id'],additionalProperties:false}};

test('the actual result presenter names the exact type and parameter and states the measured impact boundary',()=>{
  const value=body(),before=structuredClone(value),view=modelCommandPresentation(result(value)),facts=Object.fromEntries(view.rows);
  assert.equal(view.document,source.document.title);assert.deepEqual(view.columns,['项目','内容']);
  assert.equal(facts['类型名称'],'墙类型 A');assert.equal(facts['类型 ID'],typeId);assert.equal(facts['参数 ID'],parameterId);
  assert.equal(facts['参数名称'],'类型备注');assert.equal(facts['存储类型'],'String');assert.equal(facts['原始内部值'],' 原始值 ');
  assert.equal(facts['显示值'],'本地显示值');assert.equal(facts['是否有值（HasValue）'],'是（true）');assert.equal(facts['直接实例数'],'1');
  assert.match(facts['核查范围'],/当前文档.*直接引用/);assert.equal(facts['间接影响'],'未评估');
  assert.equal(facts['写入授权'],'本次核查不额外授予类型写入权限');assert.match(view.summary,/间接影响未评估/);
  assert.deepEqual(value,before);
});

test('HasValue false, null, empty text, zero and unknown metadata remain distinct observations',()=>{
  const unset=rows(body({type_name:null,parameter:parameter({has_value:false,value_internal:null,value_display:null})}));
  assert.equal(unset['是否有值（HasValue）'],'否（false）');assert.equal(unset['原始内部值'],'null');assert.equal(unset['显示值'],'null');
  assert.equal(unset['类型名称'],'未知（null）');assert.equal(unset['数据类型'],'未知（null）');
  const empty=rows(body({parameter:parameter({value_internal:'',value_display:''})}));
  assert.equal(empty['是否有值（HasValue）'],'是（true）');assert.equal(empty['原始内部值'],'空字符串（""）');
  const zero=rows(body({parameter:parameter({storage_type:'Integer',value_internal:0,value_display:'0',data_type:''})}));
  assert.equal(zero['原始内部值'],'0');assert.equal(zero['数据类型'],'空字符串（""）');
  assert.equal(rows(body({parameter:parameter({value_internal:null})}))['是否有值（HasValue）'],'是（true）');
});

test('zero references is a valid completed read and not a missing result or a write authorization',()=>{
  const view=modelCommandPresentation(result(body({instance_count:0,instance_ids:[],coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:0,indirect_effects:'not_assessed'}})));
  const facts=Object.fromEntries(view.rows);assert.equal(view.status,'已完成');assert.equal(view.error,'');
  assert.equal(facts['直接实例数'],'0');assert.equal(facts['实例 ID'],'显示 0 / 0 个（无直接实例）');
  assert.match(view.summary,/直接实例 0 个/);assert.doesNotMatch(view.summary,/没有匹配/);
});

test('a bounded first-50 display keeps exact IDs and labels its partial UI coverage',()=>{
  const instance_ids=Array.from({length:500},(_,index)=>(9007199254741000n+BigInt(index)).toString());
  const view=modelCommandPresentation(result(body({instance_ids,instance_count:500,coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:1200,indirect_effects:'not_assessed'}})));
  const facts=Object.fromEntries(view.rows);assert.equal(facts['直接实例数'],'500');assert.match(view.summary,/显示 50 \/ 500/);
  assert.ok(facts['实例 ID'].includes(instance_ids[0]));assert.ok(facts['实例 ID'].includes(instance_ids[49]));
  assert.equal(facts['实例 ID'].includes(instance_ids[50]),false);assert.equal(facts['实例 ID'].includes(instance_ids[499]),false);
  assert.equal(facts['扫描元素数'],'1200');assert.doesNotMatch(view.summary,/全部影响/);
});

test('incomplete, inconsistent or unauthorized-looking receipts cannot produce a complete impact table',()=>{
  for(const patch of [{schema_version:2},{instance_count:2},{instance_ids:[9007199254740992]},
    {write_authorization:'granted'}, {coverage:{complete:false,scope:'current_document_direct_type_references',scanned_elements:12,indirect_effects:'not_assessed'}},
    {coverage:{complete:true,scope:'all_effects',scanned_elements:12,indirect_effects:'not_assessed'}},
    {coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:20001,indirect_effects:'not_assessed'}}]){
    const view=modelCommandPresentation(result(body(patch)));assert.equal(view.status,'结果待核对');assert.deepEqual(view.rows,[]);assert.match(view.error,/核对原回执/);
  }
  for(const status of ['unknown','failed','interrupted','running'])assert.deepEqual(modelCommandPresentation(result(body(),{status})).rows,[]);
});

test('an impossible scan count cannot be presented as a complete impact result',()=>{
  const value=body({coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:0,indirect_effects:'not_assessed'}});
  const view=modelCommandPresentation(result(value));assert.equal(view.status,'结果待核对');assert.deepEqual(view.rows,[]);
});

async function uiFixture(t){
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:true,commandsReady:true,commandReadiness:'local',
    directCommandsAvailable:true,commandCatalog:[command],historyAvailable:true,account:{required:false},connectionGeneration:1,codexAccount:{accountRevision:1}});
  ui.emit('conversation',{busy:false,session:session(),modelPermission:{available:true,level:'automatic',revision:1,conversationId:'chat-a',documentLabel:source.document.title,expiresAt:null}});
  await flush();return ui;
}

test('the light DOM uses native ID inputs and offers only a read query even under automatic execution',async t=>{
  const ui=await uiFixture(t),item=ui.document.body.querySelectorAll('.model-command-item').find(node=>node.dataset.commandId===name);assert.ok(item);
  const type=ui.get('model-command-'+name+'-type_id'),parameter=ui.get('model-command-'+name+'-parameter_id');
  assert.equal(type.type,'text');assert.equal(parameter.type,'text');assert.equal(type.parent.textContent.startsWith('类型 ID'),true);
  const nodes=node=>[node,...node.children.flatMap(nodes)];
  assert.equal(nodes(item).some(node=>node.tagName==='TEXTAREA'),false);assert.equal(item.querySelectorAll('.parameter-change-field').length,0);
  assert.equal(item.querySelectorAll('.model-command-confirm').length,0);assert.equal(nodes(item).some(node=>node.id==='model-command-'+name+'-mode'),false);
  assert.equal(nodes(item).filter(node=>node.tagName==='BUTTON'&&!node.hidden).some(node=>/应用|执行|commit/.test(node.textContent)),false);
  const run=item.querySelectorAll('.model-command-run')[0];assert.equal(run.textContent,'查询');
  type.value=typeId;parameter.value=parameterId;run.click();await flush();assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].body.commandId,name);assert.deepEqual(ui.requests[0].body.parameters,{type_id:typeId,parameter_id:parameterId});
  assert.equal(Object.hasOwn(ui.requests[0].body,'confirmed'),false);assert.equal(Object.hasOwn(ui.requests[0].body.parameters,'mode'),false);
  await ui.respond(ui.requests[0],{ok:true,executionId:'impact-1'});
});

test('type and parameter text is rendered literally without markup execution or JSON editors',async t=>{
  const ui=await uiFixture(t),payload=body({type_name:'<img src=x onerror=type()>',parameter:parameter({name:'<script>parameter()</script>',value_internal:'<b>raw</b>'})});
  ui.emit('conversation',{busy:false,session:session(),command:result(payload)});await flush();
  const item=ui.document.body.querySelectorAll('.model-command-item').find(node=>node.dataset.commandId===name),nodes=node=>[node,...node.children.flatMap(nodes)];
  assert.ok(item.textContent.includes(payload.type_name));assert.ok(item.textContent.includes(payload.parameter.name));assert.ok(item.textContent.includes('<b>raw</b>'));
  assert.equal(nodes(item).some(node=>['SCRIPT','IMG','B','TEXTAREA'].includes(node.tagName)),false);
  assert.match(item.textContent,/本次核查不额外授予类型写入权限/);assert.doesNotMatch(item.textContent,/所有类型.*强制确认/);
  assert.equal(ui.requests.length,0);
  assert.ok(MODEL_COMMAND_CATALOG.some(item=>item.tool==='revit_set_parameters'));
  assert.ok(MODEL_COMMAND_CATALOG.some(item=>item.tool==='revit_execute_csharp'));
});
