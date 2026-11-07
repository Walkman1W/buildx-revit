import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {initializeResearchRoot} from '../../lib/research-scope-owner.mjs';

test('untrusted replacement of root and identity defeats restart pin and must block production', async t => {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'bx-anchor-attack-'));
 const root=path.join(base,'root'), exe=path.join(base,'u.exe');
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 async function setup(){for(const d of ['queue/inbox','queue/outbox','scopes','requests','archive','records']) await fs.mkdir(path.join(root,d),{recursive:true}); await fs.writeFile(path.join(root,'queue/host.json'),'host'); await fs.writeFile(path.join(root,'queue/inbox/request.json'),'request'); await initializeResearchRoot(root);}
 await setup();
 execFileSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/r:System.Web.Extensions.dll','/out:'+exe,path.resolve('research/scope-handle/UnifiedRoot.cs')]);
 const p=spawn(exe,[root]); let err='';p.stderr.on('data',x=>err+=x);
 await new Promise((resolve,reject)=>{p.stdout.on('data',x=>{if(String(x).includes('READY'))resolve()});p.once('exit',()=>reject(Error(err)));});
 p.kill();await new Promise(r=>p.once('exit',r));
 assert.equal((await fs.stat(path.join(root,'scope.lock'))).isFile(),true);
 await fs.rename(root,root+'.old');await fs.rename(root+'.identity',root+'.identity.old');await setup();
 const replacement=spawnSync(exe,[root],{input:'\n',encoding:'utf8'});
 assert.equal(replacement.status,0, replacement.stderr);
 assert.match(replacement.stdout,/READY/);
 assert.equal((await fs.stat(path.join(root,'scope.lock'))).isFile(),true);
});
