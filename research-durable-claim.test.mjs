import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {claim,inspect} from './lib/research-durable-claim.mjs';
const id='a'.repeat(32), request=Buffer.from('immutable request');
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'buildx-claim-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
for(const mode of ['before_publish','after_publish'])test(`process termination ${mode} blocks another claim`,async t=>{
 const root=await fixture(t),signal=path.join(root,'calls');
 const child=fork(new URL('./test-support/research-claim-child.mjs',import.meta.url),[root,id,signal,mode],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('child exited before claim')));});
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
 assert.equal((await inspect(root,id)).state,'unknown');
 await assert.rejects(claim(root,id,request),{code:'EEXIST'});
 let calls='';try{calls=await readFile(signal,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 assert.equal(calls,mode==='after_publish'?'published\n':'');
});
test('incomplete claim blocks reuse and corrupted record fails closed',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,id));
 assert.deepEqual(await inspect(root,id),{state:'unknown',id,digest:null});
 await assert.rejects(claim(root,id,request),{code:'EEXIST'});
 await writeFile(path.join(root,id,'request.json'),'corrupt');
 await assert.rejects(inspect(root,id));
});
test('concurrent claims have exactly one winner',async t=>{
 const root=await fixture(t),results=await Promise.allSettled([claim(root,id,request),claim(root,id,request)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
});
