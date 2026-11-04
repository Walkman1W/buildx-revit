import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildSnapshot,verifySnapshot} from './build-brain-candidate.mjs';

test('snapshot only contains explicit files and rejects changes and unexpected additions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'build-brain-candidate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const src=path.join(root,'src'),out=path.join(root,'out');await fs.mkdir(src);await fs.writeFile(path.join(src,'allowed.mjs'),'export const value=1;');await fs.writeFile(path.join(src,'secret.txt'),'excluded');
 const trusted={expectedFiles:['allowed.mjs'],expectedWhitelistSha256:'fixture'};
 const m=await buildSnapshot({sourceRoot:src,output:out,files:['allowed.mjs'],whitelistSha256:'fixture'});assert.equal(m.installable,false);assert.equal((await verifySnapshot(out,trusted)).files,1);await assert.rejects(fs.stat(path.join(out,'source','secret.txt')),{code:'ENOENT'});
 await assert.rejects(verifySnapshot(out,{expectedFiles:['different.mjs'],expectedWhitelistSha256:'fixture'}),/trusted whitelist/);
 await fs.writeFile(path.join(out,'source','extra.txt'),'unexpected');await assert.rejects(verifySnapshot(out,trusted),/inventory/);await fs.unlink(path.join(out,'source','extra.txt'));await fs.writeFile(path.join(out,'source','allowed.mjs'),'tampered');await assert.rejects(verifySnapshot(out,trusted),/mismatch/);
 await assert.rejects(buildSnapshot({sourceRoot:src,output:out,files:['allowed.mjs']}),{code:'EEXIST'});await assert.rejects(buildSnapshot({sourceRoot:src,output:path.join(root,'bad'),files:['../secret.txt']}),/invalid whitelist/);
});
