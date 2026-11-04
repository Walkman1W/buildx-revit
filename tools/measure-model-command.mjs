// Explicit read-only benchmark. A failed or uncertain request ends the run;
// it is never replayed to manufacture a successful performance sample.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const stage=process.argv[2];
if(!['before-061','after-064'].includes(stage))throw new Error('Choose before-061 or after-064.');
const output=path.join(root,'workbench/validation/20261028-workspace-update',stage+'-performance.json');
try{await fs.access(output);throw new Error('Preserve the original benchmark; do not overwrite it.');}catch(error){if(error.code!=='ENOENT')throw error;}
const started=performance.now(),cpuStart=process.cpuUsage();
const {invokeModelCommand}=await import('../lib/model-tool-dispatch.mjs');
const importMs=performance.now()-started,rows=[];
for(let index=0;index<6;index++){
  const t=performance.now(),cpu=process.cpuUsage();
  const result=await invokeModelCommand('document',{});
  rows.push({phase:index===0?'first-read-in-this-process':'warm',elapsedMs:performance.now()-t,nodeCpuMicros:process.cpuUsage(cpu),result});
  if(!result.ok)break;
  if(result.value.document?.title!=='项目1')break;
}
const warm=rows.filter(row=>row.phase==='warm'&&row.result.ok).map(row=>row.elapsedMs).sort((a,b)=>a-b);
const percentile=p=>warm.length?warm[Math.ceil(p*warm.length)-1]:null;
const record={schemaVersion:1,observedUtc:new Date().toISOString(),stage,command:'document',scope:'real readonly manual-command dispatcher and Revit; no AI inference',
  importMs,elapsedMs:performance.now()-started,nodeCpuMicros:process.cpuUsage(cpuStart),nodeResourceUsage:process.resourceUsage(),
  warmSamples:warm.length,warmP50Ms:percentile(.5),warmP95Ms:percentile(.95),rows,
  aiInferenceTokens:0,mcpSchemaTokenCost:'unmeasured',revitProcessFamilyCpu:'measured separately if present',revitProcessFamilyMemory:'measured separately if present'};
await fs.writeFile(output,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({output,importMs,warmSamples:warm.length,warmP50Ms:record.warmP50Ms,warmP95Ms:record.warmP95Ms,ok:rows.every(row=>row.result.ok)}));
