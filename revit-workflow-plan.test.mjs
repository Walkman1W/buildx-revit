import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRevitWorkflow} from './lib/revit-workflow-plan.mjs';

const root={scope:{account:'fixture-account',conversationId:'fixture-chat',hostSession:'e'.repeat(32),document:{title:'测试',path:'D:\\fixtures\\workflow.rvt'},accessRevision:2},
  now:10000,deadline:11000,availableTools:['revit_list_levels','revit_create_group']};
const group={id:'group',tool:'revit_create_group',dependsOn:['levels'],parameters:{name:'试验组',element_ids:[101,102],mode:'commit'}};
const levels={id:'levels',tool:'revit_list_levels',dependsOn:[],parameters:{}};
const request=(steps=[levels,group],override={})=>prepareRevitWorkflow({...root,draft:{steps},...override});

test('review digest binds exact steps, transaction mode, host, document, account and expiry',()=>{
  const {digest,plan}=request();
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(plan.steps[0].effect,'read');
  assert.equal(plan.steps[1].effect,'model_transaction');
  assert.equal(plan.steps[1].parameters.mode,'commit');
  assert.equal(Object.isFrozen(plan.steps[1].parameters.element_ids),true);
  assert.equal(request().digest,digest);
  assert.notEqual(request([levels,{...group,parameters:{...group.parameters,mode:'rollback'}}]).digest,digest);
  assert.notEqual(request(undefined,{scope:{...root.scope,hostSession:'a'.repeat(32)}}).digest,digest);
  assert.notEqual(request(undefined,{deadline:12000}).digest,digest);
});

test('review rejects forward references, duplicate steps and cross-document parameters',()=>{
  assert.throws(()=>request([group,levels]),/WORKFLOW_STEP_INVALID/);
  assert.throws(()=>request([levels,levels]),/WORKFLOW_STEP_INVALID/);
  assert.throws(()=>request([levels,{...group,parameters:{...group.parameters,expected_document:'D:\\other.rvt'}}]),/WORKFLOW_DOCUMENT_SUPPLIED/);
});

test('review requires trusted tool availability and explicit model write mode',()=>{
  assert.throws(()=>request(undefined,{availableTools:['revit_list_levels']}),/WORKFLOW_TOOL_UNAVAILABLE/);
  assert.throws(()=>request([levels,{...group,tool:'revit_execute_csharp'}],{availableTools:[...root.availableTools,'revit_execute_csharp']}),/WORKFLOW_TOOL_UNAVAILABLE/);
  assert.throws(()=>request([levels,{...group,parameters:{...group.parameters,mode:'automatic'}}]),/WORKFLOW_MODE_REQUIRED/);
  assert.throws(()=>request([levels,{...group,parameters:{...group.parameters,element_ids:[101]}}]),/WORKFLOW_PARAMETERS_INVALID/);
  assert.throws(()=>request(undefined,{deadline:root.now}),/WORKFLOW_SCOPE_INVALID/);
});
