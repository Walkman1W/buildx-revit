import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';


const safePath=value=>typeof value==='string'&&value.length<=240&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(value);
function frozenData(value,seen=new Set()){
  if(value===null||typeof value!=='object')return typeof value!=='function';
  if(seen.has(value))return true;
  if(!Object.isFrozen(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  seen.add(value);return Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')&&frozenData(Object.getOwnPropertyDescriptor(value,key).value,seen));
}
function treeFor(names){
  const root=new Map();
  for(const name of names){const parts=name.split('/');let tree=root;
    for(let i=0;i<parts.length;i++){const leaf=i===parts.length-1,part=parts[i];
      if(tree.has(part)){const existing=tree.get(part);if(leaf||!(existing instanceof Map))throw new Error('Conflicting component paths');tree=existing;}
      else if(leaf)tree.set(part,null);else{const next=new Map();tree.set(part,next);tree=next;}
    }
  }return root;
}
function trustedDefinition(value){
  const keys=['component','stage','manifest','outputBase','roles','exactPaths','entryPath','generatedFiles'];
  if(!value||typeof value!=='object'||Array.isArray(value)||!frozenData(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))||typeof value.component!=='string'||!/^buildx-[a-z0-9-]{1,80}$/.test(value.component)||typeof value.stage!=='string'||!/^[a-z][a-z0-9-]{1,80}$/.test(value.stage)||!safePath(value.manifest)||!value.manifest.startsWith('release/')||typeof value.outputBase!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(value.outputBase)||!Array.isArray(value.roles)||!value.roles.length||new Set(value.roles).size!==value.roles.length||value.roles.some(role=>!['entry','module','script','style','prompt','document'].includes(role))||!value.generatedFiles||typeof value.generatedFiles!=='object'||Array.isArray(value.generatedFiles)||!(value.exactPaths===null||Array.isArray(value.exactPaths)&&value.exactPaths.length>0&&value.exactPaths.length<=32&&new Set(value.exactPaths).size===value.exactPaths.length&&value.exactPaths.every(safePath))||!(value.entryPath===null||safePath(value.entryPath)&&value.exactPaths?.includes(value.entryPath)))throw new Error('Invalid immutable customer component definition');
  const generatedEntries=Object.entries(value.generatedFiles);
  if(generatedEntries.length>32||(value.exactPaths?.length??0)+generatedEntries.length>32||value.exactPaths?.includes('BUILD-MANIFEST.json'))throw new Error('Invalid generated component budget');
  let generatedTotal=0;
  const planned=generatedEntries.map(([name,content])=>{
    if(!safePath(name)||name==='BUILD-MANIFEST.json'||typeof content!=='string'||!content||content.includes('\0'))throw new Error('Invalid generated component file');
    const byteLength=Buffer.byteLength(content,'utf8');generatedTotal+=byteLength;
    if(byteLength>256*1024||generatedTotal>1024*1024||value.exactPaths?.includes(name))throw new Error('Invalid generated component budget');
    return {path:name,content,byteLength};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const generated=planned.map(({path,content,byteLength})=>{
    const bytes=Buffer.from(content,'utf8');return {path,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength};
  });
  treeFor([...(value.exactPaths??[]),...generated.map(item=>item.path),'BUILD-MANIFEST.json']);return {definition:value,generated};
}

// Fixed application definitions are not HTTP-selectable path policies. Each
// wrapper keeps its own exact pending-read resources and cleanup identifiers.
export function createCustomerComponentBuilder(value,options=undefined){
const {definition,generated}=trustedDefinition(value);
const COMPONENT=definition.component;
const MAX_FILE=256*1024,MAX_TOTAL=1024*1024,MAX_ENTRIES=32;
// Exact open resources survive a failed close in this process. No new build or
// verification overlaps unresolved cleanup, and retry never replays a write.
const pendingReads=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const assetPath=value=>typeof value==='string'&&/^public\/[a-z][a-z0-9-]*\.(html|css|js|mjs)$/.test(value);
const same=(a,b)=>['dev','ino','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const fault=(code,message)=>Object.assign(new Error(message),{code});
const failures={
  INVALID_INPUT:'组件构建参数无效。',MANIFEST_INVALID:'客户组件白名单不符合固定契约。',
  INPUT_CHANGED:'输入字节或身份与白名单不匹配；未确认产物。',LINK_REJECTED:'构建不接受符号链接、重解析路径或多硬链接文件。',
  SOURCE_UNAVAILABLE:'无法核对客户组件输入。',OUTPUT_INVALID:'输出须是本工程 artifacts/'+definition.outputBase+' 下明确的新目录。',
  OUTPUT_EXISTS:'输出已存在；不会覆盖或删除原产物。',ARTIFACT_INVALID:'产物文件、目录或清单与受信输入不匹配。',
  BUILD_FAILED:'构建未完成；已写出的独立目录保留供核查，不视为有效产物。',
  CLEANUP_PENDING:'读取资源关闭未确认；保留原资源，须按回执重试清理后继续。',
  CLEANUP_ID_INVALID:'清理标识不属于本进程保留的读取资源。',
  KNOWN_RELEASE_UNAVAILABLE:'该版本未由此组件的受信固定定义登记。',
};
const result=async(action,cleanup=false)=>{try{if(!cleanup&&pendingReads.size)throw fault('CLEANUP_PENDING');return {ok:true,value:await action()};}catch(error){const code=Object.hasOwn(failures,error?.code)?error.code:'SOURCE_UNAVAILABLE';return {ok:false,error:{code,message:failures[code],...(pendingReads.size?{cleanupPending:true,cleanupIds:[...pendingReads.keys()],primaryCodes:[...pendingReads.values()].map(value=>value.primaryCode)}:{})}};}};
async function closeRead(handle,kind,primaryCode){
  try{await handle.close();}catch{
    pendingReads.set(randomUUID(),{handle,kind,primaryCode:Object.hasOwn(failures,primaryCode)?primaryCode:null});
    throw fault('CLEANUP_PENDING');
  }
}

async function regularTree(root,relative,{directory=false}={}){
  const segments=relative===''?[]:relative.split('/');let current=root;
  for(let index=-1;index<segments.length;index++){
    if(index>=0)current=path.join(current,segments[index]);
    const st=await fs.lstat(current,{bigint:true}),isDir=index<segments.length-1||directory;
    if(st.isSymbolicLink())throw fault('LINK_REJECTED');
    if(isDir?!st.isDirectory():!st.isFile())throw fault('INPUT_CHANGED');
    if(!isDir&&st.nlink!==1n)throw fault('LINK_REJECTED');
    // Windows junctions and alternate path spellings cannot become a new input root.
    if(path.resolve(await fs.realpath(current))!==path.resolve(current))throw fault('LINK_REJECTED');
  }
}
async function readBounded(root,relative,max){
  await regularTree(root,relative);const name=path.join(root,...relative.split('/'));
  const before=await fs.lstat(name,{bigint:true});
  if(before.size>BigInt(max))throw fault('INPUT_CHANGED');
  const handle=await fs.open(name,'r');let primaryCode;
  try{
    const opened=await handle.stat({bigint:true});if(!same(before,opened))throw fault('INPUT_CHANGED');
    const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,null);if(read.bytesRead===0)break;length+=read.bytesRead;}
    if(length!==Number(before.size)||!same(opened,await handle.stat({bigint:true})))throw fault('INPUT_CHANGED');
    await regularTree(root,relative);if(!same(before,await fs.lstat(name,{bigint:true})))throw fault('INPUT_CHANGED');
    return bytes.subarray(0,length);
  }catch(error){primaryCode=error?.code;throw error;}finally{await closeRead(handle,'file',primaryCode);}
}
function validateManifest(value,{definition,generated}){
  if(!exact(value,['schemaVersion','component','releaseReady','entries'])||value.schemaVersion!==1||value.component!==COMPONENT||value.releaseReady!==false||!Array.isArray(value.entries)||value.entries.length<1||value.entries.length+generated.length>MAX_ENTRIES)throw fault('MANIFEST_INVALID');
  const permitted=name=>definition.exactPaths===null?assetPath(name):definition.exactPaths.includes(name);
  const names=new Set(),generatedNames=new Set(generated.map(item=>item.path)),entries=[];let total=generated.reduce((n,item)=>n+item.byteLength,0);
  for(const item of value.entries){
    if(!exact(item,['path','sha256','byteLength','role','dependencies','provenance'])||!permitted(item.path)||names.has(item.path)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.byteLength)||item.byteLength<1||item.byteLength>MAX_FILE||!definition.roles.includes(item.role)||!Array.isArray(item.dependencies)||item.dependencies.length>MAX_ENTRIES||new Set(item.dependencies).size!==item.dependencies.length||item.dependencies.some(dep=>!permitted(dep)&&!generatedNames.has(dep))||item.provenance!=='BuildX application source')throw fault('MANIFEST_INVALID');
    names.add(item.path);total+=item.byteLength;entries.push({...item,dependencies:[...item.dependencies].sort()});
  }
  if(total>MAX_TOTAL||definition.exactPaths!==null&&(names.size!==definition.exactPaths.length||definition.exactPaths.some(name=>!names.has(name)))||entries.some(item=>item.dependencies.some(dep=>!names.has(dep)&&!generatedNames.has(dep)))||entries.filter(item=>item.role==='entry').length!==1||definition.entryPath!==null&&!entries.some(item=>item.path===definition.entryPath&&item.role==='entry'))throw fault('MANIFEST_INVALID');
  try{treeFor([...names,...generatedNames,'BUILD-MANIFEST.json']);}catch{throw fault('MANIFEST_INVALID');}
  return entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function manifestSnapshot(manifestBytes,policy){
  const {definition,generated}=policy;
  let decoded;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{throw fault('MANIFEST_INVALID');}
  const entries=validateManifest(decoded,policy);
  const plan={schemaVersion:1,component:COMPONENT,releaseReady:false,stage:definition.stage,inputManifestSha256:hash(manifestBytes),entries,totalBytes:entries.reduce((n,e)=>n+e.byteLength,0)+generated.reduce((n,item)=>n+item.byteLength,0)};
  if(generated.length)plan.generatedFiles=generated.map(({path,sha256,byteLength})=>({path,sha256,byteLength}));
  if(json(plan).length>64*1024)throw fault('MANIFEST_INVALID');
  const files=new Map([...entries,...generated].map(({path,sha256,byteLength})=>[path,{sha256,byteLength}]));
  return {plan,files};
}
async function inputSnapshot(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw fault('INVALID_INPUT');root=path.resolve(root);
  const manifestBytes=await readBounded(root,definition.manifest,64*1024);
  const snapshot=manifestSnapshot(manifestBytes,{definition,generated}),buffers=new Map();
  for(const entry of snapshot.plan.entries){const bytes=await readBounded(root,entry.path,MAX_FILE);if(bytes.length!==entry.byteLength||hash(bytes)!==entry.sha256)throw fault('INPUT_CHANGED');buffers.set(entry.path,bytes);}
  for(const item of generated)buffers.set(item.path,item.bytes);
  return {root,buffers,...snapshot};
}
function outputPath(root,output){
  if(typeof output!=='string'||!path.isAbsolute(output))throw fault('OUTPUT_INVALID');
  const resolved=path.resolve(output),base=path.join(root,'artifacts',definition.outputBase);
  if(path.dirname(resolved)!==base||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(path.basename(resolved)))throw fault('OUTPUT_INVALID');
  return resolved;
}
async function ensureOutputParents(root){
  await regularTree(root,'',{directory:true});
  for(const relative of ['artifacts','artifacts/'+definition.outputBase]){
    try{await fs.mkdir(path.join(root,...relative.split('/')));}catch(error){if(error.code!=='EEXIST')throw error;}
    await regularTree(root,relative,{directory:true});
  }
}
async function boundedEntries(directory,maximum){
  const handle=await fs.opendir(directory,{bufferSize:1}),entries=[];let primaryCode;
  try{
    for(;;){const entry=await handle.read();if(entry===null)return entries;
      if(entries.length===maximum)throw fault('ARTIFACT_INVALID');entries.push(entry);}
  }catch(error){primaryCode=error?.code;throw error;}finally{await closeRead(handle,'directory',primaryCode);}
}
async function verifyTree(root,expected,relative=''){
  const directory=path.join(root,...relative.split('/').filter(Boolean));
  await regularTree(root,relative,{directory:true});
  const actual=await boundedEntries(directory,expected.size);
  if(actual.length!==expected.size||actual.some(entry=>!expected.has(entry.name)||(expected.get(entry.name) instanceof Map?!entry.isDirectory():!entry.isFile())))throw fault('ARTIFACT_INVALID');
  for(const [name,children] of expected)if(children instanceof Map)await verifyTree(root,children,relative?relative+'/'+name:name);
}
async function createDirectories(root,expected,relative=''){
  for(const [name,children] of expected)if(children instanceof Map){const child=relative?relative+'/'+name:name;
    await fs.mkdir(path.join(root,...child.split('/')));await createDirectories(root,children,child);}
}
async function verifySnapshot(snapshot,output){
  const {root,plan,files}=snapshot;output=outputPath(root,output);
  await regularTree(root,path.relative(root,output).split(path.sep).join('/'),{directory:true});
  await verifyTree(output,treeFor([...files.keys(),'BUILD-MANIFEST.json']));
  for(const [name,expected] of files){const bytes=await readBounded(output,name,MAX_FILE);if(bytes.length!==expected.byteLength||hash(bytes)!==expected.sha256)throw fault('ARTIFACT_INVALID');}
  const metadata=await readBounded(output,'BUILD-MANIFEST.json',64*1024);
  if(!metadata.equals(json(plan)))throw fault('ARTIFACT_INVALID');
  return {...plan,output,verified:true,fileCount:files.size+1,
    buildManifest:{path:'BUILD-MANIFEST.json',sha256:hash(metadata),byteLength:metadata.length}};
}

// Fixed registrations are application code, not artifact metadata or input
// claims. They share this instance's readers, bounds and pending cleanup map.
const knownReleases=new Map();
if(options!==undefined){
  if(!options||typeof options!=='object'||Array.isArray(options)||!frozenData(options)||Reflect.ownKeys(options).length!==1||!Object.hasOwn(options,'knownReleases')||!Array.isArray(options.knownReleases)||options.knownReleases.length>MAX_ENTRIES||Reflect.ownKeys(options.knownReleases).length!==options.knownReleases.length+1)throw new Error('Invalid immutable known release registrations');
  let manifestTotal=0;
  for(const record of options.knownReleases){
    if(!record||typeof record!=='object'||Array.isArray(record)||Reflect.ownKeys(record).length!==3||!['releaseId','definition','manifestJson'].every(key=>Object.hasOwn(record,key))||typeof record.releaseId!=='string'||! /^[a-f0-9]{64}$/.test(record.releaseId)||knownReleases.has(record.releaseId)||typeof record.manifestJson!=='string')throw new Error('Invalid immutable known release registration');
    const manifestLength=Buffer.byteLength(record.manifestJson,'utf8');manifestTotal+=manifestLength;
    if(manifestLength>64*1024||manifestTotal>MAX_TOTAL)throw new Error('Invalid known release scope or budget');
    const policy=trustedDefinition(record.definition);
    if(policy.definition.component!==COMPONENT||policy.definition.outputBase!==definition.outputBase)throw new Error('Invalid known release scope or budget');
    const manifestBytes=Buffer.from(record.manifestJson,'utf8');
    const snapshot=manifestSnapshot(manifestBytes,policy);
    if(hash(json(snapshot.plan))!==record.releaseId)throw new Error('Known release identity does not match its fixed definition');
    // Public facts cannot mutate the private cached interpretation on a later
    // verification. Artifact bytes are freshly read through the original owner.
    for(const entry of snapshot.plan.entries){Object.freeze(entry.dependencies);Object.freeze(entry);}
    Object.freeze(snapshot.plan.entries);
    if(snapshot.plan.generatedFiles){for(const entry of snapshot.plan.generatedFiles)Object.freeze(entry);Object.freeze(snapshot.plan.generatedFiles);}
    Object.freeze(snapshot.plan);knownReleases.set(record.releaseId,snapshot);
  }
}
async function verifyKnownRelease(input){
  return result(async()=>{
    let captured;
    try{
      if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==3)throw fault('INVALID_INPUT');
      captured={};for(const key of Reflect.ownKeys(input)){
        const descriptor=Object.getOwnPropertyDescriptor(input,key);
        if(!['root','output','releaseId'].includes(key)||!descriptor||!Object.hasOwn(descriptor,'value'))throw fault('INVALID_INPUT');
        captured[key]=descriptor.value;
      }
      if(!['root','output','releaseId'].every(key=>Object.hasOwn(captured,key))||typeof captured.root!=='string'||!path.isAbsolute(captured.root)||typeof captured.output!=='string'||!path.isAbsolute(captured.output)||typeof captured.releaseId!=='string'||! /^[a-f0-9]{64}$/.test(captured.releaseId))throw fault('INVALID_INPUT');
    }catch{throw fault('INVALID_INPUT');}
    const snapshot=knownReleases.get(captured.releaseId);if(!snapshot)throw fault('KNOWN_RELEASE_UNAVAILABLE');
    const checked=await verifySnapshot({...snapshot,root:path.resolve(captured.root)},captured.output);
    return {...checked,verifiedAgainst:'known_release_definition',releaseId:captured.releaseId};
  });
}

async function plan({root}={}){return result(async()=> (await inputSnapshot(root)).plan);}
async function verify({root,output}={}){return result(async()=>verifySnapshot(await inputSnapshot(root),output));}
async function cleanup({cleanupId}={}){
  return result(async()=>{
    const retained=pendingReads.get(cleanupId);if(!retained)throw fault('CLEANUP_ID_INVALID');
    try{await retained.handle.close();}catch{throw fault('CLEANUP_PENDING');}
    pendingReads.delete(cleanupId);return {cleanupId,closed:true,kind:retained.kind,remaining:pendingReads.size};
  },true);
}
async function build({root,output}={}){
  return result(async()=>{
    const snapshot=await inputSnapshot(root),destination=outputPath(snapshot.root,output);
    await ensureOutputParents(snapshot.root);
    try{await fs.mkdir(destination);}catch(error){if(error.code==='EEXIST')throw fault('OUTPUT_EXISTS');throw error;}
    try{
      await createDirectories(destination,treeFor([...snapshot.buffers.keys(),'BUILD-MANIFEST.json']));
      for(const [name,bytes] of snapshot.buffers)await fs.writeFile(path.join(destination,...name.split('/')),bytes,{flag:'wx'});
      // Written last. An interrupted build leaves its exact new directory for
      // inspection; no recursive cleanup or existing output replacement occurs.
      await fs.writeFile(path.join(destination,'BUILD-MANIFEST.json'),json(snapshot.plan),{flag:'wx'});
      const fresh=await inputSnapshot(root);
      if(fresh.plan.inputManifestSha256!==snapshot.plan.inputManifestSha256)throw fault('INPUT_CHANGED');
      return await verifySnapshot(fresh,destination);
    }catch(error){if(Object.hasOwn(failures,error?.code))throw error;throw fault('BUILD_FAILED');}
  });
}

return Object.freeze({plan,build,verify,verifyKnownRelease,cleanup});
}
