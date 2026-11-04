// Isolated acceptance surface. No native Codex, provider, or Revit process is
// started or queried. Production HTTP/SSE and browser assets are used unchanged.
import {createInterface} from 'node:readline';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const fixture=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,autoReply:true,
  invokeReadonlyCommand:async(command,parameters)=>({ok:true,value:{command,tool:command==='document'?'revit_workbench_status':command,
    operation:'status',hostSession:'isolated-preview',document:{title:'隔离界面验收样例',path:''},requestIds:[],
    data:command==='document'?{activeView:{id:'12',type:'ThreeD'},modified:false,coverage:{kind:'fixture',complete:true}}:{parameters,notice:'仅用于界面验收，未读取实际Revit。'}}})});
const input=createInterface({input:process.stdin});let closing=false;
const close=async()=>{if(closing)return;closing=true;clearTimeout(deadline);input.close();await fixture.close();};
const deadline=setTimeout(()=>void close(),15*60*1000);
input.on('line',line=>{if(line.trim()==='close')void close();});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
console.log(JSON.stringify({origin:fixture.origin,scope:'isolated production HTTP/SSE/browser assets with controlled upstream',nativeCodexProcesses:0,realRevitReads:0,realAccountRequests:0}));
