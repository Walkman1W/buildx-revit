import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createDwgNativeStoragePrototype} from './lib/dwg-native-storage-prototype.mjs';
import {createDwgJournalPrototype} from './lib/dwg-persistent-journal-prototype.mjs';
const root=process.env.BUILDX_DWG_TEST_ROOT,exe=process.env.BUILDX_DWG_TEST_EXE;
const invoke=input=>new Promise((resolve,reject)=>{const c=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';c.stdout.setEncoding('utf8');c.stderr.setEncoding('utf8');c.stdout.on('data',s=>out+=s);c.stderr.on('data',s=>err+=s);c.on('error',reject);c.on('close',()=>{try{resolve(JSON.parse(out));}catch{reject(new Error('native journal returned no valid result '+err));}});c.stdin.end(JSON.stringify(input));});
const plan=id=>({request_id:id,host_session:'session',document_id:'doc',view_id:'1',stage_id:'17f430d2-cc82-4951-850f-195991003c11',stage_directory_identity:'stage-id',destination_path:'D:\\chosen',destination_directory_identity:'target-id',selection_id:'13f430d2-cc82-4951-850f-195991003c11',files:[{name:'view.dwg',source_identity:'source-id',sha256:'a'.repeat(64),bytes:12}]});
const event=(r,kind,more={})=>({kind,revision:r.revision,digest:r.digest,...more});
test('actual native exclusive journal and Node prototype preserve in-flight original request',{skip:!root||!exe},async()=>{
 const dir=path.join(root,'journal');await fs.mkdir(dir);const captured=await invoke({operation:'capture',directory:dir});assert.equal(captured.ok,true);const storage=createDwgNativeStoragePrototype({invoke,root:captured.value}),owner=createDwgJournalPrototype(storage),id='40207aac-335d-4d26-a785-29c384f0559a';
 let entry=await owner.stage(plan(id));entry=await owner.advance(entry,event(entry.record,'approve',{deadline:2000}),{now:1000});const start=event(entry.record,'start_file',{index:0});const raced=await Promise.allSettled([owner.advance(entry,start,{now:1000}),owner.advance(entry,start,{now:1000})]);assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.filter(x=>x.status==='rejected').length,1);
 const restarted=createDwgJournalPrototype(createDwgNativeStoragePrototype({invoke,root:captured.value}));let recovered=await restarted.recover(id,2);assert.equal(recovered.record.state,'publishing');recovered=await restarted.advance(recovered,event(recovered.record,'interrupt'),{now:1000});assert.equal(recovered.record.state,'unconfirmed');await assert.rejects(restarted.advance(recovered,event(recovered.record,'start_file',{index:0}),{now:1000}));
 const partialId='50207aac-335d-4d26-a785-29c384f0559a',partial=path.join(dir,partialId+'.00000000.json');await fs.writeFile(partial,'partial',{flag:'wx'});await assert.rejects(restarted.stage(plan(partialId)));assert.equal(await fs.readFile(partial,'utf8'),'partial');
 await fs.rename(dir,path.join(root,'journal-old'));await fs.mkdir(dir);await assert.rejects(restarted.recover(id,3));
});
