// Isolated protocol probe only: no model turn, Revit request, or global config.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const executable=process.env.BUILDX_TEST_CODEX;
if(!executable||!path.isAbsolute(executable))throw new Error('BUILDX_TEST_CODEX must be an existing absolute executable path.');
const tempRoot=path.resolve(os.tmpdir()),folder=await mkdtemp(path.join(tempRoot,'buildx-family-schema-'));
if(path.dirname(folder)!==tempRoot||!path.basename(folder).startsWith('buildx-family-schema-'))throw new Error('Invalid probe directory ownership.');
let child,closed=false,rl,termination='stdin';const pending=new Map(),started=Date.now();
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout')),ms);})]);}finally{clearTimeout(timer);}}
try{
  const environment={};for(const key of ['SystemRoot','SYSTEMROOT','PATH','Path','TEMP','TMP','USERPROFILE','WINDIR'])if(process.env[key])environment[key]=process.env[key];
  environment.CODEX_HOME=folder;
  child=spawn(executable,['app-server','--listen','stdio://','--strict-config'],{cwd:folder,env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const completion=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
  await bounded(once(child,'spawn'),10000,'spawn');
  rl=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
  rl.on('line',line=>{let frame;try{frame=JSON.parse(line);}catch{return;}const waiter=pending.get(frame.id);if(!waiter)return;pending.delete(frame.id);if(frame.error)waiter.reject(new Error('protocol error '+frame.error.code));else waiter.resolve(frame.result);});
  child.stderr.resume();
  let sequence=0;
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},30000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  await request('initialize',{clientInfo:{name:'buildx_schema_probe',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const profile=createCodexSessionProfile(folder,{profile:MODEL_WORKSPACE_SESSION_PROFILE}),tools=profile.familyLifecycleDynamicTools;
  const tool=tools.find(item=>item.name==='buildx_model_operation');
  const names=tool?.inputSchema?.properties?.tool?.enum;
  if(!Array.isArray(names)||names.length!==18||!['revit_family_save_job','revit_family_close_job'].every(name=>names.includes(name)))throw new Error('Extended schema does not contain the exact supported operations.');
  const result=await request('thread/start',{cwd:folder,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,dynamicTools:tools});
  if(typeof result?.thread?.id!=='string'||!result.thread.id)throw new Error('thread/start did not acknowledge the isolated schema.');
  child.stdin.end();try{await bounded(completion,3000,'child close');}catch{termination='owned_child_stop';child.kill();await bounded(completion,10000,'owned child stop');}
  console.log(JSON.stringify({ok:true,dynamicToolCount:tools.length,modelOperationCount:names.length,elapsedMs:Date.now()-started,modelTurns:0,revitRequests:0,childClosed:closed,termination}));
}finally{
  rl?.close();
  if(child&&!closed){child.kill();try{await bounded(once(child,'close'),3000,'child close');}catch{}}
  if(closed)await rm(folder,{recursive:true,force:true});
}
