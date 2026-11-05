import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {singleParameterWriteFixture} from './native-single-parameter-write-fixtures.mjs';
import {nativeTypePreparation} from './native-type-parameter-write-approval-fixtures.mjs';
import {invokeAtomicWorkbenchRead} from '../lib/workbench-client.mjs';
import {capturePreparedTypeWrite,approvePreparedTypeWrite} from '../lib/type-parameter-write-approval.mjs';

export const TYPE_TRANSPORT_DOCUMENT=Object.freeze({session:'e'.repeat(32),title:'Type write fixture',path:'D:\\controlled\\type-write.rvt'});
export const typeTransportHost=(patch={})=>({sessionId:TYPE_TRANSPORT_DOCUMENT.session,pid:process.pid,version:'0.8.8',atomicReadSnapshot:true,
  nativeParameterQueriesVersion:1,nativeParameterQueryOperations:['get_type_parameter_impact'],nativeTypeParameterWritesVersion:1,nativeTypeParameterWriteOperations:['set_type_parameter'],...patch});
export const typeTransportArguments=(patch={})=>({expected_document:TYPE_TRANSPORT_DOCUMENT.path,mode:'rollback',type_id:'1000',parameter_id:'-123',value:2,value_unit:'internal',
  expected_state:{storage_type:'Double',has_value:true,value_internal:1,data_type:'length'},expected_instance_ids:['100','101'],...patch});
export function typeTransportValue(args){const before=structuredClone(args.expected_state);return {schema_version:1,target_kind:'type',before,instance_ids:[...args.expected_instance_ids],instance_count:args.expected_instance_ids.length,
  scope:'current_document_direct_type_references',indirect_effects:'not_assessed',result:{updated_count:1,changes:[{element_id:String(args.type_id),parameter_id:String(args.parameter_id),storage_type:before.storage_type,data_type:before.data_type,
    changed:before.value_internal!==args.value,before_internal:before.value_internal,after_internal:args.value}]}};}
function fakeImpact(args){return {schema_version:1,type_id:String(args.type_id),type_name:'类型中文',parameter:{parameter_id:String(args.parameter_id),name:'参数',storage_type:args.expected_state.storage_type,is_read_only:false,
  has_value:args.expected_state.has_value,data_type:args.expected_state.data_type,unit_type:args.expected_state.storage_type==='Double'?'autodesk.unit.unit:millimeters-1.0.1':null,value_internal:args.expected_state.value_internal,value_display:'304.8 mm'},
  instance_ids:[...args.expected_instance_ids],instance_count:args.expected_instance_ids.length,coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:args.expected_instance_ids.length,indirect_effects:'not_assessed'},write_authorization:'not_granted'};}
// Artificial native permits are restricted to admission/result-negative tests.
// Actual success and stale-member tests use the persistent production C# book.
export function artificialTypeWriteApproval(args=typeTransportArguments()){
  const prepared=capturePreparedTypeWrite({args,impact:fakeImpact(args),sourceDocument:TYPE_TRANSPORT_DOCUMENT,nativePreparation:nativeTypePreparation()});
  return approvePreparedTypeWrite(prepared,{args,sourceDocument:TYPE_TRANSPORT_DOCUMENT,deadline:Date.now()+50000});
}
export async function typeWriteQueueFixture(t,{nativeSession,hostPatch={},corrupt,writeBarrier,onRequest}={}){
  const observed=[],host=typeTransportHost(hostPatch),snapshot=()=>({hostSession:host.sessionId,hostVersion:host.version,document:{title:TYPE_TRANSPORT_DOCUMENT.title,path:TYPE_TRANSPORT_DOCUMENT.path,activeViewId:12,activeViewType:'ThreeD',modified:false},
    capabilities:{atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:['get_type_parameter_impact'],nativeTypeParameterWritesVersion:1,nativeTypeParameterWriteOperations:['set_type_parameter']}});
  const f=await singleParameterWriteFixture(t,{hostPatch:host,operations:['get_type_parameter_impact','set_type_parameter'],onRequest,
    respondEnvelope:async request=>{
      let native,result;
      if(request.operation==='get_type_parameter_impact'){
        if(nativeSession){native=await nativeSession.call({action:'prepare',args:request.args.type_write_proposal});observed.push({operation:request.operation,native});assert.equal(native.ok,true,JSON.stringify(native.error));}
        const impact=native?native.result.value.value:fakeImpact(request.args.type_write_proposal);
        // Queue/status metadata is controlled. Actual C# impact, native permit,
        // token book, before/after facts and write DTO are never substituted.
        result={operation:request.operation,hostSession:host.sessionId,atomicReadSnapshot:true,snapshot:snapshot(),
          value:{operation:request.operation,hostSession:host.sessionId,document:snapshot().document,modifiedByOperation:false,value:impact},
          type_write_preparation:native?native.result.type_write_preparation:nativeTypePreparation()};
      }else{
        if(nativeSession){native=await nativeSession.call({action:'write',args:request.args});observed.push({operation:request.operation,native});}
        result=native?.result??{operation:'set_type_parameter',mode:request.args.mode,committed:request.args.mode==='commit',document:TYPE_TRANSPORT_DOCUMENT.title,value:typeTransportValue(request.args)};
        if(writeBarrier)await writeBarrier;
      }
      const stamp=new Date().toISOString(),failed=native?.ok===false;
      const envelope={id:request.id,hostSession:host.sessionId,ok:!failed,completedUtc:stamp,
        timing:{schemaVersion:1,requestId:request.id,hostSession:host.sessionId,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,observedUtc:null,
          raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},
        ...failed?{error:{code:native.error.type,message:native.error.message},execution:{started:true,phase:'dispatch',reason:null}}:{result}};
      return envelope;
    },corrupt});
  const options=(extra={})=>f.options({sourceDocument:TYPE_TRANSPORT_DOCUMENT,expectedHostSession:TYPE_TRANSPORT_DOCUMENT.session,...extra});
  const prepare=async(args,extra={})=>{const result=await invokeAtomicWorkbenchRead('revit_get_type_parameter_impact',{expected_document:args.expected_document,type_id:args.type_id,parameter_id:args.parameter_id},
    options({typeWriteProposal:args,...extra}));f.remember(result.receiptOwner);return result;};
  const noRequests=async()=>{assert.equal(f.requests.length,0);for(const folder of ['inbox','processing','outbox'])assert.deepEqual(await fs.readdir(path.join(f.queue,folder)),[]);};
  const rewriteHost=async patch=>fs.writeFile(path.join(f.queue,'host.json'),JSON.stringify(typeTransportHost(patch)));
  return {...f,options,prepare,noRequests,rewriteHost,observed,host};
}
