import path from 'node:path';
import {lstat,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {createManagedInferenceRelay} from './managed-inference-relay.mjs';
import {createManagedCodexProvider} from './managed-codex-provider.mjs';
import {MANAGED_WORKBENCH_PILOT_REQUEST_POLICY} from './managed-workbench-reads.mjs';

// Composition belongs to trusted application code, not a panel request. The
// relay itself restricts testOnly transports to a literal loopback address.
export function createManagedCodexRuntime({model,codexHome,origin=null,getCloudAuthorization,testOnly=null,workbenchPilot=false}={}) {
  if(typeof workbenchPilot!=='boolean')throw new Error('Invalid managed Codex request policy');
  async function open() {
    if(typeof codexHome!=='string'||!path.isAbsolute(codexHome))throw new Error('Invalid managed Codex profile root');
    const profileRoot=await realpath(codexHome);
    let provider,profile,relay,workspace;
    async function removeProfile() {
      if(!profile)return;
      const stat=await lstat(profile).catch(error=>{
        if(error.code==='ENOENT')return null;
        throw error;
      });
      if(!stat)return;
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.dirname(profile)!==profileRoot||await realpath(profile)!==profile)
        throw new Error('Managed Codex profile ownership changed');
      await rm(profile,{recursive:true,force:true,maxRetries:2});
    }
    try {
      // A new home prevents user MCP and auth configuration from being loaded.
      profile=await mkdtemp(path.join(profileRoot,'buildx-managed-'));
      const home=workbenchPilot?path.join(profile,'home'):profile;
      if(workbenchPilot){
        workspace=path.join(profile,'workspace');
        await mkdir(home);
        await mkdir(workspace);
      }
      relay=await createManagedInferenceRelay({getCloudAuthorization,origin,testOnly,workbenchPilot,pilotWorkspace:workspace});
      provider = createManagedCodexProvider({relay,model,codexHome:home});
    } catch (error) {
      try{await relay?.close();}finally{await removeProfile();}
      throw error;
    }
    let closing,closed=false;
    const ownedProvider=Object.freeze({...provider,dispose(){
      provider.dispose();
      // Reject new relay requests as soon as child shutdown begins. Final
      // release still waits for the relay and for confirmed child exit.
      void relay.close().catch(()=>{});
    }});
    function close() {
      if (!closed&&!closing) {
        closing = (async () => {
          try { ownedProvider.dispose(); } finally { await relay.close(); }
          await removeProfile();
          closed=true;
          return Object.freeze({closed:true});
        })().catch(error=>{closing=null;throw error;});
      }
      return closing;
    }
    return Object.freeze({provider:ownedProvider,close,...workspace?{cwd:workspace}:{}});
  }
  return Object.freeze({open,...workbenchPilot?{requestPolicy:MANAGED_WORKBENCH_PILOT_REQUEST_POLICY}:{}});
}
