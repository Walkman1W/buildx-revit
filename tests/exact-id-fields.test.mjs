import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandField,isExactIdRule,parseExactIdValue,COMMAND_PARAMETER_LABELS} from '../public/command-fields.mjs';
import {modelSchemaParameters} from '../public/model-workspace.mjs';
import {MODEL_COMMAND_CATALOG} from '../lib/model-command-catalog.mjs';
import {NATIVE_PARAMETER_QUERY_TOOLS,assertNativeParameterQueryArguments} from '../lib/native-parameter-queries.mjs';
import {createInputUi,session,flush} from '../test-support/model-input-ui-fixture.mjs';

const name='revit_get_parameter_value',sourceId='9007199254740993',parameterId='-9223372036854775808';
const tool=NATIVE_PARAMETER_QUERY_TOOLS.find(item=>item.name===name),command=MODEL_COMMAND_CATALOG.find(item=>item.id===name);
const elementRule=tool.inputSchema.properties.element_id,parameterRule=tool.inputSchema.properties.parameter_id;
class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.events=new Map();this.value='';this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(type,fn){const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list);}
  setAttribute(){}
}
const field=(key,rule,value)=>createCommandField({document:{createElement:tag=>new Node(tag)},id:'exact-'+key,key,rule,value});

test('only the published canonical decimal-ID union selects an ordinary exact-ID control',()=>{
  assert.equal(isExactIdRule(elementRule),true);assert.equal(isExactIdRule(parameterRule),true);
  for(const rule of [{type:'integer'},{type:'string'},{anyOf:[{type:'number'},{type:'string',pattern:'^[1-9]\\d{0,18}$'}]},
    {anyOf:[{type:'integer'},{type:'string',pattern:'^.+$'}]},{oneOf:[{type:'integer'},{type:'string'}]}])assert.equal(isExactIdRule(rule),false);
  const control=field('element_id',elementRule,sourceId);
  assert.equal(control.input.tagName,'INPUT');assert.equal(control.input.type,'text');assert.equal(control.input.value,sourceId);
  assert.equal(control.element.children.some(node=>node.textContent==='高级输入（JSON）'),false);
  assert.equal(field('parameter_id',parameterRule,parameterId).element.children[0].textContent,'参数 ID');
  assert.equal(COMMAND_PARAMETER_LABELS.parameter_name,'参数名称');
});

test('safe decimal IDs may become numbers while larger IDs preserve every original digit',()=>{
  for(const value of ['1','123',String(Number.MAX_SAFE_INTEGER)])assert.equal(parseExactIdValue(elementRule,value),Number(value));
  assert.equal(parseExactIdValue(elementRule,123),123);
  for(const value of [sourceId,'9223372036854775807'])assert.equal(parseExactIdValue(elementRule,value),value);
  assert.equal(parseExactIdValue(parameterRule,'-123'),-123);
  assert.equal(parseExactIdValue(parameterRule,parameterId),parameterId);
  for(const value of [Number.MAX_SAFE_INTEGER+1,1.5,null,true,{},[],1n])assert.throws(()=>parseExactIdValue(elementRule,value));
});

test('canonical rules and published forbidden IDs reject lossy, quoted or alternative numeric syntax',()=>{
  for(const value of ['01','1.0','1e3','+1',' 1','1 ','"1"',JSON.stringify(sourceId),'0','-1',''])assert.throws(()=>parseExactIdValue(elementRule,value),undefined,value);
  for(const value of [0,-0,-1,'0','-0','-1','-01','-1.0',JSON.stringify(parameterId)])assert.throws(()=>parseExactIdValue(parameterRule,value),undefined,String(value));
  assert.equal(parseExactIdValue(parameterRule,'-2'),-2);
});

test('actual browser parsing crosses the actual Node single-parameter argument owner without precision loss',()=>{
  const parsed=modelSchemaParameters(command,{element_id:sourceId,parameter_id:parameterId,parameter_name:''});
  assert.equal(parsed.ok,true);assert.deepEqual(parsed.parameters,{element_id:sourceId,parameter_id:parameterId});
  assert.deepEqual(assertNativeParameterQueryArguments(name,parsed.parameters),parsed.parameters);
  const safe=modelSchemaParameters(command,{element_id:'12',parameter_id:'-123'});
  assert.deepEqual(safe,{ok:true,parameters:{element_id:12,parameter_id:-123}});
  assert.deepEqual(assertNativeParameterQueryArguments(name,safe.parameters),safe.parameters);
  assert.equal(modelSchemaParameters(command,{element_id:JSON.stringify(sourceId),parameter_id:'-123'}).ok,false);
});

test('selector XOR rejects zero or two choices while exact names retain spaces, case and Unicode',()=>{
  for(const values of [{element_id:sourceId},{element_id:sourceId,parameter_id:'',parameter_name:''},
    {element_id:sourceId,parameter_id:'-123',parameter_name:' Width '}]){
    const parsed=modelSchemaParameters(command,values);assert.equal(parsed.ok,false);assert.match(parsed.error,/二选一/);
  }
  for(const parameter_name of [' Width ','宽度',' WIDTH ',' ']){
    const parsed=modelSchemaParameters(command,{element_id:sourceId,parameter_id:'',parameter_name});
    assert.equal(parsed.ok,true);assert.equal(parsed.parameters.parameter_name,parameter_name);
    assert.deepEqual(assertNativeParameterQueryArguments(name,parsed.parameters),parsed.parameters);
  }
});

test('ordinary numeric fields and unrelated structured JSON retain their original controls and parsing',()=>{
  const numeric=field('limit',{type:'integer',minimum:1,maximum:200},12);
  assert.equal(numeric.input.type,'number');assert.equal(numeric.input.step,'1');assert.equal(numeric.input.value,'12');
  const structured=field('custom',{type:'object',properties:{value:{type:'string'}}},'{"value":"a"}');
  assert.equal(structured.input.tagName,'TEXTAREA');assert.equal(structured.input.value,'{"value":"a"}');
  const legacy={inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:200},height_mm:{type:'number'},custom:{type:'object'}}}};
  assert.deepEqual(modelSchemaParameters(legacy,{limit:'12',height_mm:'1.25',custom:'{"value":"a"}'}),
    {ok:true,parameters:{limit:12,height_mm:1.25,custom:{value:'a'}}});
  assert.equal(modelSchemaParameters(legacy,{limit:sourceId}).ok,false);
});

test('the light DOM shows both selectors in the primary form and submits their exact native values',async t=>{
  const ui=await createInputUi();t.after(()=>ui.close());
  ui.emit('state',{workspace:{kind:'model',supportsModelContext:true},ready:false,commandsReady:true,commandReadiness:'local',
    directCommandsAvailable:true,commandCatalog:MODEL_COMMAND_CATALOG,historyAvailable:true,account:{required:false},
    connectionGeneration:1,codexAccount:{accountRevision:1,status:'unavailable'}});
  ui.emit('conversation',{busy:false,session:session()});await flush();
  const item=ui.document.body.querySelectorAll('.model-command-item').find(node=>node.dataset.commandId===name);
  assert.ok(item);item.querySelectorAll('.model-command-apply')[0].click();
  const parameters=ui.get('model-parameters-'+name),element=ui.get('model-command-'+name+'-element_id'),
    id=ui.get('model-command-'+name+'-parameter_id'),parameterName=ui.get('model-command-'+name+'-parameter_name');
  assert.equal(parameters.hidden,false);assert.equal(element.tagName,'INPUT');assert.equal(id.tagName,'INPUT');
  assert.equal(element.type,'text');assert.equal(id.type,'text');assert.equal(parameterName.type,'text');
  assert.ok(parameters.children.some(node=>node.contains(id)));assert.ok(parameters.children.some(node=>node.contains(parameterName)));
  for(const advanced of parameters.querySelectorAll('.model-command-advanced')){
    assert.equal(advanced.contains(id),false);assert.equal(advanced.contains(parameterName),false);
  }
  assert.match(parameters.textContent,/参数 ID或参数名称，二选一/);
  const run=item.querySelectorAll('.model-command-run')[0];element.value=sourceId;
  run.click();await flush();assert.equal(ui.requests.length,0);
  id.value='-123';parameterName.value=' Width ';run.click();await flush();assert.equal(ui.requests.length,0);
  id.value='';run.click();await flush();assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].url,'/api/command');
  assert.deepEqual(ui.requests[0].body.parameters,{element_id:sourceId,parameter_name:' Width '});
  assert.deepEqual(assertNativeParameterQueryArguments(name,ui.requests[0].body.parameters),ui.requests[0].body.parameters);
  await ui.respond(ui.requests[0],{ok:true,executionId:'exact-id-read'});
});
