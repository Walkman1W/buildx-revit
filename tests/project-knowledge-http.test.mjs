import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

test('project HTTP uses explicit binding, exact source versions and account isolation',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-http-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'design.txt'),'楼梯净宽 1200 mm\n');
  const f=await createModelWorkspaceFixture();t.after(()=>f.close());
  const request=(action,parameters={},cookie)=>f.post('project-knowledge',{action,parameters},cookie);
  assert.equal((await request('bind',{projectId:'A',rootPath:directory})).status,401);
  const login=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'}),cookie=login.cookie;
  assert.equal((await request('bind',{projectId:'A',rootPath:directory},cookie)).status,200);
  const found=await request('search',{query:'净宽'},cookie);assert.equal(found.status,200);
  const ref=found.body.value.matches[0];assert.equal(ref.path,'design.txt');assert.equal(ref.location.line,1);
  await fs.writeFile(path.join(directory,'design.txt'),'楼梯净宽 1500 mm\n');
  assert.equal((await request('refresh',{},cookie)).status,200);
  const old=await request('read',{path:ref.path,sha256:ref.sha256},cookie);
  assert.equal(old.body.value.historical,true);assert.match(JSON.stringify(old.body.value),/1200/);
  assert.equal((await request('bind',{projectId:'B',rootPath:directory,unexpected:true},cookie)).status,400);
  await f.post('account/sign-out',{},cookie);
  const next=await f.post('account/sign-in',{email:'other@example.invalid',password:'fixture-password'});
  assert.equal((await request('search',{query:'净宽'},next.cookie)).status,409);
  assert.equal((await f.post('project-knowledge',{action:'list',parameters:{}},next.cookie,{Origin:'https://foreign.invalid'})).status,403);
});

test('an idle bound project detects updates without scanning outside its selected directory',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-poll-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const f=await createModelWorkspaceFixture({required:false,projectPollMs:50});t.after(()=>f.close());
  const request=(action,parameters={})=>f.post('project-knowledge',{action,parameters});
  assert.equal((await request('bind',{projectId:'poll',rootPath:directory})).status,200);
  await fs.writeFile(path.join(directory,'new.txt'),'自动发现测试');
  let found;
  for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,25));found=await request('search',{query:'自动发现'});if(found.body.value?.matches?.length)break;}
  assert.equal(found.body.value.matches[0].path,'new.txt');
});

test('optional private history restores a bound project and exact old source after a new panel instance',async t=>{
  const {createProjectHistory}=await import('../lib/project-history.mjs');
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-durable-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),state=path.join(parent,'state');await fs.mkdir(source);await fs.mkdir(state);
  await fs.writeFile(path.join(source,'design.txt'),'original 1200 mm');
  const options={projectHistoryFactory:accountId=>createProjectHistory({stateDirectory:state,accountId})};
  const first=await createModelWorkspaceFixture(options);
  const sign=async f=>(await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'})).cookie;
  const cookie=await sign(first),call=(f,c,action,parameters={})=>f.post('project-knowledge',{action,parameters},c);
  assert.equal((await call(first,cookie,'bind',{projectId:'A',rootPath:source})).status,200);
  const found=await call(first,cookie,'search',{query:'original'}),hash=found.body.value.matches[0].sha256;
  assert.equal((await call(first,cookie,'list')).body.value.files[0].persistence,'durable');
  await first.close();await fs.writeFile(path.join(source,'design.txt'),'replacement 1500 mm');
  const second=await createModelWorkspaceFixture(options);t.after(()=>second.close());const next=await sign(second);
  assert.equal((await call(second,next,'restore-binding')).status,200);
  const old=await call(second,next,'restore-read',{path:'design.txt',sha256:hash});assert.equal(old.status,200);assert.equal(old.body.value.historical,true);assert.match(JSON.stringify(old.body.value),/original 1200/);
  await second.post('account/sign-out',{},next);
  const other=(await second.post('account/sign-in',{email:'other@example.invalid',password:'fixture-password'})).cookie;
  assert.equal((await call(second,other,'restore-binding')).status,409);
});
