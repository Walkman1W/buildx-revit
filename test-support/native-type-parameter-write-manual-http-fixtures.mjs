import {typeWriteHttpFixture,typeWriteArgs,TYPE_WRITE_DOCUMENT,TYPE_WRITE_TOOL,waitTypeWrite} from './native-type-parameter-write-approval-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {createPanelServerCore} from '../lib/panel-server-core.mjs';
import {panelProfile} from '../lib/panel-profile.mjs';
import {createCustomerChatProfile} from '../lib/customer-chat-profile.mjs';
export {typeWriteArgs,TYPE_WRITE_DOCUMENT,TYPE_WRITE_TOOL,waitTypeWrite};

// The existing isolated HTTP/permission composition supplies real approval
// capabilities; this wrapper deliberately never begins a Codex turn or thread.
export async function manualTypeWriteHttpFixture(t,options={}){
  const f=await typeWriteHttpFixture(t,options),calls={threads:0,turns:0};
  const newThread=f.codex.newThread.bind(f.codex),turn=f.codex.turn.bind(f.codex);
  f.codex.newThread=async(...args)=>{calls.threads++;return newThread(...args);};
  f.codex.turn=async(...args)=>{calls.turns++;return turn(...args);};
  const submit=(args=typeWriteArgs(),patch={})=>{const parameters=structuredClone(args);delete parameters.expected_document;
    return f.post('command',{conversationId:f.session,commandId:TYPE_WRITE_TOOL,parameters,sourceDocument:TYPE_WRITE_DOCUMENT,confirmed:true,...patch});};
  const command=()=>f.app.snapshot('browser').command;
  const terminal=async()=>{await waitTypeWrite(()=>!f.app.snapshot('browser').busy&&['completed','failed','interrupted','unknown'].includes(command()?.status));return command();};
  return {...f,submit,command,terminal,calls};
}

export async function manualTypeWriteAssetFixture(t,kind){
  const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-type-write-assets-')),identity=await fs.lstat(base,{bigint:true}),root=path.join(base,'program');let app;
  t.after(async()=>{if(app)await app.close();const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});assert.equal(path.dirname(target),parent);assert.match(path.basename(target),/^buildx-type-write-assets-/);
    assert.ok(path.isAbsolute(target)&&current.isDirectory()&&!current.isSymbolicLink());assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());await fs.rm(target,{recursive:true,force:false});});
  await fs.mkdir(path.join(root,'public'),{recursive:true});const originals={};
  for(const name of ['manual-type-parameter-write-field.mjs','type-parameter-write-review.mjs']){const bytes=await fs.readFile(new URL('../public/'+name,import.meta.url));originals[name]=bytes;await fs.writeFile(path.join(root,'public',name),bytes,{flag:'wx'});}
  const codex=new EventEmitter();codex.state={ready:true,error:false,mode:kind==='customer'?'customer-chat':kind==='source'?'source-development':'document-workbench',toolCount:0,connectionGeneration:1,codexAccount:{accountRevision:1}};codex.close=async()=>({closed:true});
  const auth=Object.fromEntries(['signIn','signUp','verifySession','refresh','signOut','release','close'].map(name=>[name,async()=>name==='close'?{ok:true,value:{closed:true}}:{ok:false}]));
  const selection=kind==='customer'?createCustomerChatProfile().panel:panelProfile(kind==='source'?'source-development':'model-workspace');
  app=createPanelServerCore({root,dataRoot:path.join(base,'data'),codex,port:0,selection,invokeWorkbench:async()=>{throw new Error('Asset verification must never invoke a model.');},...kind==='customer'?{requireAccount:true,accountAuth:auth}:{}});
  const {origin}=await app.listen();return {origin,originals};
}
