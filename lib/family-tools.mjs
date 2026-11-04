import path from 'node:path';

export const FAMILY_HOST_VERSION='0.6.0';
const expected={type:'string',minLength:1,maxLength:1024,description:'Exact saved sample document.path from current workbench status. Only Argus-Codex-Plumbing-Sample.rvt is supported in this first workflow.'};
const handle={type:'string',minLength:1,maxLength:180,description:'Opaque job_handle returned by this Revit host; never fabricate or reuse it across host sessions.'};
function contract(name,operation,description,properties,required,readOnly){
  return {name,operation,description,inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,...(!readOnly?{destructiveHint:false,idempotentHint:false}:{})}};
}
const definitions=[
  contract('revit_family_templates','family_templates','List the host-owned fixed family template IDs and fresh byte evidence. Does not open a family. A hash does not prove Revit template compatibility.',{},[],true),
  contract('revit_family_create_valve','family_create_valve','Create one job-owned parametric two-port demonstration valve in a separate family document. The target must be the exact writable sample. Creates no project instance and saves no file. Returns job_handle even when geometry fails; inspect/close that job instead of retrying unknown creation.',{expected_document:expected,template_id:{type:'string',enum:['metric-generic-model']},length_mm:{type:'number',minimum:50,maximum:2000,default:300},diameter_mm:{type:'number',minimum:10,maximum:500,default:100}},['expected_document','template_id'],false),
  contract('revit_family_create_cabinet','family_create_cabinet','Create one bounded rectangular cabinet in an independent, job-owned family document, with two doors and zero to eight shelves. Does not require, load into or change an active project, and does not save a file. Width, depth, height and thickness are millimetres. Native parameter and geometry validation determines success; inspect or close the original job on a failed or unknown outcome rather than retrying.',{template_id:{type:'string',enum:['metric-generic-model']},width_mm:{type:'number',minimum:300,maximum:5000,default:1200},depth_mm:{type:'number',minimum:150,maximum:2500,default:600},height_mm:{type:'number',minimum:300,maximum:5000,default:2200},thickness_mm:{type:'number',minimum:6,maximum:80,default:18},shelf_count:{type:'integer',minimum:0,maximum:8,default:3}},['template_id'],false),
  contract('revit_family_inspect_job','family_inspect_job','With job_handle, read the owned family job, actual parameters and job-specific shape evidence. Omit it to list bounded host-owned job records after an unknown creation response. Recorded state is not new write authorization. Does not change current view or project.',{job_handle:handle},[],true),
  contract('revit_family_save_job','family_save_job','Save a validated job family to a new non-overwriting RFA under the host family-artifacts directory, close only the owned temporary family, verify SHA and independently reopen/inspect/close that saved artifact. File save is a distinct side effect and cannot be undone by project rollback. No caller-controlled output path.',{expected_document:expected,job_handle:handle},['expected_document','job_handle'],false),
  contract('revit_family_save_cabinet','family_save_cabinet','Save the validated independent cabinet job to a new non-overwriting RFA under the host family-artifacts directory, close only its owned temporary family, verify the digest and independently reopen/inspect/close it. This file save is a separate side effect; it does not load into a project. No caller-controlled output path.',{job_handle:handle},['job_handle'],false),
  contract('revit_family_load_job','family_load_job','Load the saved verified job RFA into its exact original sample project. Reject family-name conflicts. Default rollback: read loaded family/type IDs then roll back and independently query absence/count restoration. commit keeps a loaded family in memory without saving the RVT. Does not place/connect instances.',{expected_document:expected,job_handle:handle,mode:{type:'string',enum:['rollback','commit'],default:'rollback'}},['expected_document','job_handle'],false),
  contract('revit_family_close_job','family_close_job','Close only the temporary family document owned by this job, without saving. Does not delete an already saved RFA or undo a project load. Failed cleanup retains ownership; unknown creation must not be replayed.',{job_handle:handle},['job_handle'],false),
  contract('revit_family_close_cabinet','family_close_cabinet','Close only the independently owned temporary cabinet family for the specified job, without saving. Unsaved content will be discarded. Does not delete an already saved RFA. Failed cleanup retains ownership; inspect the original job rather than retrying an unknown outcome.',{job_handle:handle},['job_handle'],false),
];
export const FAMILY_OPERATION_BY_TOOL=Object.freeze(Object.fromEntries(definitions.map(t=>[t.name,t.operation])));
export const FAMILY_TOOLS=definitions.map(({operation,...tool})=>tool);
// Until a trusted human approval owner can gate native MCP calls, these new
// file/family mutations are reachable only through the confirmed panel path.
export const FAMILY_PANEL_CONFIRMATION_ONLY=Object.freeze(['revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet']);
export const isFamilyTool=name=>Object.hasOwn(FAMILY_OPERATION_BY_TOOL,name);
export function assertFamilyArguments(name,args){
  if(!isFamilyTool(name))throw new Error('Unknown family tool');
  if(args.expected_document!==undefined){
    const value=args.expected_document;
    if(!path.win32.isAbsolute(value)||value.includes('\0')||value.startsWith('\\\\')||value.startsWith('//')||path.win32.basename(value).toLowerCase()!=='argus-codex-plumbing-sample.rvt')
      throw new Error('Family workflow requires the exact configured Argus-Codex-Plumbing-Sample.rvt; request was not queued');
  }
  if(args.job_handle!==undefined&&(!args.job_handle.trim()||/[\r\n\0]/.test(args.job_handle)))throw new Error('Invalid family job handle');
}
export function assertFamilyResult(name,result,sessionId){
  if(!result||typeof result!=='object'||result.operation!==FAMILY_OPERATION_BY_TOOL[name]||result.hostSession!==sessionId||!result.value||typeof result.value!=='object')
    throw new Error('Family result identity mismatch; outcome unknown, inspect the original queue receipt before any further operation');
}
