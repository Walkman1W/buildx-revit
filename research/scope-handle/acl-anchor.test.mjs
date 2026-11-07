import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
test('same user can rewrite owner-controlled ACL and anchor',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'bx-acl-test-')),file=path.join(base,'anchor.txt');let cleaned=false,sid;
 t.after(async()=>{try{if(sid)assert.equal(spawnSync('icacls.exe',[base,'/grant:r',`*${sid}:(F)`]).status,0);for(const name of await fs.readdir(base))if(sid)assert.equal(spawnSync('icacls.exe',[path.join(base,name),'/grant:r',`*${sid}:(F)`]).status,0);await fs.rm(base,{recursive:true,force:true});cleaned=true;}finally{assert.equal(cleaned,true);await assert.rejects(fs.stat(base));}});
 await fs.writeFile(file,'original');const ps=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8'});assert.equal(ps.status,0);sid=ps.stdout.trim();assert.match(sid,/^S-1-\d+(?:-\d+)+$/);
 const acl=(...args)=>spawnSync('icacls.exe',[file,...args],{encoding:'utf8'});assert.equal(acl('/inheritance:r','/grant:r',`*${sid}:(R)`).status,0);
 const child=(script)=>spawnSync(process.execPath,['-e',script,file],{encoding:'utf8'});
 assert.equal(child("require('fs').readFileSync(process.argv[1],'utf8')==='original'?process.exit(0):process.exit(3)").status,0);
 assert.notEqual(child("try{require('fs').writeFileSync(process.argv[1],'changed');process.exit(0)}catch{process.exit(7)}").status,0);
 // The same account owns the file and can rewrite its discretionary ACL.
 assert.equal(acl('/grant:r',`*${sid}:(F)`).status,0);assert.equal(child("require('fs').writeFileSync(process.argv[1],'changed')").status,0);assert.equal(await fs.readFile(file,'utf8'),'changed');
 assert.equal(acl('/grant:r',`*${sid}:(R)`).status,0);assert.notEqual(child("try{require('fs').writeFileSync(process.argv[1],'again');process.exit(0)}catch{process.exit(7)}").status,0);assert.equal(child("process.exit(require('fs').readFileSync(process.argv[1],'utf8')==='changed'?0:3)").status,0);
 // Parent directory rights can also allow renaming the protected file.
 await fs.rename(file,path.join(base,'renamed.txt'));await fs.writeFile(file,'replacement');assert.equal(await fs.readFile(file,'utf8'),'replacement');
 assert.equal(spawnSync('icacls.exe',[base,'/inheritance:r','/grant:r',`*${sid}:(RX)`]).status,0);assert.notEqual(child("try{require('fs').writeFileSync(require('path').join(process.argv[1],'new'),'x');process.exit(0)}catch{process.exit(7)}".replace('process.argv[1]',JSON.stringify(base))).status,0);assert.equal(spawnSync('icacls.exe',[base,'/grant:r',`*${sid}:(F)`]).status,0);await fs.writeFile(path.join(base,'new'),'x');
});
