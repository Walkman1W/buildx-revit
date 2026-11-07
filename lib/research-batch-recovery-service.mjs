// Isolated fixture recovery only. The caller must own the recovery root; this
// API never accepts a caller-supplied request, outcome, or receipt.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createResearchScopeOwner} from './research-scope-owner.mjs';
import {recoverOriginal,recoveryVerifier} from './research-batch-recovery-adapter.mjs';
const scope=Object.freeze({document:'all-batch-filter-documents',operation:'batch_set_parameters_by_filter'});
const scopeKey=createHash('sha256').update(JSON.stringify([scope.document,scope.operation])).digest('hex');
export async function recoverBatchOriginal(root){
 if(!path.isAbsolute(root))throw new Error('Absolute owned research root required');
 const finder=createResearchScopeOwner(root,async()=>false),pending=await finder.pending(scope);
 if(!pending.id||!pending.digest)return Object.freeze({state:'unknown',released:false});
 const record=path.join(root,'records',pending.id+'.json'),result=recoverOriginal(record);
 if(!['committed','rolled_back'].includes(result.state)||result.id!==pending.id||result.digest!==pending.digest)return Object.freeze({state:'unknown',released:false,requestId:pending.id});
 const owner=createResearchScopeOwner(root,recoveryVerifier(record));
 const released=await owner.settle(scope,{id:pending.id,digest:pending.digest,scopeKey,outcome:result.state});
 return Object.freeze({state:released?result.state:'unknown',released,requestId:pending.id});
}
