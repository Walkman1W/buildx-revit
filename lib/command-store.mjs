import {validateSequence,runSequence} from './command-sequence.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createCommandSaveReceiptOwner} from './command-save-receipt.mjs';
import {PARAMETER_OPTIONS_SCHEMA,validateCommandParameterOptions,validateCommandParameterValues} from '../public/command-parameter-options.mjs';
import {resolveBuildxPaths} from './buildx-paths.mjs';

const ROOT = resolveBuildxPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).workbenchRoot;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const REVISION = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
// JSON escaping can expand a 64,000-byte method body to 384,000 bytes.
const MAX_RECORD_BYTES = 512 * 1024;
const commandId = {type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$',description:'Stable lowercase ID; Windows reserved device names such as con and nul are not allowed.'};
const revision = {type:'string',pattern:'^[a-f0-9]{64}$',description:'Exact immutable SHA256 revision returned by save/list. There is no latest alias.'};
function contract(name,description,properties,required,readOnly,idempotent){
  return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,idempotentHint:idempotent,destructiveHint:name==='revit_run_command'}};
}
export const COMMAND_TOOLS = [
  contract('revit_save_command','Save either a reusable C# method body or allowed read-only steps as an immutable local command revision. Saving does not execute or verify it. C# parameters may declare labels and dropdown metadata. Optional source_request_id adds separate append-only evidence for matching successful nonparameterized C# execution; rollback success is not commit validation. This is source storage, not a sandbox.',{
    command_id:commandId,name:{type:'string',minLength:1,maxLength:80},description:{type:'string',minLength:1,maxLength:2000},code:{type:'string',minLength:1,maxLength:64000,description:'C# method body, at most 64000 UTF-8 bytes; same contract as revit_execute_csharp.'},parameters:{type:'object',description:'Optional named primitive parameter types: string, number, integer or boolean.',additionalProperties:{type:'string',enum:['string','number','integer','boolean']}},parameter_labels:{type:'object',maxProperties:32,description:'Optional display labels for existing named parameters of a C# command, including units. Requires code and parameters; does not rename execution keys.',additionalProperties:{type:'string',minLength:1,maxLength:80}},parameter_options:PARAMETER_OPTIONS_SCHEMA,steps:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{id:{type:'string'},tool:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['id','tool','arguments'],additionalProperties:false},description:'Deterministic allowed read-only steps; arguments may reference inputs or earlier outputs.'},source_request_id:{type:'string',pattern:UUID.source}
  },['command_id','name','description'],false,true),
  contract('revit_list_commands','List saved command revisions with descriptions and recorded verification evidence, without source code. Each revision is a separate row, newest first. Malformed or linked storage entries cause an explicit error.',{
    command_id:commandId,offset:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:0},limit:{type:'integer',minimum:1,maximum:100,default:20}
  },[],true,true),
  contract('revit_get_command','Read and integrity-check one exact immutable command revision, including C# source or read-only steps and parameter metadata. Review its full content and current Revit model before reuse.',{command_id:commandId,revision},['command_id','revision'],true,true),
  contract('revit_run_command','Run one exact saved revision: C# uses the existing Revit executor; read-only steps run serially through the allowed query dispatcher. First read the full revision and workbench status; verify current IDs, types and units. C# retains revit_execute_csharp privileges and defaults to rollback; commit keeps model changes without saving. Do not automatically retry unknown outcomes.',{
    command_id:commandId,revision,expected_document:{type:'string',minLength:1,description:'Exact current allowed document path from workbench status.'},mode:{type:'string',enum:['rollback','commit'],default:'rollback'},parameters:{type:'object',description:'Values for the exact revision parameter contract.',additionalProperties:true}
  },['command_id','revision','expected_document'],false,false)
];

export function isCommandTool(name){return COMMAND_TOOLS.some(tool=>tool.name===name);}
function fail(message){throw new Error('Command store: '+message);}
function object(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))fail(label+' must be an object');
}
function keys(value,allowed,required,label){
  object(value,label);
  for(const key of Object.keys(value))if(!allowed.includes(key))fail('unknown '+label+'.'+key);
  for(const key of required)if(!Object.hasOwn(value,key))fail('missing '+label+'.'+key);
}
function string(value,min,max,label){
  if(typeof value!=='string'||value.length<min||value.length>max||!value.trim())fail('invalid '+label);
  return value;
}
function validateId(value){if(typeof value!=='string'||!ID.test(value)||RESERVED.test(value))fail('invalid command_id');return value;}
function validateRevision(value){if(typeof value!=='string'||!REVISION.test(value))fail('invalid revision: use the exact 64 lowercase hex digest');return value;}
function validateUuid(value){if(typeof value!=='string'||!UUID.test(value))fail('invalid source_request_id');return value;}
function validateCode(value){
  string(value,1,64000,'code');
  if(Buffer.byteLength(value,'utf8')>64000)fail('code exceeds 64000 UTF-8 bytes');
  return value;
}
function validateMode(value){if(value!=='rollback'&&value!=='commit')fail('mode must be rollback or commit');return value;}
function timestamp(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail('invalid '+label);
  return value;
}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)fail('invalid '+label);return value;}
function parameterTypes(value){
  object(value,'parameters');
  const entries=Object.entries(value);
  if(entries.length>32)fail('too many parameters');
  const result={};
  for(const [key,type] of entries){
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||!['string','number','integer','boolean'].includes(type))fail('invalid parameter definition');
    result[key]=type;
  }
  return result;
}
function parameterValues(types,value){
  object(value,'parameters');
  if(Object.keys(value).length!==Object.keys(types).length)fail('parameter values must match the revision contract');
  const result={};
  for(const [key,type] of Object.entries(types)){
    const entry=value[key];
    if(!Object.hasOwn(value,key)||type==='string'&&(typeof entry!=='string'||Buffer.byteLength(entry,'utf8')>16000)||type==='boolean'&&typeof entry!=='boolean'||type==='number'&&(typeof entry!=='number'||!Number.isFinite(entry))||type==='integer'&&!Number.isSafeInteger(entry))fail('invalid parameter '+key);
    result[key]=entry;
  }
  return result;
}
function parameterLabels(value,types){
  object(value,'parameter_labels');
  const entries=Object.entries(value);
  if(entries.length>32)fail('too many parameter_labels');
  const result={};
  for(const [key,label] of entries){
    if(!Object.hasOwn(types,key))fail('parameter_labels key must belong to parameters: '+key);
    result[key]=string(label,1,80,'parameter_labels.'+key);
  }
  return result;
}
function content(value){
  const sequence=Object.hasOwn(value,'steps'),labeled=Object.hasOwn(value,'parameter_labels'),options=Object.hasOwn(value,'parameter_options');
  if(sequence===Object.hasOwn(value,'code'))fail('provide exactly one of code or steps');
  if(labeled&&(sequence||!Object.hasOwn(value,'parameters')))fail('parameter_labels require code and parameters; steps do not support labels');
  if(options&&(sequence||!Object.hasOwn(value,'parameters')))fail('parameter_options require code and parameters; steps do not support dropdown metadata');
  const base={schema_version:sequence?3:options?5:labeled?4:Object.hasOwn(value,'parameters')?2:1,command_id:validateId(value.command_id),name:string(value.name,1,80,'name'),description:string(value.description,1,2000,'description')};
  if(sequence){base.parameters=parameterTypes(value.parameters??{});base.steps=validateSequence(value.steps,base.parameters);}
  else{
    base.code=validateCode(value.code);
    if([2,4,5].includes(base.schema_version))base.parameters=parameterTypes(value.parameters);
    if(labeled)base.parameter_labels=parameterLabels(value.parameter_labels,base.parameters);
    if(options)base.parameter_options=validateCommandParameterOptions(value.parameter_options,base.parameters);
  }
  return base;
}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function contentRevision(value){return digest(JSON.stringify(content(value)));}
function argumentsFor(name,args){
  const tool=COMMAND_TOOLS.find(entry=>entry.name===name);
  if(!tool)fail('unknown tool '+name);
  keys(args,Object.keys(tool.inputSchema.properties),tool.inputSchema.required,'arguments');
  const result={...args};
  if(Object.hasOwn(args,'command_id'))validateId(args.command_id);
  if(Object.hasOwn(args,'revision'))validateRevision(args.revision);
  if(name==='revit_save_command'){
    content(args);
    if(Object.hasOwn(args,'source_request_id')){validateUuid(args.source_request_id);if(Object.hasOwn(args,'parameters')||Object.hasOwn(args,'steps'))fail('source evidence for parameterized or sequence revisions is not supported');}
  }else if(name==='revit_list_commands'){
    result.offset=integer(args.offset??0,0,Number.MAX_SAFE_INTEGER,'offset');
    result.limit=integer(args.limit??20,1,100,'limit');
    if(Object.hasOwn(args,'offset')&&args.offset==null)fail('invalid offset');
    if(Object.hasOwn(args,'limit')&&args.limit==null)fail('invalid limit');
  }else if(name==='revit_run_command'){
    string(args.expected_document,1,32768,'expected_document');
    result.mode=validateMode(Object.hasOwn(args,'mode')?args.mode:'rollback');
  }
  return result;
}

// Reject symbolic links/junctions in the entire path, including an injected root.
// This guards accidental traversal; it is not a sandbox against a hostile local OS user.
async function directories(directory,create=false){
  const absolute=path.resolve(directory), parsed=path.parse(absolute);
  let current=parsed.root;
  for(const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,component);
    let stat;
    try{stat=await fs.lstat(current);}catch(error){
      if(error.code!=='ENOENT'||!create)throw error;
      try{await fs.mkdir(current);}catch(mkdirError){if(mkdirError.code!=='EEXIST')throw mkdirError;}
      stat=await fs.lstat(current);
    }
    if(stat.isSymbolicLink()||!stat.isDirectory())fail('unsafe directory entry '+current);
  }
  return absolute;
}
async function readJson(filename,maxBytes){
  await directories(path.dirname(filename));
  const before=await fs.lstat(filename);
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1)fail('unsafe file entry '+filename);
  if(before.size>maxBytes)fail('file exceeds size limit '+filename);
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.nlink!==1||opened.size>maxBytes||opened.ino!==before.ino||opened.dev!==before.dev)fail('file identity changed '+filename);
    const buffer=Buffer.alloc(maxBytes+1);
    let length=0;
    while(length<buffer.length){
      const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);
      if(bytesRead===0)break;
      length+=bytesRead;
    }
    if(length>maxBytes)fail('file exceeds size limit '+filename);
    const bytes=buffer.subarray(0,length);
    let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('malformed UTF-8 JSON '+filename);}
    return {value,sha256:digest(bytes)};
  }finally{await handle.close();}
}
// Keep the actual handle until an identity has been observed. Retrying cleanup
// must never turn an unverified path into deletion authority.
function ownedFile(handle,filename){return {handle,filename,identity:null,closed:false,clean:false};}
async function identifyOwned(owner){
  if(owner.identity)return;
  if(owner.closed)throw new Error('Original file identity was not established');
  const stat=await owner.handle.stat();
  if(!stat.isFile()||stat.nlink!==1)throw new Error('Owned file identity is not safe');
  owner.identity={dev:stat.dev,ino:stat.ino};
}
async function closeOwned(owner){
  if(owner.closed)return;
  await owner.handle.close();owner.closed=true;
}
async function cleanupOwned(owner){
  if(!owner||owner.clean)return true;
  try{
    await identifyOwned(owner);await closeOwned(owner);
    let current;try{current=await fs.lstat(owner.filename);}catch(error){if(error.code==='ENOENT'){owner.clean=true;return true;}throw error;}
    if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1||current.dev!==owner.identity.dev||current.ino!==owner.identity.ino)return false;
    await fs.unlink(owner.filename);owner.clean=true;return true;
  }catch{return false;}
}
async function cleanupSaveTracking(tracking){
  if(!tracking)return true;
  if(tracking.cleanupWork)return tracking.cleanupWork;
  const work=(async()=>{
    if(tracking.stageOwner){if(await cleanupOwned(tracking.stageOwner)){tracking.stageOwner=null;tracking.stageClean=true;}else return false;}
    if(tracking.lockOwner){if(await cleanupOwned(tracking.lockOwner)){tracking.lockOwner=null;tracking.lockClean=true;}else return false;}
    return tracking.stageClean&&tracking.lockClean;
  })();tracking.cleanupWork=work;
  try{return await work;}finally{if(tracking.cleanupWork===work)tracking.cleanupWork=null;}
}
async function withPublicationLock(root,action,tracking){
  const state=await directories(path.join(root,'command-store-state'),true);
  const filename=path.join(state,'publish.lock'), deadline=Date.now()+5000;
  let handle;
  while(!handle){
    try{handle=await fs.open(filename,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      let occupied;
      try{occupied=await fs.lstat(filename);}catch(statError){if(statError.code==='ENOENT')continue;throw statError;}
      if(!occupied.isFile()||occupied.isSymbolicLink()||occupied.nlink!==1)fail('unsafe publication lock '+filename);
      if(Date.now()>=deadline)fail('publication lock is busy or left by an interrupted writer; inspect '+filename+' before recovery. No existing lock was removed.');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  const owner=ownedFile(handle,filename);
  if(tracking){tracking.lockClean=false;tracking.lockOwner=owner;}
  try{
    await identifyOwned(owner);
    await handle.writeFile(JSON.stringify({pid:process.pid,token:randomUUID(),created_utc:new Date().toISOString()}));
    return await action(state);
  }finally{
    // The owner retains any uncertain stage and lock for an explicit retry.
    const cleaned=tracking?await cleanupSaveTracking(tracking):await cleanupOwned(owner);
    if(!cleaned)fail('publication cleanup is unconfirmed; retained original owner');
  }
}
async function publishImmutable(state,filename,serialized,shouldContinue,tracking){
  // Every cooperating writer holds the store publication lock. Readers need no
  // lock: only complete staged files become visible under their final names.
  if(typeof shouldContinue==='function'&&shouldContinue()!==true){const error=new Error('命令保存已停止，未发布新版本。');error.interruptedBeforeEnqueue=true;throw error;}
  try{await fs.lstat(filename);return false;}catch(error){if(error.code!=='ENOENT')throw error;}
  const staged=path.join(state,randomUUID()+'.staging');
  const handle=await fs.open(staged,'wx',0o600);
  const owner=ownedFile(handle,staged);
  if(tracking){tracking.stageClean=false;tracking.stageOwner=owner;}
  let published=false;
  try{
    await identifyOwned(owner);await handle.writeFile(serialized);await handle.sync();await closeOwned(owner);
    // Revocation is checked immediately before publication. Once rename is
    // started, its outcome must not be represented as a definite cancellation.
    if(typeof shouldContinue==='function'&&shouldContinue()!==true){const error=new Error('命令保存已停止，未发布新版本。');error.interruptedBeforeEnqueue=true;throw error;}
    if(tracking)tracking.publicationStarted=true;
    await fs.rename(staged,filename);
    published=true;
    owner.clean=true;if(tracking){tracking.stageClean=true;tracking.stageOwner=null;}
    return true;
  }finally{
    if(!published){const cleaned=await cleanupOwned(owner);if(cleaned&&tracking){tracking.stageClean=true;tracking.stageOwner=null;}if(!cleaned)fail('staged publication cleanup is unconfirmed; retained original owner');}
  }
}
function validateEvidence(value){
  object(value,'verification');
  const fields=['status','source_request_id','mode','expected_document','request_created_utc','completed_utc','request_sha256','outcome_sha256','outcome'];
  keys(value,fields,fields,'verification');
  if(value.status!=='source_execution_succeeded'||value.outcome!=='ok')fail('invalid verification outcome');
  validateUuid(value.source_request_id);validateMode(value.mode);
  string(value.expected_document,1,32768,'verification.expected_document');
  timestamp(value.request_created_utc,'verification.request_created_utc');timestamp(value.completed_utc,'verification.completed_utc');
  validateRevision(value.request_sha256);validateRevision(value.outcome_sha256);
}
async function sourceEvidence(root,id,code){
  const requestFile=path.join(root,'queue','processing',id+'.json');
  const outcomeFile=path.join(root,'queue','outbox',id+'.json');
  let requestData,outcomeData;
  try{
    requestData=await readJson(requestFile,128*1024);
    outcomeData=await readJson(outcomeFile,4*1024*1024);
  }catch(error){if(error.code==='ENOENT')fail('source request or completed outcome is missing for '+id);throw error;}
  const request=requestData.value,outcome=outcomeData.value;
  object(request,'source request');object(outcome,'source outcome');object(request.args,'source request.args');
  if(request.id!==id||outcome.id!==id||request.operation!=='execute_csharp'||outcome.ok!==true||outcome.result?.operation!=='execute_csharp')fail('source is not a successful matching execute_csharp request '+id);
  if(typeof request.args.code!=='string'||!Buffer.from(request.args.code,'utf8').equals(Buffer.from(code,'utf8')))fail('source code does not match saved code '+id);
  const mode=validateMode(request.args.mode??'rollback');
  if(outcome.result.mode!==mode||outcome.result.committed!==(mode==='commit'))fail('source outcome mode does not match request '+id);
  return {
    status:'source_execution_succeeded',source_request_id:id,mode,
    expected_document:string(request.args.expected_document,1,32768,'source expected_document'),
    request_created_utc:timestamp(request.createdUtc,'source createdUtc'),
    completed_utc:timestamp(outcome.completedUtc,'source completedUtc'),
    request_sha256:requestData.sha256,outcome_sha256:outcomeData.sha256,outcome:'ok'
  };
}
async function readValidation(root,id,revision,requestId){
  const filename=path.join(root,'commands',id,'validations',revision,requestId+'.json');
  const {value}=await readJson(filename,64*1024);
  const fields=['schema_version','command_id','revision','recorded_utc','source'];
  keys(value,fields,fields,'validation record');
  if(value.schema_version!==1||value.command_id!==id||value.revision!==revision)fail('validation identity mismatch '+filename);
  timestamp(value.recorded_utc,'validation recorded_utc');validateEvidence(value.source);
  if(value.source.source_request_id!==requestId)fail('validation source identity mismatch '+filename);
  return value;
}
async function readVerifications(root,id,revision){
  const directory=path.join(root,'commands',id,'validations',revision);
  try{await directories(directory);}catch(error){if(error.code==='ENOENT')return {status:'unverified',evidence:[]};throw error;}
  const evidence=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(!entry.name.endsWith('.json')||!UUID.test(entry.name.slice(0,-5))||!entry.isFile()||entry.isSymbolicLink())fail('malformed validation entry '+path.join(directory,entry.name));
    const record=await readValidation(root,id,revision,entry.name.slice(0,-5));
    evidence.push({...record.source,recorded_utc:record.recorded_utc});
  }
  evidence.sort((a,b)=>Date.parse(b.completed_utc)-Date.parse(a.completed_utc)||a.source_request_id.localeCompare(b.source_request_id,'en'));
  return {status:evidence.length?'source_execution_succeeded':'unverified',evidence};
}
async function readCommand(root,id,revision){
  const filename=path.join(root,'commands',id,revision+'.json');
  const {value}=await readJson(filename,MAX_RECORD_BYTES);
  const fields=['schema_version','command_id','name','description',...(value.schema_version===3?['parameters','steps']:['code',...([2,4,5].includes(value.schema_version)?['parameters']:[]),...(value.schema_version===4||value.schema_version===5&&Object.hasOwn(value,'parameter_labels')?['parameter_labels']:[]),...(value.schema_version===5?['parameter_options']:[])]),'revision','created_utc'];
  keys(value,fields,fields,'record');
  if(![1,2,3,4,5].includes(value.schema_version)||value.command_id!==id||value.revision!==revision||contentRevision(value)!==revision)fail('record identity or SHA256 mismatch '+filename);
  timestamp(value.created_utc,'created_utc');
  return {...value,verification:await readVerifications(root,id,revision)};
}
function summary(record){const {code,steps,...result}=record;return result;}
async function addValidation(root,state,id,revision,source,shouldContinue,tracking){
  const directory=await directories(path.join(root,'commands',id,'validations',revision),true);
  const filename=path.join(directory,source.source_request_id+'.json');
  const record={schema_version:1,command_id:id,revision,recorded_utc:new Date().toISOString(),source};
  const created=await publishImmutable(state,filename,JSON.stringify(record,null,2)+'\n',shouldContinue,tracking);
  if(!created){
    const existing=await readValidation(root,id,revision,source.source_request_id);
    if(JSON.stringify(existing.source)!==JSON.stringify(source))fail('existing immutable validation differs from queue evidence '+filename);
    return false;
  }
  await readValidation(root,id,revision,source.source_request_id);
  return true;
}
async function save(root,args,options={},tracking){
  const body=content(args), revision=contentRevision(body);
  // Validate requested evidence even when this exact revision already exists.
  const evidence=args.source_request_id?await sourceEvidence(root,args.source_request_id,args.code):null;
  return withPublicationLock(root,async state=>{
    const record={...body,revision,created_utc:new Date().toISOString()};
    const directory=await directories(path.join(root,'commands',args.command_id),true);
    const filename=path.join(directory,revision+'.json');
    const serialized=JSON.stringify(record,null,2)+'\n';
    if(Buffer.byteLength(serialized,'utf8')>MAX_RECORD_BYTES)fail('serialized command exceeds size limit');
    const created=await publishImmutable(state,filename,serialized,options.shouldContinue,tracking);
    await readCommand(root,args.command_id,revision);
    let verificationAdded=false;
    if(evidence){
      try{verificationAdded=await addValidation(root,state,args.command_id,revision,evidence,options.shouldContinue,tracking);}
      catch(error){if(created&&error?.interruptedBeforeEnqueue)delete error.interruptedBeforeEnqueue;throw error;}
    }
    const stored=await readCommand(root,args.command_id,revision);
    return {...summary(stored),created,verification_added:verificationAdded};
  },tracking);
}
async function list(root,args){
  const directory=path.join(root,'commands');
  // A missing store is empty; broken/linked existing directories are errors.
  try{await directories(root);}catch(error){if(error.code==='ENOENT')return {commands:[],total:0,offset:args.offset,limit:args.limit,has_more:false};throw error;}
  try{await directories(directory);}catch(error){if(error.code==='ENOENT')return {commands:[],total:0,offset:args.offset,limit:args.limit,has_more:false};throw error;}
  const records=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(!ID.test(entry.name)||RESERVED.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())fail('malformed command directory '+path.join(directory,entry.name));
    // Check all entries even if a filter excludes them: never hide malformed storage.
    const commandDirectory=await directories(path.join(directory,entry.name));
    for(const file of await fs.readdir(commandDirectory,{withFileTypes:true})){
      if(file.name==='validations'){
        const validationDirectory=await directories(path.join(commandDirectory,'validations'));
        for(const validation of await fs.readdir(validationDirectory,{withFileTypes:true})){
          if(!REVISION.test(validation.name)||!validation.isDirectory()||validation.isSymbolicLink())fail('malformed validation directory '+path.join(validationDirectory,validation.name));
          // An evidence directory must belong to an existing, intact content version.
          await readCommand(root,entry.name,validation.name);
        }
        continue;
      }
      if(!/^[a-f0-9]{64}\.json$/.test(file.name)||!file.isFile()||file.isSymbolicLink())fail('malformed revision entry '+path.join(commandDirectory,file.name));
      const record=await readCommand(root,entry.name,file.name.slice(0,-5));
      if(args.command_id===undefined||args.command_id===entry.name)records.push(summary(record));
    }
  }
  records.sort((a,b)=>Date.parse(b.created_utc)-Date.parse(a.created_utc)||a.command_id.localeCompare(b.command_id,'en')||a.revision.localeCompare(b.revision,'en'));
  return {commands:records.slice(args.offset,args.offset+args.limit),total:records.length,offset:args.offset,limit:args.limit,has_more:args.offset+args.limit<records.length};
}

// The approval owner must validate the exact command draft before displaying
// it. Publication still revalidates at the owning storage boundary.
export function validateSaveCommandArguments(args){return argumentsFor('revit_save_command',args);}

export async function invokeCommand(name,args={},options={}){
  const validated=argumentsFor(name,args);
  const root=path.resolve(options.root??ROOT);
  if(name==='revit_save_command'){
    const body=content(validated),revision=contentRevision(body),tracking={settled:false,succeeded:false,publicationStarted:false,lockClean:true,stageClean:true,lockOwner:null,stageOwner:null};
    const publicationState=async()=>{if(tracking.settled)await cleanupSaveTracking(tracking);return {settled:tracking.settled,cleanupConfirmed:tracking.lockClean&&tracking.stageClean};};
    const baseReceipt=createCommandSaveReceiptOwner({commandId:body.command_id,revision,sourceRequestId:validated.source_request_id??null,
      readExact:(id,revision)=>readCommand(root,id,revision),verifySource:(id,record)=>sourceEvidence(root,id,record.code),
      publicationState});
    let receiptClosed=false;
    const receiptOwner=Object.freeze({
      inspect:async()=>{if(receiptClosed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};const state=await publicationState();if(receiptClosed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};if(state.settled&&state.cleanupConfirmed&&!tracking.publicationStarted&&!tracking.succeeded)return {ok:true,value:{status:'not_started',terminal:true,checkedAt:new Date().toISOString(),evidence:{commandId:body.command_id,revision}}};return baseReceipt.inspect();},
      close:async()=>{const result=await baseReceipt.close();if(result?.ok===true&&result.value?.closed===true)receiptClosed=true;return result;},
    });
    try{const result=await save(root,validated,options,tracking);tracking.succeeded=true;tracking.settled=true;if(options.retainReceiptOwner===true)Object.defineProperty(result,'receiptOwner',{value:receiptOwner,enumerable:false});return result;}
    catch(error){tracking.settled=true;if(!tracking.publicationStarted&&tracking.lockClean&&tracking.stageClean)error.interruptedBeforeEnqueue=true;if(!(error?.interruptedBeforeEnqueue&&tracking.lockClean&&tracking.stageClean))Object.defineProperty(error,'receiptOwner',{value:receiptOwner});throw error;}
  }
  if(name==='revit_list_commands')return list(root,validated);
  const record=await readCommand(root,validated.command_id,validated.revision);
  if(name==='revit_get_command')return record;
  if(record.schema_version===3){
    const inputs=parameterValues(record.parameters,validated.parameters??{});
    const execution=await runSequence(record,inputs,options);
    const result={command:{command_id:record.command_id,revision:record.revision,name:record.name},execution};
    if(execution.receiptOwner)Object.defineProperty(result,'receiptOwner',{value:execution.receiptOwner,enumerable:false});
    return result;
  }
  if(typeof options.execute!=='function')fail('run requires the existing Revit executor');
  // Exactly one call. Let the existing executor preserve its request ID and unknown-outcome errors.
  const executionArgs={code:record.code,expected_document:validated.expected_document,mode:validated.mode};
  if([2,4,5].includes(record.schema_version)){
    executionArgs.parameters=parameterValues(record.parameters,validated.parameters??{});
    if(record.schema_version===5)validateCommandParameterValues(record.parameter_options,record.parameters,executionArgs.parameters);
    if(options.parameterizedScriptsSupported!==true)fail('host structured script parameters capability is not confirmed; no request sent');
  }else if(Object.hasOwn(validated,'parameters')&&Object.keys(parameterValues({},validated.parameters)).length)fail('legacy revision does not accept parameters');
  const execution=await options.execute('revit_execute_csharp',executionArgs);
  const result={command:{command_id:record.command_id,revision:record.revision,name:record.name},execution};
  if(execution.receiptOwner)Object.defineProperty(result,'receiptOwner',{value:execution.receiptOwner,enumerable:false});
  return result;
}
