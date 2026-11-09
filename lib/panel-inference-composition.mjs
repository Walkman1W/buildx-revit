import {CodexClient} from './codex-client.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from './codex-profile.mjs';
import {createManagedCodexRuntime} from './managed-codex-runtime.mjs';
import {createManagedPanelInferenceForAccount} from './managed-panel-inference.mjs';

// This is a trusted service composition boundary; no browser input selects it.
export function createPanelInferenceComposition({root,profile,modelTerminal,runtimeDependencies,accountAuth,managedDeployment=null,codexHome=null,testOnly=null}={}) {
  const options={profile,...modelTerminal===undefined?{}:{modelTerminal}};
  if(managedDeployment===null) return Object.freeze({codex:new CodexClient(root,options,runtimeDependencies),managedInference:null});
  const d=managedDeployment;
  if(!d||Object.getPrototypeOf(d)!==Object.prototype||!Object.isFrozen(d)||Reflect.ownKeys(d).sort().join(',')!=='model,origin'||
     !['origin','model'].every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(d,key),'value'))||
     typeof d.origin!=='string'||typeof d.model!=='string'||!d.model||profile!==MODEL_WORKSPACE_SESSION_PROFILE||
     !accountAuth||!Object.isFrozen(accountAuth)||typeof codexHome!=='string'||!codexHome||
     !runtimeDependencies||typeof runtimeDependencies!=='object'||Object.hasOwn(runtimeDependencies,'apiProvider')||Object.hasOwn(runtimeDependencies,'apiProviderFactory'))
    throw new Error('Invalid managed inference composition');
  let codex;
  const managedInference=createManagedPanelInferenceForAccount({accountAuth,isCurrent:({account,connection})=>{
    const state=codex?.state,meta=state?.codexAccount;
    return Boolean(account?.verified===true&&state?.ready===true&&!state.error&&meta?.status==='verified'&&meta.type==='api_key'&&
      state.connectionGeneration===connection?.generation&&meta.connectionGeneration===connection.generation&&
      meta.accountRevision===connection.revision&&meta.providerId===connection.providerId&&
      meta.providerRevision===connection.providerRevision&&meta.model===connection.model&&meta.model===d.model);
  }});
  const factory=createManagedCodexRuntime({model:d.model,codexHome,origin:d.origin,
    getCloudAuthorization:options=>managedInference.getCloudAuthorization(options),testOnly});
  codex=new CodexClient(root,options,{...runtimeDependencies,apiProviderFactory:factory});
  return Object.freeze({codex,managedInference});
}
