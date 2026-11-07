import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {initializeResearchRoot,createResearchScopeOwner} from './lib/research-scope-owner.mjs';
const scope={document:'all-project-binding-documents',operation:'bind_existing_project_parameter'},oldId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',newId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('controlled ABA swap can make the research owner report a false reservation',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-aba-')),root=path.join(parent,'owner'),alternate=path.join(parent,'alternate'),held=path.join(parent,'held');t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 for(const base of [root,alternate])for(const sub of ['scopes','requests','archive','records'])await fs.mkdir(path.join(base,sub),{recursive:true});
 await initializeResearchRoot(root);const real=createResearchScopeOwner(root,async()=>false);await real.reserve(scope,oldId,Buffer.from('original'));
 // Instrument a disposable copy of the exact implementation at the three
 // path-based mutations, to deterministically schedule real directory moves.
 const source=await fs.readFile(new URL('./lib/research-scope-owner.mjs',import.meta.url),'utf8');
 const claimUrl=pathToFileURL(path.resolve('lib/research-durable-claim.mjs')).href;
 let patched=source.replace("from './research-durable-claim.mjs'",`from '${claimUrl}'`).replace('export function createResearchScopeOwner(root,verifyOriginalReceipt){','export function createResearchScopeOwner(root,verifyOriginalReceipt,around){').replace('await mkdir(lock);await verifyRoot(root);',"await around('mkdir',()=>mkdir(lock));await verifyRoot(root);").replace("const entry=await claim(path.join(root,'requests'),id,request);await verifyRoot(root);await save(path.join(lock,'owner.json'),{schema:1,key,id,digest:entry.digest});", "const entry=await around('claim',()=>claim(path.join(root,'requests'),id,request));await verifyRoot(root);await around('save',()=>save(path.join(lock,'owner.json'),{schema:1,key,id,digest:entry.digest}));");
 assert.notEqual(patched,source);const module=path.join(parent,'instrumented.mjs');await fs.writeFile(module,patched);const {createResearchScopeOwner:instrumented}=await import(pathToFileURL(module).href);
 let calls=0;const around=async(_stage,operation)=>{await fs.rename(root,held);await fs.rename(alternate,root);try{calls++;return await operation();}finally{await fs.rename(root,alternate);await fs.rename(held,root);}};
 const result=await instrumented(root,async()=>false,around).reserve(scope,newId,Buffer.from('new request'));assert.equal(result.id,newId);assert.equal(calls,3);assert.equal((await real.pending(scope)).id,oldId);
 // Successful reservation occurred entirely in the replacement, while the
 // original scope stayed occupied: this is a reproducible fail-open result.
});
