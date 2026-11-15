import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeParameterWriteProducer} from '../test-support/native-parameter-write-producer.mjs';
const state=v=>({storage_type:'String',has_value:true,value_internal:v,data_type:'text'});
const change=(id,before,value)=>({element_id:'11',parameter_id:String(id),expected_state:state(before),value});
const make=()=>({operation:'populate_titleblock',elements:[{id:10,kind:'sheet'},{id:11,kind:'block',ownerViewId:10,categoryId:-2000280,parameters:[{id:12,storage:'String',value:'a'},{id:13,storage:'String',value:'b'}]}],args:{expected_document:'D:\\controlled\\parameter-write.rvt',mode:'commit',sheet_id:'10',titleblock_id:'11',changes:[change(12,'a','A'),change(13,'b','B')]}});
test('actual title block producer validates full batch and retains transaction guarantees',async t=>{
 const run=await loadNativeParameterWriteProducer(t);
 let f=make(),r=await run(f);assert.equal(r.ok,true,JSON.stringify(r.error));assert.equal(r.transactions.SetAttempts,2);assert.equal(r.result.value.results.length,2);assert.deepEqual(r.after.parameters.map(p=>p.value),['A','B']);
 f=make();f.args.changes[1].expected_state.value_internal='stale';r=await run(f);assert.equal(r.ok,false);assert.equal(r.transactions.SetAttempts,0);assert.deepEqual(r.after.parameters.map(p=>p.value),['a','b']);
 f=make();f.elements[1].parameters[1].behavior='throws';r=await run(f);assert.equal(r.ok,false);assert.equal(r.transactions.SetAttempts,2);assert.deepEqual(r.after.parameters.map(p=>p.value),['a','b']);assert.equal(r.transactions.GroupRollbacks,1);
 f=make();f.elements.push({id:14,kind:'block',ownerViewId:10,categoryId:-2000280});r=await run(f);assert.equal(r.ok,false);assert.equal(r.transactions.SetAttempts,0);
 f=make();f.elements[1].parameters[0].owner='type';r=await run(f);assert.equal(r.ok,false);assert.equal(r.transactions.SetAttempts,0);
 f=make();f.commitBehavior='drift';r=await run(f);assert.equal(r.ok,false);assert.equal(r.transactions.GroupRollbacks,1);assert.deepEqual(r.after.parameters.map(p=>p.value),['a','b']);
});
