import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const VISUAL_ARTIFACT_LIMITS=Object.freeze({images:3,imageBytes:2*1024*1024,totalBytes:4*1024*1024,dimension:4096,pixels:16000000});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const failure=()=>new Error('视图图片的来源、完整性或大小未能核实；视觉复核未完成。');
function current(check){if(typeof check==='function'&&check()!==true)throw new Error('账号、对话或任务已变化，图片未发送。');}
async function directoryChain(directory){
  const chain=[];let cursor=directory;
  while(true){chain.unshift(cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
  const records=[];
  for(const item of chain){const stat=await lstat(item,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw failure();records.push({path:item,stat});}
  return records;
}
async function unchangedDirectories(records){
  for(const item of records){const stat=await lstat(item.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==item.stat.dev||stat.ino!==item.stat.ino)throw failure();}
}

// This owner reads only the native host's canonical per-request PNG names.
// Tool-visible paths are evidence, not authority to read an arbitrary file.
async function readVisualArtifacts({root,receipt,shouldContinue}={},retained){
  current(shouldContinue);
  if(typeof root!=='string'||!path.isAbsolute(root)||!receipt||!['capture_view','inspect_elements'].includes(receipt.operation)||!/^[a-f0-9]{32}$/.test(receipt.hostSession??'')||!uuid(receipt.request_id)||receipt.value?.schema_version!==1||receipt.value.operation!==receipt.operation||receipt.value.host_session!==receipt.hostSession||receipt.value.success!==true||receipt.value.cleanup_pending===true||!['unchanged','restored'].includes(receipt.value.restoration?.status)||receipt.value.restoration.source_view_unchanged!==true)throw failure();
  const images=receipt.value.images;
  if(!Array.isArray(images)||images.length<1||images.length>VISUAL_ARTIFACT_LIMITS.images)throw failure();
  const captureRoot=path.resolve(root,'workbench','visual-captures'),directory=path.join(captureRoot,receipt.hostSession,receipt.request_id);
  const ids=new Set();let total=0;
  for(const image of images){
    if(!image||!uuid(image.artifact_id)||ids.has(image.artifact_id)||image.request_id!==receipt.request_id||typeof image.path!=='string'||!path.isAbsolute(image.path)||!samePath(path.resolve(image.path),path.join(directory,image.artifact_id+'.png'))||!Number.isSafeInteger(image.bytes)||image.bytes<33||image.bytes>VISUAL_ARTIFACT_LIMITS.imageBytes||typeof image.sha256!=='string'||!/^[a-f0-9]{64}$/.test(image.sha256)||!['width','height'].every(key=>Number.isSafeInteger(image[key])&&image[key]>0&&image[key]<=VISUAL_ARTIFACT_LIMITS.dimension)||image.width*image.height>VISUAL_ARTIFACT_LIMITS.pixels||!['current','isometric','front','side'].includes(image.orientation))throw failure();
    ids.add(image.artifact_id);total+=image.bytes;if(total>VISUAL_ARTIFACT_LIMITS.totalBytes)throw failure();
  }
  const directories=await directoryChain(directory),files=[],contentItems=[];
  for(const image of images){
    current(shouldContinue);await unchangedDirectories(directories);
    const filename=path.join(directory,image.artifact_id+'.png'),before=await lstat(filename,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(image.bytes))throw failure();
    const handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let bytes;
    try{
      const opened=await handle.stat({bigint:true});if(!opened.isFile()||opened.nlink!==1n||!sameFile(before,opened))throw failure();
      bytes=Buffer.alloc(image.bytes);let read=0;
      while(read<bytes.length){const part=await handle.read(bytes,read,bytes.length-read,read);if(!part.bytesRead)throw failure();read+=part.bytesRead;}
      if(!sameFile(opened,await handle.stat({bigint:true})))throw failure();
      const named=await lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||!sameFile(opened,named))throw failure();
    }finally{try{await handle.close();}catch(error){retained.add(handle);throw error;}}
    await unchangedDirectories(directories);current(shouldContinue);
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw failure();
    files.push({id:randomUUID(),name:'视图截图-'+image.orientation+'-'+image.artifact_id+'.png',kind:'image',mediaType:'image/png',bytes:bytes.length,sha256:image.sha256,data:bytes});
    contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,'+bytes.toString('base64')});
  }
  current(shouldContinue);return {files,contentItems};
}

export function createVisualArtifactOwner({root}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new TypeError('Absolute BuildX root required.');
  const retained=new Set();let closing=false,work=null;
  async function cleanup(){
    for(const handle of [...retained])try{await handle.close();retained.delete(handle);}catch{}
    return {closed:retained.size===0};
  }
  async function read(receipt,{shouldContinue}={}){
    if(closing||work||retained.size)throw new Error('视图图片仍在读取或清理，请稍后核对。');
    work=readVisualArtifacts({root,receipt,shouldContinue},retained);
    try{return await work;}catch(error){if(typeof error?.code==='string')throw failure();throw error;}finally{work=null;}
  }
  async function close(){closing=true;if(work)try{await work;}catch{}return cleanup();}
  return Object.freeze({read,cleanup,close});
}
