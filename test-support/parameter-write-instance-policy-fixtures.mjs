import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SOURCE_DOCUMENT,singleParameterWriteFixture,writeEnvelope} from './native-single-parameter-write-fixtures.mjs';

export {SOURCE_DOCUMENT};
export const BATCH_TOOL='revit_set_parameters',BATCH_OPERATION='set_parameters';
export const batchChange=(patch={})=>({element_id:100,parameter_id:1,value:2,value_unit:'internal',...patch});
export const batchArguments=(patch={})=>({expected_document:SOURCE_DOCUMENT.path,changes:[batchChange()],...patch});
export const policyHost=(patch={})=>({sessionId:SOURCE_DOCUMENT.session,pid:process.pid,version:'0.8.7',
  parameterWriteTargetPolicyVersion:1,parameterWriteTargetPolicy:'instance_only',...patch});
export const batchValue=args=>({updated_count:args.changes.length,changes:args.changes.map(change=>({
  element_id:change.element_id,parameter_id:change.parameter_id,storage_type:'Double',data_type:'length',
  changed:change.value!==1,before_internal:1,after_internal:change.value,
}))});
export function batchEnvelope(request,{value=batchValue(request.args),failure}={}){
  const envelope=writeEnvelope(request,{value,failure});
  if(envelope.ok)envelope.result.operation=BATCH_OPERATION;
  return envelope;
}
// Reuse the existing physical-directory, retained-owner and MCP peer. It copies
// only production source into its own temporary tree and checks identity before
// cleanup; this wrapper supplies the distinct legacy wire contract and policy.
export async function parameterWritePolicyFixture(t,{hostPatch={},respondEnvelope,...options}={}){
  return singleParameterWriteFixture(t,{...options,hostPatch:{...policyHost(),nativeParameterWritesVersion:undefined,nativeParameterWriteOperations:undefined,...hostPatch},
    operations:[BATCH_OPERATION],respondEnvelope:respondEnvelope??(request=>batchEnvelope(request))});
}
export async function assertNoBatchPublication(f){
  assert.equal(f.requests.length,0);
  for(const folder of ['inbox','processing','outbox'])assert.deepEqual(await fs.readdir(path.join(f.queue,folder)),[],folder+' must remain empty');
}
export async function replacePolicyHost(f,patch){
  await fs.writeFile(path.join(f.queue,'host.json'),JSON.stringify(policyHost(patch)));
}
