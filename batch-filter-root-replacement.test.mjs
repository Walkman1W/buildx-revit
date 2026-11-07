import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createResearchScopeOwner,initializeResearchRoot} from './lib/research-scope-owner.mjs';

test('replaced recovery root rejects new claim and cannot clear unknown',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-batch-root-swap-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'root'),old=path.join(base,'old'),scope={document:'all-batch-filter-documents',operation:'batch_set_parameters_by_filter'};
 const initialize=async p=>{for(const d of ['scopes','requests','archive','records'])await fs.mkdir(path.join(p,d),{recursive:true});};
 await initialize(root);await initializeResearchRoot(root);const first=createResearchScopeOwner(root,async()=>false);await first.reserve(scope,'11111111-1111-4111-8111-111111111111',Buffer.from('original request'));
 await fs.rename(root,old);await initialize(root);const replacement=createResearchScopeOwner(root,async()=>false);
 await assert.rejects(replacement.reserve(scope,'22222222-2222-4222-8222-222222222222',Buffer.from('new request')));
 assert.deepEqual(await first.pending(scope),{state:'unknown'});await assert.rejects(initializeResearchRoot(root),{code:'EEXIST'});
});
