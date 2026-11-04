import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {invokeWorkbench} from './lib/workbench-client.mjs';
import {assertFamilyTemplateBytePreflight} from './lib/family-template-preflight.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const sample=path.join(root,'workbench','samples','Argus-Codex-Plumbing-Sample.rvt');
const flags=new Set(process.argv.slice(2));
if([...flags].some(f=>!['--apply','--commit-load'].includes(f)))throw new Error('Usage: node validate-family-workflow.mjs [--apply] [--commit-load]');
if(flags.has('--commit-load')&&!flags.has('--apply'))throw new Error('--commit-load requires --apply');
const output=path.join(root,'workbench','validation','20261024-family-workflow','live-'+new Date().toISOString().replaceAll(/[:.]/g,'')+'-'+randomUUID().slice(0,8));
await fs.mkdir(output,{recursive:true});
const summary={startedUtc:new Date().toISOString(),scope:flags.has('--apply')?'sample-family-create-save-load':'read-only-preflight',sample,steps:[],success:false,job_handle:null,revitProjectSaved:false,artifactNotSubjectToProjectRollback:true};
async function write(){await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));}
async function call(name,args={}){
  const startedUtc=new Date().toISOString();
  const result=await invokeWorkbench(name,args);
  const file=String(summary.steps.length+1).padStart(2,'0')+'-'+name+'.json';
  await fs.writeFile(path.join(output,file),JSON.stringify(result,null,2));
  summary.steps.push({name,startedUtc,completedUtc:new Date().toISOString(),receipt:file,request_id:result.request_id});
  if(result.value?.job_handle)summary.job_handle=result.value.job_handle;
  await write();
  if(name.startsWith('revit_family_')&&result.value?.success!==true)throw new Error('Business stage did not confirm success; inspect the retained receipt, do not replay: '+file);
  return result;
}
try{
  const status=await call('revit_workbench_status');
  if(!status.document?.allowedSample||path.win32.normalize(status.document.path).toLowerCase()!==path.win32.normalize(sample).toLowerCase())throw new Error('The exact writable sample must already be active; no model operation submitted');
  if(!/^0\.(?:[6-9]|[1-9][0-9]+)\./.test(status.hostVersion||''))throw new Error('Revit host 0.6.0+ required; no family operation submitted');
  summary.hostSession=status.hostSession;summary.hostVersion=status.hostVersion;
  const templates=await call('revit_family_templates');
  summary.templatePreflight=assertFamilyTemplateBytePreflight(templates);
  await write();
  if(flags.has('--apply')){
    const created=await call('revit_family_create_valve',{expected_document:sample,template_id:'metric-generic-model',length_mm:300,diameter_mm:100});
    const job_handle=created.value.job_handle;if(!job_handle)throw new Error('Created receipt lacks a job handle; do not replay');
    await call('revit_family_inspect_job',{job_handle});
    const saved=await call('revit_family_save_job',{expected_document:sample,job_handle});
    if(saved.value.save?.independently_reopened_verified!==true)throw new Error('Saved RFA independent reopen was not confirmed');
    summary.rfa=saved.value.save;
    const loaded=await call('revit_family_load_job',{expected_document:sample,job_handle,mode:'rollback'});
    if(loaded.value.effects?.project_load?.rollback_independently_verified!==true)throw new Error('Load rollback independent readback was not confirmed');
    if(flags.has('--commit-load'))await call('revit_family_load_job',{expected_document:sample,job_handle,mode:'commit'});
    await call('revit_family_close_job',{job_handle});
  }
  summary.success=true;summary.completedUtc=new Date().toISOString();await write();
  console.log(JSON.stringify({success:true,scope:summary.scope,evidence:output,rfa:summary.rfa?.path||null}));
}catch(error){
  summary.error=String(error.message);summary.completedUtc=new Date().toISOString();summary.doNotReplayUnknown=true;await write();
  console.error(JSON.stringify({success:false,error:summary.error,job_handle:summary.job_handle,evidence:output}));process.exitCode=1;
}
