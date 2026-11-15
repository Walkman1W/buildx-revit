import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createProjectFilesStore} from '../lib/project-files-store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
class Fake extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};this.answers=[];}
  async newThread(){return 'thread';}
  async turn(){this.send();return {turn:{id:'turn'}};}
  async interrupt(){} async close(){return {closed:true};}
  send(){const params=Object.freeze({threadId:'thread',turnId:'turn',callId:'call',tool:'buildx_materials_read',arguments:Object.freeze(this.args)});this.emit('dynamic-tool-request',{generation:1,revision:2,params,respond:value=>{this.answers.push(value);return true;},reject(){},discard(){}});}
}

test('library HTTP and Codex read the same selected roots and the current saved project',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-panel-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const project=path.join(folder,'current.rvt'),file=path.join(folder,'note.txt');await fs.writeFile(project,'fixture');await fs.writeFile(file,'library fixture');
  const codex=new Fake();let documentPath=project;
  const app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,invokeWorkbench:async()=>({hostSession:'host',document:{title:'fixture',path:documentPath}})});
  const {origin}=await app.listen();t.after(()=>app.close());const state=await (await fetch(origin+'/api/status')).json();
  const post=async(route,data)=>{const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'test',...data})});return {status:response.status,body:await response.json()};};
  const call=(action,parameters)=>post('project-files',{action,parameters});
  const roots=await call('list-roots',{});assert.equal(roots.status,200);assert.equal(roots.body.value.projectStatus,'available');
  const projectRoot=roots.body.value.roots.find(item=>item.source==='project');assert.equal(projectRoot.path,folder);
  const added=await call('add-root',{path:file,kind:'file'});assert.equal(added.status,200);const selected=added.body.value.root;
  const read=await call('read-file',{rootId:selected.id,path:''});assert.equal(read.body.value.text,'library fixture');
  const traversal=await call('read-file',{rootId:projectRoot.id,path:'../note.txt'});assert.equal(traversal.body.ok,false);
  codex.args={rootId:selected.id,path:''};assert.equal((await post('turn',{message:'读取资料'})).status,202);
  for(let i=0;i<100&&!codex.answers.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(codex.answers[0].success,true);assert.equal(JSON.parse(codex.answers[0].contentItems[0].text).value.text,'library fixture');
  documentPath='';const changed=await call('list-roots',{});assert.equal(changed.body.value.projectStatus,'unsaved');assert.equal(changed.body.value.roots.some(item=>item.source==='project'),false);assert.equal(changed.body.value.roots.some(item=>item.id===selected.id),true);
});

test('a stalled Revit status does not block adding or reading a user-selected file',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-offline-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));const file=path.join(folder,'a.txt');await fs.writeFile(file,'offline');
  const codex=new Fake(),app=createPanelServer({root,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,invokeWorkbench:async()=>new Promise(()=>{})});
  const {origin}=await app.listen();t.after(()=>app.close());const state=await (await fetch(origin+'/api/status')).json();
  const call=async(action,parameters)=>{const response=await fetch(origin+'/api/project-files',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'test',action,parameters})});return response.json();};
  const added=await call('add-root',{path:file,kind:'file'});assert.equal(added.ok,true);
  const read=await call('read-file',{rootId:added.value.root.id,path:''});assert.equal(read.value.text,'offline');
  const roots=await call('list-roots',{});assert.equal(roots.value.projectStatus,'unavailable');
});

test('selected addresses survive a normal service restart and missing files remain removable',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-restart-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const stateDir=path.join(folder,'state'),file=path.join(folder,'note.txt');await fs.mkdir(stateDir);await fs.writeFile(file,'temporary fixture');
  const storeFactory=accountId=>createProjectFilesStore({stateDirectory:stateDir,accountId});
  async function start(){const app=createPanelServer({root,codex:new Fake(),port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,materialStoreFactory:storeFactory,invokeWorkbench:async()=>({hostSession:'host',document:{title:'new',path:''}})});const {origin}=await app.listen();const state=await (await fetch(origin+'/api/status')).json();
    const call=async(action,parameters)=>{const response=await fetch(origin+'/api/project-files',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'test',action,parameters})});return response.json();};return {app,call};}
  const first=await start();assert.equal((await first.call('add-root',{path:file,kind:'file'})).ok,true);assert.deepEqual(await first.app.close(),{closed:true});
  const second=await start();const roots=await second.call('list-roots',{});const saved=roots.value.roots.find(item=>item.path===file);
  assert.equal(saved.status,'needs-confirmation');assert.equal((await second.call('read-file',{rootId:saved.id,path:''})).ok,false);
  assert.equal((await second.call('add-root',{path:file,kind:'file'})).ok,true);
  assert.equal((await second.call('read-file',{rootId:saved.id,path:''})).value.text,'temporary fixture');
  assert.equal((await second.call('remove-root',{id:saved.id})).ok,true);
  assert.deepEqual(await second.app.close(),{closed:true});
});
