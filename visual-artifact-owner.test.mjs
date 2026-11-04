import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createVisualArtifactOwner} from './lib/visual-artifact-owner.mjs';
import {ChatSession} from './lib/chat-session.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-visual-artifact-')),host='a'.repeat(32),request=randomUUID(),id=randomUUID(),folder=path.join(root,'workbench','visual-captures',host,request);
  await fs.mkdir(folder,{recursive:true});const filename=path.join(folder,id+'.png');await fs.writeFile(filename,png);
  const receipt={hostSession:host,request_id:request,document:{title:'测试模型',path:'D:\\test.rvt'},operation:'inspect_elements',value:{schema_version:1,operation:'inspect_elements',host_session:host,document:{title:'测试模型',path:'D:\\test.rvt'},success:true,cleanup_pending:false,images:[{artifact_id:id,request_id:request,path:filename,bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),width:1,height:1,orientation:'isometric'}],restoration:{status:'restored',source_view_unchanged:true}}};
  const owner=createVisualArtifactOwner({root});t.after(async()=>{assert.deepEqual(await owner.close(),{closed:true});assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('buildx-visual-artifact-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,receipt,owner,filename,folder};
}

test('canonical native PNG bytes become immutable chat inputs and image content only after integrity checks',async t=>{
  const f=await fixture(t),read=await f.owner.read(f.receipt);
  assert.equal(read.files.length,1);assert.deepEqual(read.files[0].data,png);assert.notEqual(read.files[0].id,f.receipt.value.images[0].artifact_id);assert.equal(read.contentItems[0].imageUrl,'data:image/png;base64,'+png.toString('base64'));
  assert.equal(Object.hasOwn(read.files[0],'path'),false);assert.equal(read.files[0].mediaType,'image/png');
});

test('foreign path, duplicate image, changed digest/dimensions and incomplete restoration never become visual input',async t=>{
  const f=await fixture(t);
  const changes=[r=>{r.value.images[0].path=path.join(f.root,'foreign.png');},r=>{r.value.images.push({...r.value.images[0]});},r=>{r.value.images[0].sha256='b'.repeat(64);},r=>{r.value.images[0].width=2;},r=>{r.value.images[0].request_id=randomUUID();},r=>{r.value.restoration.status='pending';},r=>{r.value.images[0].bytes=2*1024*1024+1;}];
  for(const change of changes){const receipt=structuredClone(f.receipt);change(receipt);await assert.rejects(f.owner.read(receipt),/未能核实/);}
  assert.equal((await f.owner.read(f.receipt)).files.length,1);
});

test('hardlinked and symbolic native snapshots are refused before bytes are returned',async t=>{
  const f=await fixture(t),alias=path.join(f.folder,'linked.png');await fs.link(f.filename,alias);
  await assert.rejects(f.owner.read(f.receipt),/未能核实/);await fs.unlink(alias);
  const target=path.join(f.folder,'target.png');await fs.rename(f.filename,target);
  try{await fs.symlink(target,f.filename,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){await fs.rename(target,f.filename);t.diagnostic('File symlink creation unavailable; hardlink refusal was verified.');return;}throw error;}
  await assert.rejects(f.owner.read(f.receipt),/未能核实/);
});

test('a context revoked during a native file read cannot return image inputs; closed owners do not reopen',async t=>{
  const f=await fixture(t);let checks=0;
  await assert.rejects(f.owner.read(f.receipt,{shouldContinue:()=>++checks<3}),/已变化/);
  assert.equal((await f.owner.read(f.receipt)).files.length,1);assert.deepEqual(await f.owner.close(),{closed:true});await assert.rejects(f.owner.read(f.receipt),/读取或清理/);
});

test('assistant snapshot attachment owner requires the exact live turn and rejects duplicate or finished changes',()=>{
  const session=new ChatSession(),run=session.begin('检查刚创建的元素'),image={id:randomUUID(),name:'截图.png',kind:'image',mediaType:'image/png',bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')};
  assert.equal(session.attachAssistantImages({...run},[image]),false);assert.equal(session.attachAssistantImages(run,[image]),true);assert.equal(session.attachAssistantImages(run,[image]),false);
  const message=session.view().messages.find(item=>item.role==='assistant');assert.deepEqual(message.attachments,[image]);assert.equal(JSON.stringify(message).includes('base64'),false);
  session.finish(run,'completed');assert.equal(session.attachAssistantImages(run,[{...image,id:randomUUID()}]),false);
});
