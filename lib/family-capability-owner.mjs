import {invokeWorkbench} from './workbench-client.mjs';

// Only the Revit host can establish this capability. An ordinary status
// fallback or a client-provided flag is not sufficient evidence.
export function createFamilyCapabilityOwner({read=invokeWorkbench,timeoutMs=1400}={}){
  if(typeof read!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new TypeError('Invalid family capability owner');
  let pending=null;
  return Object.freeze({async observe(){
    if(!pending){
      const work=Promise.resolve().then(async()=>{
        const value=await read('revit_workbench_status',{}, {atomicRead:true,timeout:timeoutMs});
        const snapshot=value?.snapshot,session=value?.hostSession;
        if(typeof session!=='string'||!/^[a-f0-9]{32}$/.test(session)||snapshot?.hostSession!==session||
          value?.capabilities?.familyLifecycleApprovalVersion!==1||snapshot?.capabilities?.familyLifecycleApprovalVersion!==1||
          snapshot?.capabilities?.atomicReadSnapshot!==true)throw new Error('Revit 族作业审批能力未核实。');
        return Object.freeze({hostSession:session,version:1});
      });
      pending=work;void work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});
    }
    return pending;
  }});
}
