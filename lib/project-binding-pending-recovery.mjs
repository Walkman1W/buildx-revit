// Closed recovery entry: derive the original record and outcome from trusted
// on-disk state; callers cannot select a new ID or supply a receipt.
import path from 'node:path';import {createHash} from 'node:crypto';
import {createResearchScopeOwner} from './research-scope-owner.mjs';import {recoverOriginal,recoveryVerifier} from './research-recovery-adapter.mjs';
const scope=Object.freeze({document:'all-project-binding-documents',operation:'bind_existing_project_parameter'});
const scopeKey=createHash('sha256').update(JSON.stringify([scope.document,scope.operation])).digest('hex');
export async function recoverPendingProjectBinding(root){
 if(!path.isAbsolute(root??''))return {state:'unknown'};
 const lookup=createResearchScopeOwner(root,async()=>false),pending=await lookup.pending(scope);if(!pending.id)return {state:'unknown'};
 const record=path.join(root,'records',pending.id+'.json'),result=recoverOriginal(record);
 if(!['committed','rolled_back'].includes(result.state)||result.id!==pending.id||result.digest!==pending.digest)return {state:'unknown',id:pending.id};
 const owner=createResearchScopeOwner(root,recoveryVerifier(record));
 if(!await owner.settle(scope,{id:pending.id,digest:pending.digest,scopeKey,outcome:result.state}))return {state:'unknown',id:pending.id};
 return {state:result.state,id:pending.id};
}
