import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {MODELLING_TEMPLATE_VERSION,compileModellingTool} from '../lib/modelling-tools.mjs';

const execute=promisify(execFile),project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runnerFile=path.join(project,'revit-addin','ScriptRunner.cs'),templatesFile=path.join(project,'lib','modelling-tools.mjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const error=(code,message)=>Object.assign(new Error(message),{code});
const frameworkDirectory=()=>path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');

function unique(source,marker){const at=source.indexOf(marker);if(at<0||source.indexOf(marker,at+marker.length)>=0)throw error('PRODUCTION_BOUNDARY','Missing or ambiguous ScriptRunner boundary.');return at;}
function productionFragments(source){
  const begin=unique(source,'            if (string.IsNullOrWhiteSpace(code)'),end=unique(source,'            using (Process compiler = ');
  if(end<=begin)throw error('PRODUCTION_BOUNDARY','ScriptRunner preparation no longer precedes its compiler.');
  const preparation=source.slice(begin,end);
  const document='typeof(Document).Assembly.Location',application='typeof(UIApplication).Assembly.Location';
  if(preparation.split(document).length!==2||preparation.split(application).length!==2)throw error('PRODUCTION_BOUNDARY','Actual API reference producers are ambiguous.');
  const launch=/new ProcessStartInfo\(Compiler,\s*"((?:\\.|[^"\\])*)"\s*\+\s*responseFile\s*\+\s*"((?:\\.|[^"\\])*)"\)/.exec(source);
  if(!launch||JSON.parse('"'+launch[1]+'"')!=='/noconfig @"'||JSON.parse('"'+launch[2]+'"')!=='"')throw error('PRODUCTION_LAUNCH','The production compiler must explicitly use /noconfig and its generated response file.');
  const timeout=/compiler\.WaitForExit\((\d+)\)/.exec(source);
  if(!timeout||Number(timeout[1])<1||Number(timeout[1])>60000)throw error('PRODUCTION_LAUNCH','Unsupported production compiler deadline.');
  const environment=Object.fromEntries([...source.matchAll(/compiler\.StartInfo\.EnvironmentVariables\["([^"\r\n]+)"\]\s*=\s*"([^"\r\n]*)"/g)].map(match=>[match[1],match[2]]));
  if(Object.keys(environment).some(key=>!/^COMPlus_[A-Za-z0-9_]+$/.test(key)))throw error('PRODUCTION_LAUNCH','Unexpected compiler environment contract.');
  return {preparation,controlledPreparation:preparation.replace(document,'RevitApi').replace(application,'RevitApiUi'),timeoutMs:Number(timeout[1]),environment,
    sourceEvidence:{source:'revit-addin/ScriptRunner.cs',sourceSha256:sha(source),preparationSha256:sha(preparation),
      fromLine:source.slice(0,begin).split('\n').length,toLine:source.slice(0,end).split('\n').length-1,
      substitutions:{[document]:'explicit selected RevitAPI.dll file',[application]:'explicit selected RevitAPIUI.dll file'},
      boundary:'Stop before compiler Process, Assembly.LoadFrom, generated script invocation and transactions.'}};
}

async function regularFile(filename){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw error('INPUT_FILE','Expected an existing ordinary input file.');return stat;}
async function existingDirectory(directory){
  if(!path.isAbsolute(directory)||path.parse(directory).root===directory)throw error('OUTPUT_DIRECTORY','A non-root absolute directory is required.');
  let current=path.parse(directory).root;
  for(const segment of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw error('OUTPUT_DIRECTORY','Selected paths cannot pass through links.');
  }
}
async function createNewDirectory(directory){
  if(!path.isAbsolute(directory)||path.resolve(directory)!==directory)throw error('OUTPUT_DIRECTORY','Choose a new normalized absolute output directory.');
  await existingDirectory(path.dirname(directory));
  try{await fs.lstat(directory);throw error('OUTPUT_EXISTS','Offline evidence directory already exists; nothing was overwritten.');}catch(failure){if(failure.code!=='ENOENT')throw failure;}
  await fs.mkdir(directory);
}

function harness(fragments){return `using System;using System.IO;using System.Text;using System.Diagnostics;using System.Collections.Generic;using System.Web.Script.Serialization;
internal static class WorkbenchHost { internal static string Root; }
internal static class Preparation {
 internal static string Compiler,RevitApi,RevitApiUi;
 internal static object Prepare(string code,string requestId,IDictionary<string,object> parameters) {
${fragments.controlledPreparation}
  return new {directory,source,dll,responseFile};
 }
}
internal static class Program {
 public static void Main() {
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
  var json=new JavaScriptSerializer {MaxJsonLength=1024*1024};
  var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
  try {
   Preparation.Compiler=(string)input["compilerExecutable"];Preparation.RevitApi=(string)input["revitApi"];Preparation.RevitApiUi=(string)input["revitApiUi"];WorkbenchHost.Root=(string)input["outputRoot"];
   object inspect;if(input.TryGetValue("inspectReferences",out inspect)&&inspect is bool&&(bool)inspect){Console.WriteLine(json.Serialize(new {ok=true,revitApiVersion=FileVersionInfo.GetVersionInfo(Preparation.RevitApi).FileVersion,revitApiUiVersion=FileVersionInfo.GetVersionInfo(Preparation.RevitApiUi).FileVersion}));return;}
   object value;bool parameters=input.TryGetValue("parameters",out value)&&value is bool&&(bool)value;
   var result=Preparation.Prepare((string)input["code"],(string)input["requestId"],parameters?new Dictionary<string,object>():null);
   Console.WriteLine(json.Serialize(new {ok=true,result}));
  }catch(Exception failure){Console.WriteLine(json.Serialize(new {ok=false,error=failure.GetType().Name,message=failure.Message}));}
 }
}`;}

async function createPreparationProducer(directory){
  const source=await fs.readFile(runnerFile,'utf8'),fragments=productionFragments(source),generated=path.join(directory,'preparation-producer.cs'),executable=path.join(directory,'preparation-producer.exe');
  await fs.writeFile(generated,harness(fragments),{flag:'wx'});
  const framework=frameworkDirectory();
  try{await execute(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Core.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,generated],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(failure){throw error('PREPARATION_COMPILER','Could not compile the controlled preparation producer: '+(failure.stdout??'')+(failure.stderr??''));}
  const prepare=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;
    const fail=failure=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();reject(failure);};
    const timer=setTimeout(()=>fail(error('PREPARATION_TIMEOUT','The controlled preparation producer timed out.')),10000);
    child.once('error',fail);child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024)fail(error('PREPARATION_BUDGET','Preparation output exceeded its bounded budget.'));});
    child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)fail(error('PREPARATION_BUDGET','Preparation diagnostic exceeded its bounded budget.'));});
    child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)return reject(error('PREPARATION_FAILED','Preparation exited '+code+': '+stderr));try{resolve(JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(failure){reject(failure);}});
    child.stdin.on('error',fail);child.stdin.end(JSON.stringify(input));
  });
  prepare.fragments=fragments;prepare.sourceEvidence=fragments.sourceEvidence;
  return prepare;
}

/** Execute actual production preparation statements with controlled path peers. */
export async function loadScriptCompilerPreparationProducer(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-script-preparation-'));
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('buildx-script-preparation-'))throw error('CLEANUP_DIRECTORY','Unsafe preparation-fixture cleanup target.');await fs.rm(resolved,{recursive:true,force:true});});
  const produce=await createPreparationProducer(directory);produce.directory=directory;return produce;
}

const common={expected_document:'D:\\offline-template-fixture.rvt'};
const templateInputs={
  revit_rotate_elements:{...common,element_ids:[123,456],axis_origin_mm:{x:-100.5,y:20,z:0},angle_degrees:90},
  revit_place_family_instance:{...common,symbol_id:123,level_id:456,point_mm:{x:1000,y:2000,z:3250}},
  revit_place_door:{...common,symbol_id:123,wall_id:789,level_id:456,point_mm:{x:1000,y:2000,z:3000}},
  revit_create_floor:{...common,floor_type_id:123,level_id:456,origin_mm:{x:1000,y:2000,z:3150},width_mm:2000,depth_mm:3000,offset_mm:150}
};
export function scriptCompilerOfflineCases(){
  return [...Object.entries(templateInputs).map(([name,args])=>({name,variant:'default',parameters:false,templateVersion:MODELLING_TEMPLATE_VERSION,code:compileModellingTool(name,args)})),
    {name:'revit_place_door',variant:'facing',parameters:false,templateVersion:MODELLING_TEMPLATE_VERSION,code:compileModellingTool('revit_place_door',{...templateInputs.revit_place_door,facing_direction:{x:0,y:-1,z:0}})},
    {name:'structured_parameters',variant:'unicode',parameters:true,code:'string 名称 = Convert.ToString(parameters["名称"]); double 长度毫米 = Convert.ToDouble(parameters["长度_mm"]); return new { 名称, 长度毫米 };'},
    {name:'csharp14_unicode',variant:'unbound_generic_nameof',parameters:false,code:'string 中文名称 = nameof(List<>); return new { 名称 = 中文名称, 文本 = "中文 Unicode 编译 ✓" };'}];
}

/** Compile fixed script bodies only. Never loads generated DLLs or invokes Revit. */
export async function compileScriptRunnerOffline({compilerExecutable,revitDirectory,outputDirectory}){
  if(process.platform!=='win32')throw error('WINDOWS_REQUIRED','Offline ScriptRunner verification requires Windows and its existing .NET Framework compiler.');
  if(typeof compilerExecutable!=='string'||!path.isAbsolute(compilerExecutable)||path.basename(compilerExecutable).toLowerCase()!=='csc.exe')throw error('COMPILER_REQUIRED','Select an explicit existing csc.exe.');
  if(typeof revitDirectory!=='string'||!path.isAbsolute(revitDirectory))throw error('REVIT_API_REQUIRED','Select the existing Revit 2024 API directory explicitly.');
  await existingDirectory(path.dirname(compilerExecutable));await regularFile(compilerExecutable);await existingDirectory(revitDirectory);
  const revitApi=path.join(revitDirectory,'RevitAPI.dll'),revitApiUi=path.join(revitDirectory,'RevitAPIUI.dll');
  await regularFile(revitApi);await regularFile(revitApiUi);
  const inputHashes={compiler:sha(await fs.readFile(compilerExecutable)),revitApi:sha(await fs.readFile(revitApi)),revitApiUi:sha(await fs.readFile(revitApiUi)),templates:sha(await fs.readFile(templatesFile))};
  await createNewDirectory(outputDirectory);
  const harnessDirectory=path.join(outputDirectory,'preparation-producer');await fs.mkdir(harnessDirectory);
  const prepare=await createPreparationProducer(harnessDirectory),fragments=prepare.fragments;
  const references=await prepare({compilerExecutable,revitApi,revitApiUi,outputRoot:outputDirectory,inspectReferences:true});
  if(!references.ok||!/^24\./.test(references.revitApiVersion??'')||!/^24\./.test(references.revitApiUiVersion??''))throw error('REVIT_API_VERSION','Selected references are not verified Revit 2024 API assemblies.');
  const version=await execute(compilerExecutable,['/version'],{windowsHide:true,timeout:fragments.timeoutMs,maxBuffer:4096,env:{...process.env,...fragments.environment}});
  const compilerVersion=((version.stdout??'')+(version.stderr??'')).trim();if(!compilerVersion)throw error('COMPILER_VERSION','The selected compiler returned no version.');
  const entries=[];
  for(const descriptor of scriptCompilerOfflineCases()){
    const requestId=randomUUID(),prepared=await prepare({compilerExecutable,revitApi,revitApiUi,outputRoot:outputDirectory,code:descriptor.code,parameters:descriptor.parameters,requestId});
    if(!prepared.ok){entries.push({name:descriptor.name,variant:descriptor.variant,prepared:false,exitCode:null,error:prepared.message,codeSha256:sha(descriptor.code)});continue;}
    const files=prepared.result,sourceBytes=await fs.readFile(files.source),rspBytes=await fs.readFile(files.responseFile);
    let exitCode=0,diagnostic='',failure=null;
    try{const result=await execute(compilerExecutable,['/noconfig','@'+files.responseFile],{cwd:files.directory,windowsHide:true,timeout:fragments.timeoutMs,maxBuffer:1024*1024,env:{...process.env,...fragments.environment}});diagnostic=(result.stdout??'')+(result.stderr??'');}
    catch(cause){exitCode=Number.isInteger(cause.code)?cause.code:null;diagnostic=(cause.stdout??'')+(cause.stderr??'')+(cause.message??'');failure={code:typeof cause.code==='string'?cause.code:null,killed:cause.killed===true,signal:cause.signal??null};}
    await fs.writeFile(path.join(files.directory,'compile.log'),diagnostic,{flag:'wx'});
    let dllSha256=null;try{await regularFile(files.dll);dllSha256=sha(await fs.readFile(files.dll));}catch{}
    entries.push({name:descriptor.name,variant:descriptor.variant,templateVersion:descriptor.templateVersion??null,structuredParameters:descriptor.parameters,prepared:true,requestId,
      exitCode,failure,codeSha256:sha(descriptor.code),source:files.source,sourceSha256:sha(sourceBytes),responseFile:files.responseFile,responseSha256:sha(rspBytes),dll:files.dll,dllSha256,
      sourceUnchanged:sha(await fs.readFile(files.source))===sha(sourceBytes),responseUnchanged:sha(await fs.readFile(files.responseFile))===sha(rspBytes),generatedAssemblyLoaded:false,executedInRevit:false});
  }
  const inputsUnchanged=sha(await fs.readFile(compilerExecutable))===inputHashes.compiler&&sha(await fs.readFile(revitApi))===inputHashes.revitApi&&sha(await fs.readFile(revitApiUi))===inputHashes.revitApiUi&&sha(await fs.readFile(templatesFile))===inputHashes.templates&&sha(await fs.readFile(runnerFile))===fragments.sourceEvidence.sourceSha256;
  const summary={schemaVersion:1,kind:'script-runner-offline-compilation',createdUtc:new Date().toISOString(),compilerExecutable,compilerVersion,compilerSha256:inputHashes.compiler,
    referenceAssemblies:[{path:revitApi,fileVersion:references.revitApiVersion,sha256:inputHashes.revitApi},{path:revitApiUi,fileVersion:references.revitApiUiVersion,sha256:inputHashes.revitApiUi}],
    productionSource:fragments.sourceEvidence,templates:{source:'lib/modelling-tools.mjs',sha256:inputHashes.templates,version:MODELLING_TEMPLATE_VERSION},
    compilerInvocation:{arguments:['/noconfig','@<production responseFile>'],timeoutMs:fragments.timeoutMs,environment:fragments.environment},
    inputsUnchanged,passed:inputsUnchanged&&entries.length===7&&entries.every(entry=>entry.prepared&&entry.exitCode===0&&entry.dllSha256&&entry.sourceUnchanged&&entry.responseUnchanged),
    generatedAssembliesLoaded:false,uiApplicationInstantiated:false,executedInRevit:false,modelModified:false,entries};
  await fs.writeFile(path.join(outputDirectory,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  return summary;
}
