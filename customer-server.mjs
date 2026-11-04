import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createCustomerChatServer,customerChatConfiguration,customerChatLayout} from './lib/customer-chat.mjs';
import {createPanelAudit,inspectExistingPanelDirectory} from './lib/panel-audit.mjs';

// Explicit user-run candidate entry. No existing service is stopped/replaced;
// Codex is connected only after this new local listener has bound successfully.
const ROOT=path.dirname(fileURLToPath(import.meta.url));
// Application roles consume the original physical directory interpreter. These
// point-in-time facts are not a lease, a browser DTO, or authority to write.
function directoryRoles(layout){
  const values=[layout.resourceRoot,layout.dataRoot,layout.codexCwd].map(directory=>{
    const result=inspectExistingPanelDirectory(directory);
    if(!result.ok)throw new Error('Customer directory facts unavailable');
    return result.value;
  });
  const [resource,data,workspace]=values,resourceId=resource.chain.at(-1).identity,dataId=data.chain.at(-1).identity;
  if(resource.chain.some(part=>part.identity===dataId)||data.chain.some(part=>part.identity===resourceId)||
    !workspace.chain.some(part=>part.identity===dataId)||workspace.chain.some(part=>part.identity===resourceId))throw new Error('Customer directory roles overlap');
  return values;
}
function sameRoles(before,after){return before.every((role,index)=>role.chain.length===after[index].chain.length&&role.chain.every((part,n)=>part.path===after[index].chain[n].path&&part.identity===after[index].chain[n].identity));}
let app=null,configuration=null,lifecycle=null;
try{
  configuration=customerChatConfiguration();
  const requestedDataRoot=process.env.BUILDX_DATA_ROOT;
  const selected=customerChatLayout({resourceRoot:ROOT,dataRoot:requestedDataRoot});
  if(!selected.ok)throw new Error('Customer data directory is required');
  const layout=selected.value,observed=directoryRoles(layout);
  const runtime=path.join(layout.runtime,'run-'+randomUUID());
  if(runtime.length>=32767)throw new Error('Customer run directory exceeds path budget');
  lifecycle=createPanelAudit(runtime,{service:'buildx-customer-chat',requireNewDirectory:true,expectedAncestor:observed[1]});
  // Reject a changed application snapshot before app construction can admit a
  // failure log. The writer also binds this original ancestor before mkdir.
  if(!sameRoles(observed,directoryRoles(layout)))throw new Error('Customer directory identity changed before admission');
  app=createCustomerChatServer({root:ROOT,codexCwd:layout.codexCwd,accountAuth:configuration.accountAuth,auditLifecycle:lifecycle});
  const address=await app.listen();
  if(!sameRoles(observed,directoryRoles(layout)))throw new Error('Customer directory identity changed during startup');
  // Startup facts use the same bound writer; there is no second unowned
  // server.json overwrite. The explicit caller receives the address on stdout.
  lifecycle.audit('lifecycle.jsonl',{code:'service_started',pid:process.pid,reason:'startup'},true);
  console.log(JSON.stringify({service:'buildx-customer-chat',profile:'customer-chat',...address,runtimeDirectory:runtime}));
  void app.connect();
}catch{
  console.error(JSON.stringify({service:'buildx-customer-chat',error_code:'customer_startup_failed'}));
  process.exitCode=1;
  // A constructed writer is not admission: factory configuration (including
  // CODEX_HOME) may still reject. Before an app exists, report only to stderr.
  if(app)lifecycle.audit('lifecycle.jsonl',{code:'service_start_failed',pid:process.pid},true);
  try{
    if(app){if((await app.close())?.closed!==true)throw new Error('cleanup pending');}
    else{
      if(configuration){const result=await configuration.accountAuth.close();if(result?.ok!==true||result.value?.closed!==true)throw new Error('provider cleanup pending');}
      if(lifecycle&&(await lifecycle.close()).value?.closed!==true)throw new Error('audit cleanup pending');
    }
  }catch{console.error(JSON.stringify({service:'buildx-customer-chat',error_code:'service_cleanup_pending'}));}
  await lifecycle?.flush();
}
let signalClose=null;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(signalClose)return;
  lifecycle?.audit('lifecycle.jsonl',{code:'service_stopping',pid:process.pid,reason:signal},true);
  signalClose=(async()=>{
    if(app){if((await app.close())?.closed!==true)throw new Error('cleanup pending');}
    else if(lifecycle){const pending=lifecycle.state().cleanupId;if(pending&&(await lifecycle.cleanup(pending)).ok!==true)throw new Error('cleanup pending');if((await lifecycle.close()).value?.closed!==true)throw new Error('cleanup pending');}
    console.log(JSON.stringify({service:'buildx-customer-chat',code:'service_closed'}));
  })().catch(()=>{process.exitCode=1;console.error(JSON.stringify({service:'buildx-customer-chat',error_code:'service_cleanup_pending'}));}).finally(()=>{signalClose=null;});
});
