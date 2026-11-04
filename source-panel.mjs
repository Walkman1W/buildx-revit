import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexClient} from './lib/codex-client.mjs';
import {SOURCE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import {createPanelAudit} from './lib/panel-audit.mjs';

// Independent development origin and runtime record. This entry never connects
// to, resets, or writes the customer/model panel's sessions or server.json.
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const runtime=path.join(ROOT,'runtime','source-development');
const lifecycle=createPanelAudit(runtime,{service:'buildx-source-panel'});
const codex=new CodexClient(ROOT,{profile:SOURCE_SESSION_PROFILE});
const app=createPanelServer({root:ROOT,codex,profile:SOURCE_SESSION_PROFILE,port:41874,auditLifecycle:lifecycle});
try{
  const address=await app.listen();
  await fs.mkdir(runtime,{recursive:true});
  await fs.writeFile(path.join(runtime,'server.json'),JSON.stringify({service:'buildx-source-panel',profile:SOURCE_SESSION_PROFILE,
    pid:process.pid,...address,startedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({service:'buildx-source-panel',...address}));
  lifecycle.audit('lifecycle.jsonl',{code:'service_started',pid:process.pid,reason:'startup'},true);
  void app.connect();
}catch{
  console.error(JSON.stringify({service:'buildx-source-panel',error_code:'startup_failed'}));
  lifecycle.audit('lifecycle.jsonl',{code:'service_start_failed',pid:process.pid},true);process.exitCode=1;try{await app.close();}catch{console.error(JSON.stringify({service:'buildx-source-panel',error_code:'service_cleanup_pending'}));}await lifecycle.flush();
}
let signalClose=null;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(signalClose)return;lifecycle.audit('lifecycle.jsonl',{code:'service_stopping',pid:process.pid,reason:signal},true);signalClose=app.close().then(()=>console.log(JSON.stringify({service:'buildx-source-panel',code:'service_closed'}))).catch(()=>{process.exitCode=1;console.error(JSON.stringify({service:'buildx-source-panel',error_code:'service_cleanup_pending'}));}).finally(()=>{signalClose=null;});});
