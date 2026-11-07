import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeAtomicWorkbenchRead,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {modelOperationEffect} from './lib/model-operation-effects.mjs';
import {MODEL_COMMAND_CATALOG} from './lib/model-command-catalog.mjs';
import {MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';
import {describeModelOperationSchema} from './lib/model-operation-contracts.mjs';
const tool='revit_preview_project_parameter_binding',op='preview_project_parameter_binding',session='f'.repeat(32),doc={title:'Synthetic',path:'D:\\samples\\synthetic.rvt',activeViewId:10,activeViewType:'FloorPlan',modified:false,allowedSample:true};
const args={expected_document:doc.path,definition_guid:'d6c25563-54cb-43e7-8003-e7cf8df36916',definition_id:'45',data_type:'text',category_ids:['-2000011']};
const data={schema_version:1,definition_guid:args.definition_guid,definition_id:'45',data_type:'text',definition_name:'Test',document_title:doc.title,document_path:doc.path,binding_before:'unbound',proposed_binding:'instance',category_ids:['-2000011'],instance_count:1,instances:[{element_id:'9007199254740993',category_id:'-2000011',unique_id:'synthetic-1'}],offset:0,limit:50,snapshot_id:'a'.repeat(64),has_more:false,coverage:'complete_current_document_instances',future_instances_affected:true,authorization:'not_granted',host_session_bound:false,human_decision:false,binding_attempted:false,external_file_accessed:false};
async function fixture(t,{capability=true,corrupt=false,reply=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-binding-')),queue=path.join(root,'queue');for(const d of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,d),{recursive:true});
 const caps={atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:[op],...(capability?{projectBindingPreviewVersion:1}:{})},version='0.8.9';
 await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version,...caps}));let stop=false;const requests=[];
 const loop=(async()=>{while(!stop){for(const file of (await fs.readdir(path.join(queue,'inbox'))).filter(x=>x.endsWith('.json'))){const req=JSON.parse(await fs.readFile(path.join(queue,'inbox',file),'utf8'));await fs.rename(path.join(queue,'inbox',file),path.join(queue,'processing',file));requests.push(req);if(reply){const value=structuredClone(data);if(corrupt)value.definition_id='46';const snapshot={hostSession:session,hostVersion:version,document:doc,capabilities:caps};const result={operation:op,hostSession:session,atomicReadSnapshot:true,snapshot,value:{operation:op,hostSession:session,document:{title:doc.title,path:doc.path},modifiedByOperation:false,value}};await fs.writeFile(path.join(queue,'outbox',file),JSON.stringify({id:req.id,ok:true,result,completedUtc:new Date().toISOString()}));}}await new Promise(r=>setTimeout(r,5));}})();
 t.after(async()=>{stop=true;await loop;assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-project-binding-'));await fs.rm(root,{recursive:true,force:true});});return {root,requests};
}
test('atomic queue returns matching full impact and original request',async t=>{const f=await fixture(t);const result=await invokeAtomicWorkbenchRead(tool,args,{root:f.root,timeout:2000,retainReceiptOwner:true});assert.equal(result.value.instance_count,1);assert.equal(result.value.authorization,'not_granted');assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);assert.equal(result.request_id,f.requests[0].id);assert.ok(result.receiptOwner);});
test('old host and invalid input cannot enqueue',async t=>{const f=await fixture(t,{capability:false});await assert.rejects(invokeAtomicWorkbenchRead(tool,args,{root:f.root,timeout:100}));await assert.rejects(invokeAtomicWorkbenchRead(tool,{...args,category_ids:['-2000011','-2000011']},{root:f.root,timeout:100}));assert.equal(f.requests.length,0);});
test('mismatched original receipt fails closed without replay',async t=>{const f=await fixture(t,{corrupt:true});await assert.rejects(invokeAtomicWorkbenchRead(tool,args,{root:f.root,timeout:1000,retainReceiptOwner:true}),e=>{const facts=workbenchFailureEvidence(e);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);return true;});assert.equal(f.requests.length,1);});
test('timeout retains original request identity without replay',async t=>{const f=await fixture(t,{reply:false});await assert.rejects(invokeAtomicWorkbenchRead(tool,args,{root:f.root,timeout:100,retainReceiptOwner:true}),e=>{const facts=workbenchFailureEvidence(e);assert.equal(facts.outcome,'unconfirmed');assert.equal(facts.requestIds.length,1);return true;});assert.equal(f.requests.length,1);});
test('read capability is in MCP/command catalog and parameters discovery',()=>{assert.equal(modelOperationEffect(tool).kind,'read');assert.ok(MODEL_AI_READ_TOOLS.some(t=>t.name===tool));assert.ok(MODEL_COMMAND_CATALOG.some(t=>t.tool===tool&&t.readOnly));const found=describeModelOperationSchema({tool});assert.equal(found.ok,true);assert.equal(found.value.tool,tool);});



test('omitted document is bound in the same atomic callback',async t=>{const f=await fixture(t);const {expected_document,...input}=args;const result=await invokeAtomicWorkbenchRead(tool,input,{root:f.root,timeout:2000});assert.equal(result.value.document_path,doc.path);assert.equal(f.requests.length,1);assert.equal(Object.hasOwn(f.requests[0].args,'expected_document'),false);});
test('safe numeric definition ID is normalized to the exact wire string',async t=>{const f=await fixture(t);const result=await invokeAtomicWorkbenchRead(tool,{...args,definition_id:45},{root:f.root,timeout:2000});assert.equal(result.value.definition_id,'45');assert.equal(f.requests[0].args.definition_id,'45');});
