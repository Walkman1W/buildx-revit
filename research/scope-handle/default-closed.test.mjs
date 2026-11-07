import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {initializeResearchRoot,createResearchScopeOwner} from '../../lib/research-scope-owner.mjs';

test('untrusted root and replaced anchor remain closed across processes',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'bx-closed-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'root'),exe=path.join(base,'scope.exe');await fs.mkdir(root);
 const env={...process.env};delete env.BUILDX_UNSAFE_SCOPE_RESEARCH;
 execFileSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/r:System.Web.Extensions.dll','/out:'+exe,path.resolve('research/scope-handle/ScopeHandle.cs')]);
 await assert.rejects(initializeResearchRoot(root),/unavailable/);
 assert.throws(()=>createResearchScopeOwner(root,()=>true),/unavailable/);
 for(const mode of ['claim','release']) assert.equal(spawnSync(exe,[root,mode],{env,input:'\n'}).status,6);
 await fs.rename(root,path.join(base,'old'));await fs.mkdir(root);await fs.writeFile(root+'.identity','{}');
 const processes=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{const p=spawn(exe,[root,'claim'],{env,stdio:['pipe','ignore','ignore']});p.once('error',reject);p.once('exit',resolve);p.stdin.end('\n')})));
 assert.deepEqual(processes,Array(8).fill(6));
 assert.deepEqual(await fs.readdir(root),[]);
 await assert.rejects(fs.stat(path.join(base,'old','scope.lock')));
});
