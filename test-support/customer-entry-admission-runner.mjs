// Runs in a test-owned Node process. The actual candidate entry and its complete
// production import graph execute; native processes, network and listen are denied.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import childProcess from 'node:child_process';
import http from 'node:http';
import {syncBuiltinESMExports,registerHooks,isBuiltin} from 'node:module';

const [componentRoot,evidence,scenario,allowedJson]=process.argv.slice(2);
assert.ok(['invalid-home','listen-failure'].includes(scenario));
const start=process.hrtime.bigint(),cpuStart=process.cpuUsage();
const allowed=new Set(JSON.parse(allowedJson).map(name=>pathToFileURL(path.join(componentRoot,...name.split('/'))).href)),resolved=[];
registerHooks({resolve(specifier,context,nextResolve){
  const value=nextResolve(specifier,context);
  if(isBuiltin(value.url)||value.url.startsWith('node:'))return value;
  assert.ok(allowed.has(value.url),'Import outside staged customer component');
  resolved.push(value.url);return value;
}});
const trace={scenario,listenCalls:0,nativeSpawnCalls:0,networkCalls:0,openedAuditFiles:0,confirmedAuditCloses:0};
const dataRoot=process.env.BUILDX_DATA_ROOT;
assert.equal(typeof dataRoot,'string');
const runtimeBase=path.join(dataRoot,'runtime','customer-chat');
childProcess.spawn=()=>{trace.nativeSpawnCalls++;throw new Error('Native process forbidden in entry fixture');};
childProcess.spawnSync=()=>{trace.nativeSpawnCalls++;throw new Error('Native helper forbidden in entry fixture');};
syncBuiltinESMExports();
globalThis.fetch=()=>{trace.networkCalls++;throw new Error('Network forbidden in entry fixture');};
http.Server.prototype.listen=function(){
  trace.listenCalls++;
  queueMicrotask(()=>this.emit('error',Object.assign(new Error('Fixture listen denied'),{code:'EADDRINUSE'})));
  return this;
};
const originalOpen=fs.open;
fs.open=async function(filename,...rest){
  const handle=await originalOpen.call(fs,filename,...rest),filenamePath=path.resolve(String(filename));
  if(filenamePath.startsWith(runtimeBase+path.sep)){
    trace.openedAuditFiles++;const close=handle.close.bind(handle);let confirmed=false;
    handle.close=async()=>{const result=await close();if(!confirmed){confirmed=true;trace.confirmedAuditCloses++;}return result;};
  }
  return handle;
};
let imported=false;
try{
  await import(pathToFileURL(path.join(componentRoot,'customer-server.mjs')).href);
  imported=true;
}finally{
  fs.open=originalOpen;
  trace.entryImported=imported;trace.entryExitCode=process.exitCode??0;
  trace.productionModules=[...new Set(resolved)].sort();
  trace.exactModuleGraph=JSON.stringify(trace.productionModules)===JSON.stringify([...allowed].sort());
  const componentRuntime=path.join(componentRoot,'runtime');
  try{trace.componentRuntimeCreated=(await fs.lstat(componentRuntime)).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;trace.componentRuntimeCreated=false;}
  const runDirectories=[];
  try{
    const entries=await fs.readdir(runtimeBase,{withFileTypes:true});assert.ok(entries.length<=2);
    for(const entry of entries)if(entry.isDirectory()){assert.match(entry.name,/^run-[0-9a-f-]{36}$/);runDirectories.push(entry.name);}
  }catch(error){if(error.code!=='ENOENT')throw error;}
  trace.runDirectories=runDirectories;trace.runtimeCreated=runDirectories.length!==0;
  const runtime=runDirectories.length===1?path.join(runtimeBase,runDirectories[0]):path.join(runtimeBase,'no-admitted-run');
  try{
    const raw=await fs.readFile(path.join(runtime,'lifecycle.jsonl'),'utf8');
    trace.lifecycleCodes=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).code);
  }catch(error){if(error.code!=='ENOENT')throw error;trace.lifecycleCodes=[];}
  try{trace.oldServerRecord=await fs.readFile(path.join(runtimeBase,'server.json'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;trace.oldServerRecord=null;}
  const cpu=process.cpuUsage(cpuStart),usage=process.resourceUsage();
  trace.metrics={wallMs:Number(process.hrtime.bigint()-start)/1e6,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimeMaxRssKiB:usage.maxRSS,scope:'Isolated Node only, CPU/wall since fixture imports; lifetime RSS. No process-family or token measurement.'};
  await fs.writeFile(path.join(evidence,'runner-summary.json'),JSON.stringify(trace,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(trace));
}
