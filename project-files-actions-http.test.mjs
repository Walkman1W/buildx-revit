import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createProjectFilesComposition} from './lib/project-files-composition.mjs';

const appRoot=fileURLToPath(new URL('.',import.meta.url));
class FakeCodex extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(appRoot,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:1}};this.turns=0;}
  async turn(){this.turns++;throw new Error('Unexpected AI turn');}
  async close(){return {closed:true};}
}

test('HTTP actions open only selected files and stage their exact bytes without sending an AI turn',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-actions-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const file=path.join(folder,'资料 & test.txt'),bytes=Buffer.from('参考资料\r\n'),executable=path.join(folder,'example.exe');await fs.writeFile(file,bytes);await fs.writeFile(executable,'not executable');
  const opened=[],opener=Object.freeze({open:async target=>{opened.push(target);return {ok:true,value:{accepted:true}};},close:async()=>({closed:true})});
  const material=createProjectFilesComposition({opener});
  const codex=new FakeCodex(),app=createPanelServer({root:appRoot,codex,port:0,profile:MODEL_WORKSPACE_SESSION_PROFILE,...material,invokeWorkbench:async()=>({hostSession:'fixture',document:{title:'fixture',path:''}})});
  const {origin}=await app.listen();t.after(()=>app.close());const state=await (await fetch(origin+'/api/status')).json();
  const call=async(action,parameters)=>{const response=await fetch(origin+'/api/project-files',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client:'actions-test',action,parameters})});return {status:response.status,body:await response.json()};};
  const added=await call('add-root',{path:file,kind:'file'});assert.equal(added.status,200);const rootId=added.body.value.root.id;
  assert.equal((await call('open-file',{rootId,path:''})).status,200);assert.equal((await call('open-folder',{rootId,path:''})).status,200);
  assert.deepEqual(opened,[{path:file,kind:'file'},{path:folder,kind:'directory'}]);
  const attachment=await call('read-attachment',{rootId,path:''});assert.equal(attachment.status,200);assert.equal(attachment.body.value.name,'资料 & test.txt');assert.deepEqual(Buffer.from(attachment.body.value.data,'base64'),bytes);
  assert.equal((await call('open-file',{rootId,path:'../outside.txt'})).body.ok,false);assert.equal((await call('open-file',{rootId,path:file})).body.ok,false);
  const addedExe=await call('add-root',{path:executable,kind:'file'});assert.equal((await call('open-file',{rootId:addedExe.body.value.root.id,path:''})).body.ok,false);assert.equal(opened.length,2);
  assert.equal(codex.turns,0);
});
