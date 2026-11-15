import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeParameterWriteProducer} from '../test-support/native-parameter-write-producer.mjs';
const fixture=({mode='commit',parameter={},source={},material={},args={},...controls}={})=>({operation:'set_element_material',elements:[{id:101,parameters:[{id:-123,storage:'ElementId',value:-1,dataType:'material',...parameter}],...source},{id:202,isMaterial:true,...material}],args:{mode,element_id:101,parameter_id:-123,material_id:202,expected_has_value:true,expected_value_internal:-1,...args},...controls});
test('actual material assignment producer enforces instance ownership and exact guarded readback',{skip:process.platform!=='win32'},async t=>{
 const produce=await loadNativeParameterWriteProducer(t);
 const success=await produce(fixture());assert.equal(success.ok,true,JSON.stringify(success.error));assert.deepEqual(success.result.value,{element_id:'101',parameter_id:'-123',material_id:'202',before_has_value:true,before_value_internal:'-1',changed:true});assert.equal(success.result.committed,true);assert.equal(success.after.parameters[0].value,202);
 const preview=await produce(fixture({mode:'rollback'}));assert.equal(preview.ok,true,JSON.stringify(preview.error));assert.equal(preview.result.committed,false);assert.equal(preview.after.parameters[0].value,-1);
 for(const change of [{source:{isType:true}},{parameter:{owner:'type'}},{parameter:{owner:'otherElement'}},{parameter:{readOnly:true}},{parameter:{dataType:'text'}},{parameter:{storage:'Integer',value:1}},{material:{isMaterial:false}},{args:{expected_value_internal:1}},{args:{expected_has_value:false}},{args:{parameter_id:-1}},{args:{face_index:0}}]){
  const result=await produce(fixture(change));assert.equal(result.ok,false,JSON.stringify(change));assert.equal(result.transactions.GroupCommits,0);assert.equal(result.after.parameters[0].SetCalls,0);
 }
 const drift=await produce(fixture({parameter:{behavior:'trueNoChange'}}));assert.equal(drift.ok,false);assert.equal(drift.transactions.GroupCommits,0);
 const post=await produce(fixture({commitBehavior:'drift'}));assert.equal(post.ok,false);assert.equal(post.transactions.GroupCommits,0);assert.equal(post.after.parameters[0].value,-1);
 const noOp=await produce(fixture({parameter:{value:202},args:{expected_value_internal:202}}));assert.equal(noOp.ok,true,JSON.stringify(noOp.error));assert.equal(noOp.result.value.changed,false);assert.equal(noOp.after.parameters[0].SetCalls,0);
});
