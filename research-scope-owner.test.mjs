import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createResearchScopeOwner} from './lib/research-scope-owner.mjs';
const scope={document:'session/document',operation:'batch'},id='a'.repeat(32),id2='b'.repeat(32),bytes=Buffer.from('request');
const key=createHash('sha256').update(JSON.stringify([scope.document,scope.operation])).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'buildx-scope-'));for(const dir of ['scopes','requests','archive'])await mkdir(path.join(root,dir));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('restart blocks another ID until original verified terminal receipt',async t=>{
 const root=await fixture(t);let verified=false;const owner=createResearchScopeOwner(root,async()=>verified);const entry=await owner.reserve(scope,id,bytes);
 const restarted=createResearchScopeOwner(root,async()=>verified);
 await assert.rejects(restarted.reserve(scope,id2,bytes),{code:'EEXIST'});
 const receipt={id,digest:entry.digest,scopeKey:key,outcome:'committed'};
 assert.equal(await restarted.settle(scope,null),false);
 assert.equal(await restarted.settle(scope,{...receipt,id:id2}),false);
 assert.equal(await restarted.settle(scope,{...receipt,digest:'0'.repeat(64)}),false);
 assert.equal(await restarted.settle(scope,receipt),false);
 assert.equal((await restarted.pending(scope)).state,'unknown');
 verified=true;assert.equal(await restarted.settle(scope,receipt),true);
 await restarted.reserve(scope,id2,bytes);
});
test('corruption and partial reservation never unlock scope',async t=>{
 const root=await fixture(t);const owner=createResearchScopeOwner(root,async()=>true);const entry=await owner.reserve(scope,id,bytes);
 await writeFile(path.join(root,'requests',id,'request.json'),'corrupted');
 assert.deepEqual(await owner.pending(scope),{state:'unknown'});
 assert.equal(await owner.settle(scope,{id,digest:entry.digest,scopeKey:key,outcome:'committed'}),false);
 await assert.rejects(owner.reserve(scope,id2,bytes),{code:'EEXIST'});
});
test('terminated owner process leaves scope blocked to new process and new ID',async t=>{
 const root=await fixture(t);
 const {fork}=await import('node:child_process');
 const child=fork(new URL('./test-support/research-scope-child.mjs',import.meta.url),[root,id],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('child exited before reserve')));});
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
 const fresh=createResearchScopeOwner(root,async()=>false);
 assert.equal((await fresh.pending(scope)).id,id);
 await assert.rejects(fresh.reserve(scope,id2,bytes),{code:'EEXIST'});
});
