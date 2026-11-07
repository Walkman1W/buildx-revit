import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';
test('relative native open follows the retained root object during path replacement',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-relative-')),root=path.join(base,'root'),moved=path.join(base,'moved'),exe=path.join(base,'probe.exe');t.after(()=>fs.rm(base,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'child'),{recursive:true});execFileSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/out:'+exe,path.resolve('tools/project-binding-relative-handle-probe.cs')]);
 const p=spawn(exe,[root,'child']);let output='',errors='';p.stderr.on('data',b=>errors+=b);await new Promise((resolve,reject)=>{p.stdout.on('data',b=>{output+=b;if(output.includes('ROOT_OPEN'))resolve();});p.once('error',reject);p.once('exit',code=>{if(!output.includes('ROOT_OPEN'))reject(Error('early exit '+code));});});
 await fs.rename(root,moved);await fs.mkdir(path.join(root,'child'),{recursive:true});p.stdin.end('\n');const code=await new Promise(resolve=>p.once('exit',resolve));assert.equal(code,0,errors);assert.match(output,/moved\\child/i);
});
