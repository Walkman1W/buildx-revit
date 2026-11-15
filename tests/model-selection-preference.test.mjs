import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputUi,flush} from '../test-support/model-input-ui-fixture.mjs';

const key='buildx-model-preference-v1';
const models=()=>[
  {model:'a',displayName:'A',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'fast'},{reasoningEffort:'medium',description:'balanced'}]},
  {model:'b',displayName:'B',isDefault:false,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high',description:'deep'},{reasoningEffort:'max',description:'deeper'}]},
];
const stored=(model='b',effort='max')=>JSON.stringify({version:1,model,effort});
function storage(initial){const data=new Map(initial===undefined?[]:[[key,initial]]),writes=[];return {getItem:name=>data.get(name)??null,setItem:(name,value)=>{data.set(name,value);writes.push({name,value});},writes};}
const state=(generation=1,revision=0)=>({workspace:{kind:'model',supportsModelContext:true},ready:true,modelSelectionAvailable:true,connectionGeneration:generation,codexAccount:{accountRevision:revision}});
const modelRequests=ui=>ui.requests.filter(item=>item.url==='/api/models');
async function setup(t,{localStorage=storage(),catalog=models(),generation=1,revision=0}={}){
  const ui=await createInputUi({localStorage});t.after(()=>ui.close());const views=[];
  ui.window.addEventListener('buildx-model-picker-view',event=>views.push(event.detail));
  ui.emit('state',state(generation,revision));await flush();const request=modelRequests(ui).at(-1);assert.ok(request,'fresh catalog required before restoring a preference');
  await ui.respond(request,{ok:true,models:catalog});return {...ui,picker:()=>views.at(-1),storage:localStorage};
}
async function choose(ui,model,effort){if(model!==undefined)await ui.intent('buildx-model-picker-select',{model});if(effort!==undefined)await ui.intent('buildx-model-effort-select',{effort});}
async function refresh(ui,catalog=models()){await ui.intent('buildx-model-picker-refresh');const request=modelRequests(ui).at(-1);await ui.respond(request,{ok:true,models:catalog});}

test('an explicit model and effort choice is restored after a page reload with a fresh catalog',async t=>{
  const shared=storage(),first=await setup(t,{localStorage:shared});assert.equal(first.picker().selected,'a');assert.equal(shared.writes.length,0,'loading a default is not a user preference write');
  await choose(first,'b','max');assert.equal(first.picker().selectedEffort,'max');assert.deepEqual(JSON.parse(shared.getItem(key)),{version:1,model:'b',effort:'max'});
  const reopened=await setup(t,{localStorage:shared});assert.equal(reopened.picker().selected,'b');assert.equal(reopened.picker().selectedEffort,'max');
  reopened.input('使用上次模型设置');await reopened.submit();const turn=reopened.requests.find(item=>item.url==='/api/turn');assert.ok(turn);assert.equal(turn.body.model,'b');assert.equal(turn.body.effort,'max');await reopened.respond(turn);reopened.emit('done',{});
});

test('refreshing a catalog, selecting the same model and switching conversations keep the selected pair',async t=>{
  const ui=await setup(t);await choose(ui,'b','max');await choose(ui,'b');assert.equal(ui.picker().selectedEffort,'max');
  await refresh(ui);assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,'max');
  ui.conversation('chat-b');await flush();assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,'max');
  assert.equal(ui.view().activeId,'chat-b');ui.input('新对话沿用设置');await ui.submit();const turn=ui.requests.find(item=>item.url==='/api/turn');assert.equal(turn.body.model,'b');assert.equal(turn.body.effort,'max');await ui.respond(turn);ui.emit('done',{});
});

test('connection identity changes revalidate the remembered choice before it can be sent',async t=>{
  const ui=await setup(t,{localStorage:storage(stored())});ui.emit('state',state(2,1));await flush();assert.equal(ui.picker().selected,'');
  ui.input('等待重新核实目录');await ui.submit();assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);
  await ui.respond(modelRequests(ui).at(-1),{ok:true,models:models()});assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,'max');
});

test('an unsupported remembered effort uses only an advertised valid default, otherwise requires a choice',async t=>{
  for(const validDefault of [true,false]){
    const catalog=models();catalog[1].supportedReasoningEfforts=[{reasoningEffort:'high',description:'supported'}];catalog[1].defaultReasoningEffort=validDefault?'high':null;
    const ui=await setup(t,{localStorage:storage(stored()),catalog});assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,validDefault?'high':'');
    ui.input('检查当前可用强度');await ui.submit();const turn=ui.requests.find(item=>item.url==='/api/turn');if(validDefault){assert.equal(turn.body.effort,'high');await ui.respond(turn);ui.emit('done',{});}else{assert.equal(turn,undefined);assert.equal(ui.get('send').disabled,true);}
  }
});

test('a missing remembered model falls back visibly without overwriting the original preference',async t=>{
  const shared=storage(stored()),ui=await setup(t,{localStorage:shared,catalog:models().slice(0,1)});assert.equal(ui.picker().selected,'a');assert.ok(ui.picker().error);assert.equal(shared.getItem(key),stored());assert.equal(shared.writes.length,0);
  await refresh(ui);assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,'max');
});

test('malformed or inaccessible local storage cannot break the selector or inject an unavailable choice',async t=>{
  for(const value of ['{broken',stored('x'.repeat(201),'max'),stored('b','x'.repeat(81)),JSON.stringify({version:2,model:'b',effort:'max'}),' '.repeat(5000)]){
    const ui=await setup(t,{localStorage:storage(value)});assert.equal(ui.picker().selected,'a');assert.equal(ui.picker().selectedEffort,'medium');
  }
  const unavailable={getItem(){throw new Error('storage denied');},setItem(){throw new Error('storage denied');}},ui=await setup(t,{localStorage:unavailable});
  await choose(ui,'b','max');await refresh(ui);assert.equal(ui.picker().selected,'b');assert.equal(ui.picker().selectedEffort,'max');
});

test('a saved choice cannot bypass malformed effort metadata in the current catalog',async t=>{
  const catalog=models();catalog[1].supportedReasoningEfforts=[{reasoningEffort:'max',description:'x'.repeat(2001)}];
  const ui=await setup(t,{localStorage:storage(stored()),catalog});assert.equal(ui.picker().effortInvalid,true);ui.input('不能使用未核实设置');await ui.submit();assert.equal(ui.requests.some(item=>item.url==='/api/turn'),false);assert.equal(ui.get('send').disabled,true);
});
