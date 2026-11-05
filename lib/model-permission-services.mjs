import {invokeAtomicWorkbenchRead,workbenchFailureEvidence,nativeAccessPolicyBinding} from './workbench-client.mjs';
import {workbenchDocumentIdentity} from './workbench-contracts.mjs';
import {invokeModelTool} from './model-tool-dispatch.mjs';
import {preparedTypeWriteReview} from './type-parameter-write-approval.mjs';

// Trusted composition for the panel's permission owner. A failed invocation
// can own an original transport receipt; propagate that handle separately.
export function createModelPermissionServices({observe=invokeAtomicWorkbenchRead,invoke=invokeModelTool,timingControl=value=>value}={}){
  if(typeof observe!=='function'||typeof invoke!=='function'||typeof timingControl!=='function')throw new TypeError('Invalid model permission services');
  return Object.freeze({
    async observeDocument(control={}){
      const policy=nativeAccessPolicyBinding(control.accessPolicy);
      const status=await observe('revit_workbench_status',{},timingControl(control));
      const document=workbenchDocumentIdentity(status);
      if(!document.path||!document.title)throw new Error('当前模型尚未保存或无法核实。');
      if(policy){
        const access=status.document.access,observed=access?.policy;
        if(status.capabilities?.accessPolicyVersion!==1||access?.schemaVersion!==1||!observed||observed.id!==policy.id||observed.revision!==policy.revision||observed.accountScope!==policy.accountScope||control.accessPolicy.mode!==undefined&&observed.mode!==control.accessPolicy.mode)
          throw new Error('Revit 宿主未核实当前访问策略；请加载新宿主或重新选择权限。');
        if(access.allowed!==true)throw new Error('当前访问权限不允许编辑此模型：'+String(access.reason||'unknown')+'。');
      }else if(status.document.allowedSample!==true)throw new Error('当前模型不在 Revit 工作台允许的模型范围内。');
      return document;
    },
    // Resolve only the exact content-addressed revision; the command owner
    // validates its digest both here and when it is later executed.
    async readCommand({command_id,revision},control={}){
      return invoke('revit_get_command',{command_id,revision},timingControl(control));
    },
    async inspectFamilyJob(job_handle,control={}){
      return invoke('revit_family_inspect_job',{job_handle},timingControl(control));
    },
    async prepareTypeParameterWrite(args,control={}){
      const sourceDocument=control.sourceDocument;
      let result;
      try{
        result=await observe('revit_get_type_parameter_impact',{type_id:args.type_id,parameter_id:args.parameter_id,expected_document:args.expected_document},
          timingControl({...control,expectedHostSession:sourceDocument?.session,typeWriteProposal:args,retainReceiptOwner:true}));
        const prepared=result?.typeWritePreparation;
        preparedTypeWriteReview(prepared,{args,sourceDocument});
        if(result.receiptOwner){const closed=await result.receiptOwner.close();if(closed?.ok!==true||closed.value?.closed!==true)throw new Error('Type preparation read receipt cleanup remains unconfirmed.');}
        return prepared;
      }catch(cause){
        const facts=workbenchFailureEvidence(cause),owner=facts.receiptOwner??cause?.receiptOwner??result?.receiptOwner;
        const failure=cause instanceof Error?cause:new Error('Type preparation read remains unconfirmed.');
        if(owner&&!failure.receiptOwner)Object.defineProperty(failure,'receiptOwner',{value:owner,enumerable:false});
        if(!failure.requestId&&facts.requestIds[0])failure.requestId=facts.requestIds[0];
        throw failure;
      }
    },
    async invoke(tool,args,control){
      try{
        const value=await invoke(tool,args,timingControl(control));
        return {ok:true,value,...value?.receiptOwner?{receiptOwner:value.receiptOwner}:{}};
      }catch(error){
        const facts=workbenchFailureEvidence(error);
        const outcome=error?.commandCode||error?.interruptedBeforeEnqueue?'not_started':error?.modelOutcome??facts.outcome;
        return {ok:false,error:{outcome,message:error?.message||'模型操作结果未确认。',...typeof error?.modelStage==='string'?{stage:error.modelStage}:{}},evidence:{requestIds:facts.requestIds,...facts.nativeFailure?{nativeFailure:facts.nativeFailure}:{},...facts.unpublishedRequest?{unpublishedRequest:facts.unpublishedRequest}:{}},...(facts.receiptOwner||error?.receiptOwner?{receiptOwner:facts.receiptOwner??error.receiptOwner}:{})};
      }
    }
  });
}
