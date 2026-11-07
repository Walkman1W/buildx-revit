import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
test('offline candidate compiles and rejects startup under all supplied arguments',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bx-service-skeleton-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const exe=path.join(dir,'candidate.exe');
 execFileSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/out:'+exe,path.resolve('research/scope-handle/ProtectedOwnerServiceCandidate.cs')]);
 for(const args of [[],['--service'],['--install'],['--unsafe-research']]){const r=spawnSync(exe,args,{encoding:'utf8'});assert.equal(r.status,6);assert.match(r.stderr,/not implemented/);}
});
