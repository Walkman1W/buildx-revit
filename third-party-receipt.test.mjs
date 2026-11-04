import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {invokeWorkbench,workbenchFailureEvidence} from './lib/workbench-client.mjs';

const session='a'.repeat(32),sourceDocument={session,title:'Sample',path:'C:\\sample.rvt'};
const options={sourceDocument,expectedHostSession:session,retainReceiptOwner:true,shouldContinue:()=>true};
const tools=[
  {name:'revit_smart_annotate',operation:'smart_annotate',args:{expected_document:sourceDocument.path,element_ids:[1],view_id:20,tag_type_id:30},value:{engine:'fixture',view_id:20,created_tag_ids:[100],count:1}},
  {name:'revit_build_schematic',operation:'build_schematic',args:{expected_document:sourceDocument.path,start_element_id:1,schematic_type:'pipe'},value:{engine:'fixture',view_id:20,source_element_id:1,graph_nodes:3,graph_edges:2,drawn_elements:6,detail_lines:3,text_notes:1,detail_component_instances:1}}
];
async function fixture(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-thirdparty-'));const rel=path.relative(parent,path.resolve(root));
  assert.ok(rel.startsWith('buildx-thirdparty-')&&!rel.includes(path.sep)&&!path.isAbsolute(rel));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queue=path.join(root,'queue');for(const name of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.6',startedUtc:new Date().toISOString()}));return {root,queue};
}
function receipt(id,tool,mode){
  const stamp=new Date().toISOString();return {id,ok:true,completedUtc:stamp,timing:{schemaVersion:1,requestId:id,hostSession:session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},result:{operation:tool.operation,mode,committed:mode==='commit',document:sourceDocument.title,value:structuredClone(tool.value)}};
}
async function original(f,tool,mode){let error;try{await invokeWorkbench(tool.name,{...tool.args,mode},{root:f.root,timeout:25,...options});}catch(value){error=value;}const facts=workbenchFailureEvidence(error);assert.equal(facts.outcome,'unconfirmed');assert.ok(facts.receiptOwner);return {id:facts.requestIds[0],owner:facts.receiptOwner};}

for(const tool of tools)for(const mode of ['rollback','commit'])test(`${tool.operation} ${mode} keeps original receipt and external effects unknown`,async t=>{
  const f=await fixture(t),{id,owner}=await original(f,tool,mode),file=path.join(f.queue,'outbox',id+'.json');
  await fs.writeFile(file,JSON.stringify(receipt(id,tool,mode)));const checked=owner.inspect();assert.equal(checked.value.status,'received');assert.equal(checked.value.evidence.externalEffects,'unknown');assert.match(checked.value.message,/事务外影响尚未核实/);assert.equal(owner.close().value.closed,true);
});

test('third party responses missing transaction, business or source facts stay unconfirmed',async t=>{
  const f=await fixture(t),tool=tools[0],{id,owner}=await original(f,tool,'rollback'),file=path.join(f.queue,'outbox',id+'.json');
  for(const mutate of [v=>delete v.timing,v=>v.timing.hostSession='b'.repeat(32),v=>v.result.document='different',v=>v.result.mode='commit',v=>v.result.committed=true,v=>v.result.value.view_id=21,v=>v.result.value.count=2,v=>delete v.result.value.created_tag_ids,v=>v.result.value={error:'failed'}]){
    const v=receipt(id,tool,'rollback');mutate(v);await fs.writeFile(file,JSON.stringify(v));assert.equal(owner.inspect().value.status,'unconfirmed',mutate.toString());
  }
  assert.equal(owner.close().value.closed,true);
});

test('schematic must match its exact source and bounded numeric business facts',async t=>{
  const f=await fixture(t),tool=tools[1],{id,owner}=await original(f,tool,'commit'),file=path.join(f.queue,'outbox',id+'.json');
  for(const mutate of [v=>v.result.value.source_element_id=2,v=>v.result.value.view_id=0,v=>v.result.value.graph_nodes=-1,v=>delete v.result.value.drawn_elements]){
    const v=receipt(id,tool,'commit');mutate(v);await fs.writeFile(file,JSON.stringify(v));assert.equal(owner.inspect().value.status,'unconfirmed',mutate.toString());
  }
  assert.equal(owner.close().value.closed,true);
});

test('synchronous success returns scoped model evidence and unverified external effects',async t=>{
  const f=await fixture(t),tool=tools[0],pending=invokeWorkbench(tool.name,{...tool.args,mode:'commit'},{root:f.root,timeout:2000,...options});let file;
  for(let i=0;i<100&&!file;i++){await new Promise(resolve=>setTimeout(resolve,10));file=(await fs.readdir(path.join(f.queue,'inbox'))).find(value=>value.endsWith('.json'));}
  assert.ok(file);const id=file.slice(0,-5);await fs.writeFile(path.join(f.queue,'outbox',file),JSON.stringify(receipt(id,tool,'commit')));
  const value=await pending;assert.equal(value.effectEvidence.externalEffects,'unknown');assert.match(value.effectEvidence.notice,/事务外影响尚未核实/);assert.ok(value.receiptOwner);assert.equal(value.receiptOwner.close().value.closed,true);
});

test('third party invocation needs source identity and revocation prevents prepublication',async t=>{
  const f=await fixture(t),tool=tools[0];await assert.rejects(invokeWorkbench(tool.name,tool.args,{root:f.root,...options,sourceDocument:undefined}),e=>workbenchFailureEvidence(e).outcome==='not_started');
  let live=true,error;try{await invokeWorkbench(tool.name,tool.args,{root:f.root,...options,shouldContinue:()=>live,onTiming:event=>{if(event.phase==='temp_ready')live=false;}});}catch(value){error=value;}
  assert.equal(workbenchFailureEvidence(error).outcome,'not_started');assert.equal((await fs.readdir(path.join(f.queue,'inbox'))).some(name=>name.endsWith('.json')),false);
});
