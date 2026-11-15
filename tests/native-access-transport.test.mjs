import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {invokeWorkbench,nativeAccessPolicyBinding} from '../lib/workbench-client.mjs';
import {createModelPermissionServices} from '../lib/model-permission-services.mjs';

const policy={id:randomUUID(),revision:1,accountScope:'fixture-account',mode:'full-access'};
async function fixture(t,version='0.8.0',capability=1){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-access-transport-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-access-transport-'));await fs.rm(root,{recursive:true,force:true});});
  for(const directory of ['inbox','processing','outbox'])await fs.mkdir(path.join(root,'queue',directory),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'a'.repeat(32),pid:process.pid,version,atomicReadSnapshot:true,accessPolicyVersion:capability}));
  return {root,inbox:path.join(root,'queue','inbox')};
}
async function request(f){for(let i=0;i<100;i++){const name=(await fs.readdir(f.inbox)).find(name=>name.endsWith('.json'));if(name)return JSON.parse(await fs.readFile(path.join(f.inbox,name),'utf8'));await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('request deadline');}
const writeArgs={expected_document:'C:\\model.rvt',mode:'commit',element_ids:[3],delta_mm:{x:1,y:0,z:0}};

test('policy binding is data-only, snapshots trusted modes and never accepts an arbitrary scope from tool arguments',()=>{
  assert.deepEqual(nativeAccessPolicyBinding(policy),{id:policy.id,revision:1,accountScope:'fixture-account'});
  assert.equal(nativeAccessPolicyBinding(undefined),undefined);
  assert.throws(()=>nativeAccessPolicyBinding({...policy,revision:-1}));assert.throws(()=>nativeAccessPolicyBinding({...policy,all:true}));
  let called=false;assert.throws(()=>nativeAccessPolicyBinding({...policy,get mode(){called=true;return 'full-access';}}));assert.equal(called,false);
});

test('new-policy writes refuse an old host before publication; read queries remain compatible',async t=>{
  const f=await fixture(t,'0.7.0',undefined);
  await assert.rejects(invokeWorkbench('revit_move_elements',writeArgs,{root:f.root,timeout:10,accessPolicy:policy}),/0.8.0/);
  assert.deepEqual(await fs.readdir(f.inbox),[]);
  const pending=invokeWorkbench('revit_workbench_status',{}, {root:f.root,timeout:2000,accessPolicy:policy});const req=await request(f);
  assert.equal(Object.hasOwn(req,'accessPolicy'),false);
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify({id:req.id,ok:true,result:{hostSession:'a'.repeat(32),document:{title:'model',path:'C:\\model.rvt'}},completedUtc:new Date().toISOString()}));
  assert.equal((await pending).document.title,'model');
});

test('transport sends the frozen policy identity outside model parameters',async t=>{
  const f=await fixture(t),mutable={...policy},pending=invokeWorkbench('revit_move_elements',writeArgs,{root:f.root,timeout:2000,accessPolicy:mutable});
  mutable.revision=99;const req=await request(f);assert.deepEqual(req.accessPolicy,{id:policy.id,revision:1,accountScope:'fixture-account'});assert.equal(Object.hasOwn(req.args,'accessPolicy'),false);
  await fs.writeFile(path.join(f.root,'queue','outbox',req.id+'.json'),JSON.stringify({id:req.id,ok:true,result:{operation:'move_elements',mode:'commit',committed:true,document:'model',value:{}},completedUtc:new Date().toISOString()}));
  assert.equal((await pending).committed,true);
});

test('document observation requires exact new host permission facts and never falls back to allowedSample',async()=>{
  let facts={schemaVersion:1,policy:{...policy},allowed:true,reason:'allowed'},capability=1;
  const calls=[],services=createModelPermissionServices({observe:async(...args)=>{calls.push(args);return {hostSession:'host',document:{title:'model',path:'C:\\model.rvt',allowedSample:false,access:facts},capabilities:{accessPolicyVersion:capability}};},invoke:async()=>{}});
  assert.deepEqual(await services.observeDocument({accessPolicy:policy}),{session:'host',title:'model',path:'C:\\model.rvt'});assert.equal(calls[0][2].accessPolicy,policy);
  for(const patch of [{allowed:false},{policy:{...policy,revision:2}},{policy:{...policy,mode:'project-write'}},{policy:{...policy,accountScope:'other'}}]){facts={schemaVersion:1,policy:{...policy},allowed:true,reason:'allowed',...patch};await assert.rejects(services.observeDocument({accessPolicy:policy}));}
  facts={schemaVersion:1,policy:{...policy},allowed:true,reason:'allowed'};capability=0;await assert.rejects(services.observeDocument({accessPolicy:policy}),/宿主/);
});
