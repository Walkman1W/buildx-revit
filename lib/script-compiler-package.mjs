import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const contract=JSON.parse(readFileSync(new URL('../manifests/script-compiler-5.0.0.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&!['.','..'].includes(value);
if(contract.schemaVersion!==1||contract.package?.id!=='Microsoft.Net.Compilers.Toolset'||contract.package.version!=='5.0.0'||contract.selection?.internalCandidateOnly!==true||
  !safeName(contract.stampFile)||!Array.isArray(contract.files)||contract.files.length<1||contract.files.length>=contract.budgets.files||
  contract.files.some(file=>!safeName(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>contract.budgets.fileBytes)||
  new Set(contract.files.map(file=>file.path.toLowerCase())).size!==contract.files.length||contract.files.some(file=>file.path===contract.stampFile)||
  contract.files.reduce((sum,file)=>sum+file.bytes,0)>contract.budgets.totalBytes)throw new Error('Invalid fixed script-compiler source contract.');
const license=contract.files.find(file=>file.sourceKind==='official-repository-license');
if(!license||Buffer.byteLength(contract.licenseText,'utf8')!==license.bytes||digest(Buffer.from(contract.licenseText,'utf8'))!==license.sha256)throw new Error('Invalid fixed script-compiler license reference.');
export const SCRIPT_COMPILER_PACKAGE_CONTRACT=freeze(contract);
const fixedFiles=contract.files.map(({path,sha256,bytes})=>({path,sha256,bytes}));
const expectedStamp=freeze({schemaVersion:1,package:structuredClone(contract.package),selection:structuredClone(contract.selection),
  license:{path:license.path,sourceUrl:license.sourceUrl,sha256:license.sha256,bytes:license.bytes,sourceKind:license.sourceKind},files:fixedFiles});
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const sameIdentity=(first,second)=>first.dev===second.dev&&first.ino===second.ino&&first.birthtimeNs===second.birthtimeNs;
const sameFile=(first,second)=>sameIdentity(first,second)&&first.size===second.size&&first.mtimeNs===second.mtimeNs&&first.ctimeNs===second.ctimeNs;
const regular=value=>value.isFile()&&!value.isSymbolicLink()&&value.nlink===1n&&value.ino!==0n;
const invalid=reason=>{throw Object.assign(new Error('Script compiler package could not be verified.'),{compilerReason:reason});};

async function directoryChain(directory){
  const volume=path.parse(directory).root,records=[];let current=volume;
  for(const part of [null,...directory.slice(volume.length).split(path.sep).filter(Boolean)]){
    if(part!==null)current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino===0n)invalid('directory_identity');records.push({path:current,stat});
  }
  return records;
}
async function verifyChain(records){for(const item of records){const now=await fs.lstat(item.path,{bigint:true});if(!now.isDirectory()||now.isSymbolicLink()||!sameIdentity(item.stat,now))invalid('directory_changed');}}
async function exactEntries(directory,expected){
  const names=new Set(),handle=await fs.opendir(directory);
  try{while(true){const entry=await handle.read();if(!entry)break;if(!expected.has(entry.name)||names.has(entry.name)||!entry.isFile()||entry.isSymbolicLink()||names.size>=contract.budgets.files)invalid('unexpected_entry');names.add(entry.name);}}
  finally{await handle.close();}
  if(names.size!==expected.size)invalid('missing_file');
}
async function hashOwnedFile(filename,{bytes=null,maxBytes,retain=false,deadline}){
  const named=await fs.lstat(filename,{bigint:true});
  if(!regular(named)||named.size>BigInt(maxBytes)||bytes!==null&&named.size!==BigInt(bytes))invalid('file_identity_or_size');
  const handle=await fs.open(filename,'r');
  try{
    const opened=await handle.stat({bigint:true});if(!regular(opened)||!sameFile(named,opened))invalid('file_changed');
    const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,maxBytes+1)),chunks=[];let count=0;
    while(true){if(Date.now()>deadline)invalid('hash_budget');const result=await handle.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;count+=result.bytesRead;if(count>maxBytes)invalid('file_budget');const chunk=buffer.subarray(0,result.bytesRead);hash.update(chunk);if(retain)chunks.push(Buffer.from(chunk));}
    const after=await fs.lstat(filename,{bigint:true});if(count!==Number(opened.size)||!regular(after)||!sameFile(opened,after)||!sameFile(opened,await handle.stat({bigint:true})))invalid('file_changed');
    return {bytes:count,sha256:hash.digest('hex'),stat:opened,...retain?{content:Buffer.concat(chunks)}:{}};
  }finally{await handle.close();}
}

// The stamp supplies provenance only. This source-owned exact contract selects
// every accepted byte; extra files, invented stamp entries and links fail closed.
export async function inspectScriptCompilerPackage(directory){
  try{
    if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||path.parse(directory).root===directory)invalid('directory_argument');
    const records=await directoryChain(directory),expected=new Set([...fixedFiles.map(file=>file.path),contract.stampFile]),deadline=Date.now()+10000;
    await exactEntries(directory,expected);await verifyChain(records);
    const stampFile=await hashOwnedFile(path.join(directory,contract.stampFile),{maxBytes:contract.budgets.stampBytes,retain:true,deadline});
    const stamp=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stampFile.content).replace(/^\uFEFF/,''));
    if(canonical(stamp)!==canonical(expectedStamp))invalid('stamp_mismatch');
    const observed=[],files=[];
    for(const file of fixedFiles){
      await verifyChain(records);const result=await hashOwnedFile(path.join(directory,file.path),{bytes:file.bytes,maxBytes:contract.budgets.fileBytes,deadline});
      if(result.sha256!==file.sha256)invalid('payload_hash');observed.push({path:path.join(directory,file.path),stat:result.stat});files.push({...file});
    }
    await exactEntries(directory,expected);await verifyChain(records);
    for(const item of [...observed,{path:path.join(directory,contract.stampFile),stat:stampFile.stat}]){const current=await fs.lstat(item.path,{bigint:true});if(!regular(current)||!sameFile(item.stat,current))invalid('file_changed');}
    files.push({path:contract.stampFile,bytes:stampFile.bytes,sha256:stampFile.sha256});
    return {ok:true,value:{schemaVersion:1,id:contract.package.id,version:contract.package.version,sourceUrl:contract.package.sourceUrl,packageSha256:contract.package.sha256,files,stamp,scope:'internal-candidate'}};
  }catch(error){return {ok:false,error:{code:'SCRIPT_COMPILER_PACKAGE_INVALID',reason:error.compilerReason??(error.code==='ENOENT'?'missing_file':'unavailable'),message:'私有脚本编译器包的来源、完整性或目录归属未能核实。'}};}
}
