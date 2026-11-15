import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPermissionServices} from '../../lib/model-permission-services.mjs';

test('observes the current saved model and passes the authorization control to the actual invoker',async()=>{
  const calls=[];
  const services=createModelPermissionServices({
    observe:async(...args)=>{calls.push(args);return {hostSession:'host',document:{path:'C:\\model.rvt',title:'model',allowedSample:true}};},
    invoke:async(...args)=>{calls.push(args);return {operation:'move',value:1};}
  });
  assert.deepEqual(await services.observeDocument(),{session:'host',title:'model',path:'C:\\model.rvt'});
  const control={shouldContinue:()=>true,sourceDocument:{session:'host',title:'model',path:'C:\\model.rvt'}};
  assert.deepEqual(await services.invoke('revit_move_elements',{mode:'rollback'},control),{ok:true,value:{operation:'move',value:1}});
  assert.equal(calls[1][2],control);
  await services.readCommand({command_id:'test',revision:'a'.repeat(64)},control);
  assert.equal(calls[2][0],'revit_get_command');assert.deepEqual(calls[2][1],{command_id:'test',revision:'a'.repeat(64)});assert.equal(calls[2][2],control);
  await services.inspectFamilyJob('job',control);assert.equal(calls[3][0],'revit_family_inspect_job');assert.deepEqual(calls[3][1],{job_handle:'job'});assert.equal(calls[3][2],control);
});

test('a saved document without an explicit host allowlist observation is not granted',async()=>{
  const services=createModelPermissionServices({observe:async()=>({hostSession:'host',document:{path:'C:\\model.rvt',title:'model'}}),invoke:async()=>{}});
  await assert.rejects(services.observeDocument(),/允许的模型范围/);
});

test('rejects an unsaved model and preserves an uncertain original receipt on failure',async()=>{
  const receipt={inspect(){}};
  const services=createModelPermissionServices({observe:async()=>({hostSession:'host',document:{path:'',title:'model'}}),invoke:async()=>{throw Object.assign(new Error('unknown'),{receiptOwner:receipt});}});
  await assert.rejects(services.observeDocument(),/尚未保存/);
  const result=await services.invoke('revit_move_elements',{},{});
  assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');assert.equal(result.receiptOwner,receipt);
});
