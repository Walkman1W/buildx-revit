import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseProjectDocument} from './parse-project-document.mjs';
import {parseTurnAttachments,TURN_ATTACHMENT_LIMITS} from './turn-attachments.mjs';

const ok = value => ({ok:true,value});
const fail = (code,message) => ({ok:false,error:{code,message}});
const samePath = (a,b) => process.platform === 'win32'
  ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
  : path.normalize(a) === path.normalize(b);
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const fingerprint = s => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
class RootChanged extends Error {}
const rootChanged=()=>fail('ROOT_CHANGED','资料地址对应的文件或文件夹已变化，请重新选择后再试。');
const PREVIEW_CHARS = 120000;
// A page is bounded independently of file count and JSON escape expansion.
const PAGE_BYTES=32*1024,MAX_SCAN_ENTRIES=100000,CURSOR_LIMIT=256,CURSOR_TTL=120000;
const compareEntry=(a,b)=>a.kind===b.kind?(a.name<b.name?-1:a.name>b.name?1:0):a.kind==='directory'?-1:1;
const imageMime = bytes => {
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(12,16).toString('ascii')==='IHDR') return 'image/png';
  if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return 'image/jpeg';
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if(bytes.length>=16&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP') return 'image/webp';
  return null;
};
const documentFormat = (bytes,filename) => {
  const ext=path.extname(filename).toLowerCase();
  if(ext==='.pdf'&&bytes.subarray(0,5).toString('ascii')==='%PDF-') return 'pdf';
  if((ext==='.docx'||ext==='.xlsx')&&bytes.length>=4&&bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) return ext.slice(1);
  return null;
};
async function parsePreview(bytes,format,executable,timeoutMs) {
  const parsed=await parseProjectDocument(bytes,format,executable,{timeoutMs});
  if(!parsed.ok){const code=parsed.error?.code;
    return fail(code,code==='PDF_PARSER_UNAVAILABLE'?'PDF 文本解析器不可用。':code==='PDF_ENCRYPTED'?'加密 PDF 暂不能预览。':code==='PARSER_UNAVAILABLE'?'文件解析器无法启动。':code==='PARSER_TIMEOUT'?'文件解析超时。':'无法提取该文件的文本。');}
  if(parsed.value.segments.some(segment=>segment.text.length>524288)||parsed.value.warnings.some(w=>typeof w!=='string'))return fail('INVALID_PARSER_RESULT','文件解析结果不可用。');
  let text='',truncated=false;
  for(const segment of parsed.value.segments){
    const location=segment.location,prefix=format==='xlsx'&&typeof location?.sheet==='string'&&typeof location?.cell==='string'?`${location.sheet} ${location.cell}: `:'';
    const line=prefix+segment.text+'\n',remaining=PREVIEW_CHARS-text.length;
    if(line.length>remaining){text+=line.slice(0,Math.max(0,remaining));truncated=true;break;}
    text+=line;
  }
  return ok({text,truncated,warnings:parsed.value.warnings});
}
const validName = name => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
  !/[\\/\0]/.test(name) && (process.platform !== 'win32' || !name.includes(':'));
const relativeParts = value => {
  if (typeof value !== 'string' || value.length > 32768 || value.includes('\\') || value.includes('\0')) return null;
  if (value === '') return [];
  const parts = value.split('/'); return parts.every(validName) ? parts : null;
};

/** Session-owned addresses. Paths are selected by the local panel, never by a
 * model tool. Tree and read operations take a root ID and a relative path.
 * File and ancestor identity are rechecked, but portable Node filesystem APIs
 * cannot guarantee protection against a concurrent same-user path replacement. */
export function createMaterialIndex({maxRoots=64,maxEntries=500,maxFileBytes=1024*1024,pythonExecutable='python',parserTimeoutMs=10000,openLocal=null}={}) {
  if (![maxRoots,maxEntries,maxFileBytes].every(n=>Number.isSafeInteger(n)&&n>0)) throw new TypeError('Invalid project file limits');
  if(typeof pythonExecutable!=='string'||!pythonExecutable||pythonExecutable.includes('\0')||!Number.isSafeInteger(parserTimeoutMs)||parserTimeoutMs<1||parserTimeoutMs>60000)throw new TypeError('Invalid parser configuration');
  if(openLocal!==null&&typeof openLocal!=='function')throw new TypeError('Invalid local opener');
  const roots = new Map(),cursors=new Map(); let projectId = null, projectGeneration = 0, projectStatus = 'unavailable';
  const publicRoot = root => ({id:root.id,name:root.name,path:root.path,kind:root.kind,source:root.source,status:root.unavailable?'unavailable':root.needsConfirmation?'needs-confirmation':'available'});
  const still = root => roots.get(root.id) === root;
  async function examine(absolute,kind) {
    const stat = await fs.lstat(absolute,{bigint:true});
    if (stat.isSymbolicLink() || !(kind==='directory' ? stat.isDirectory() : stat.isFile())) throw new Error('unavailable');
    if (kind==='file' && stat.nlink>1n) throw new Error('hardlink');
    if (!samePath(absolute,await fs.realpath(absolute))) throw new Error('redirected');
    return stat;
  }
  async function makeRoot(absolute,kind,source) {
    const stat = await examine(absolute,kind);
    return Object.freeze({id:randomUUID(),name:path.basename(absolute)||absolute,path:absolute,kind,source,identity:identity(stat)});
  }
  async function addRoot({path:chosen,kind}={}) {
    if (typeof chosen!=='string' || !path.isAbsolute(chosen) || chosen.includes('\0') || !['file','directory'].includes(kind))
      return fail('INVALID_ROOT','请选择本机绝对文件或文件夹路径。');
    const absolute=path.resolve(chosen);
    const prior=[...roots.values()].find(item=>item.source==='user'&&item.kind===kind&&samePath(item.path,absolute));
    if (!prior&&roots.size >= maxRoots) return fail('ROOT_LIMIT','添加的资料地址已达上限。');
    try {
      const root=await makeRoot(absolute,kind,'user');
      const duplicate=[...roots.values()].find(item=>item.source==='user'&&item.kind===kind&&samePath(item.path,absolute));
      if (duplicate){
        if(!duplicate.unavailable&&!duplicate.needsConfirmation&&duplicate.identity===root.identity)return ok({root:publicRoot(duplicate),existing:true});
        // An explicit selection binds the new identity. In-flight reads and
        // existing cursors still carry the previous object.
        const restored=Object.freeze({...root,id:duplicate.id});roots.set(restored.id,restored);
        return ok({root:publicRoot(restored),existing:true,restored:true});
      }
      if (roots.size >= maxRoots) return fail('ROOT_LIMIT','添加的资料地址已达上限。');
      roots.set(root.id,root); return ok({root:publicRoot(root),existing:false});
    } catch { return fail('ROOT_UNAVAILABLE','无法访问所选地址，或它是链接、类型不符。'); }
  }
  // A persisted address is only a candidate: the backing directory does not
  // establish current user intent. Even a valid path cannot be read until the
  // user explicitly chooses it again through the panel's addRoot action.
  async function restoreRoot({path:chosen,kind}={}) {
    if(typeof chosen!=='string'||!path.isAbsolute(chosen)||chosen.includes('\0')||!['file','directory'].includes(kind))return fail('INVALID_ROOT','保存的资料地址无效。');
    const absolute=path.resolve(chosen);
    const existing=()=>[...roots.values()].find(item=>item.source==='user'&&item.kind===kind&&samePath(item.path,absolute));
    let candidate;
    try{candidate=await makeRoot(absolute,kind,'user');}
    catch{candidate=Object.freeze({id:randomUUID(),name:path.basename(absolute)||absolute,path:absolute,kind,source:'user',unavailable:true});}
    const prior=existing();
    // A live, explicitly selected root retains its authorization. A restored
    // candidate never upgrades another pending/unavailable root implicitly.
    if(prior)return ok({root:publicRoot(prior),existing:true});
    if(roots.size>=maxRoots)return fail('ROOT_LIMIT','保存的资料地址已达上限。');
    const restored=candidate.unavailable?candidate:Object.freeze({...candidate,needsConfirmation:true});
    roots.set(restored.id,restored);return ok({root:publicRoot(restored),existing:false});
  }
  function removeRoot({id}={}) {
    const root=roots.get(id);
    if (!root || root.source!=='user') return fail('ROOT_UNAVAILABLE','所选资料地址不可移除。');
    roots.delete(id); return ok({removed:true});
  }
  function listRoots() { return ok({roots:[...roots.values()].map(publicRoot),projectStatus}); }
  async function setProjectDocument({documentPath}={}) {
    const generation=++projectGeneration;
    // Immediately revoke old default while a new document is being checked.
    const old=projectId&&roots.get(projectId); if(projectId)roots.delete(projectId); projectId=null;
    if(typeof documentPath!=='string'||!documentPath.trim()){projectStatus='unsaved';return ok({projectStatus});}
    projectStatus='unavailable';
    if (!path.isAbsolute(documentPath)||documentPath.includes('\0')||path.extname(documentPath).toLowerCase()!=='.rvt') return ok({projectStatus});
    const file=path.resolve(documentPath), parent=path.dirname(file);
    try {
      await examine(file,'file');
      const candidate=await makeRoot(parent,'directory','project');
      if(generation!==projectGeneration)return fail('PROJECT_CHANGED','当前项目已变化。');
      const root=old&&samePath(old.path,parent)&&old.identity===candidate.identity?old:candidate;
      roots.set(root.id,root);projectId=root.id;projectStatus='available';return ok({projectStatus,root:publicRoot(root)});
    } catch { if(generation!==projectGeneration)return fail('PROJECT_CHANGED','当前项目已变化。');return ok({projectStatus}); }
  }
  async function resolve(rootId,relative,kind) {
    const root=roots.get(rootId), parts=relativeParts(relative);
    if(!root||root.unavailable||root.needsConfirmation||!parts||root.kind==='file'&&parts.length) throw new Error('invalid');
    const chain=[]; let absolute=root.path;
    const rootStat=await examine(absolute,root.kind);
    if(!still(root)) throw new Error('changed');
    if(identity(rootStat)!==root.identity){
      if(root.source!=='user')throw new Error('changed');
      roots.set(root.id,Object.freeze({...root,needsConfirmation:true}));
      throw new RootChanged();
    }
    chain.push([absolute,identity(rootStat)]);
    for(let i=0;i<parts.length;i++) {
      if(root.kind!=='directory')throw new Error('invalid');
      absolute=path.join(absolute,parts[i]);
      const stat=await examine(absolute,i===parts.length-1?kind:'directory');
      chain.push([absolute,identity(stat)]);
    }
    if(!parts.length&&root.kind!==kind)throw new Error('invalid');
    return {root,absolute,chain};
  }
  async function verifyChain(resolved) {
    if(!still(resolved.root)) throw new Error('changed');
    for(let i=0;i<resolved.chain.length;i++) {
      const [absolute,id]=resolved.chain[i], kind=i===resolved.chain.length-1 ? (await fs.lstat(absolute)).isDirectory()?'directory':'file' : 'directory';
      const stat=await examine(absolute,kind);if(identity(stat)!==id)throw new Error('changed');
    }
    if(!still(resolved.root)) throw new Error('changed');
  }
  async function listChildren({rootId,path:relative='',cursor=null}={}) {
    let previous=null;
    if(cursor!==null){
      if(typeof cursor!=='string'||cursor.length>100)return fail('INVALID_CURSOR','分页已失效，请重新打开文件夹。');
      previous=cursors.get(cursor);
      if(!previous)return fail('INVALID_CURSOR','分页已失效，请重新打开文件夹。');
      if(previous.expires<=Date.now()){cursors.delete(cursor);return fail('INVALID_CURSOR','分页已失效，请重新打开文件夹。');}
      if(previous.rootId!==rootId||previous.path!==relative)return fail('INVALID_CURSOR','分页不属于此文件夹，请重新打开。');
    }
    try {
      const resolved=await resolve(rootId,relative,'directory'),before=await examine(resolved.absolute,'directory');
      if(previous&&previous.root!==resolved.root)return fail('INVALID_CURSOR','资料地址已变化，请重新打开文件夹。');
      const stream=await fs.opendir(resolved.absolute), candidates=[],pageLimit=Math.min(maxEntries,500),xor=Buffer.alloc(32);
      let count=0,valid=0,sum=0n,overflow=false;
      try { for await (const entry of stream) {
        if(++count>MAX_SCAN_ENTRIES){overflow=true;break;}
        if(!validName(entry.name)||entry.isSymbolicLink()||!(entry.isDirectory()||entry.isFile()))continue;
        const candidate={name:entry.name,path:relative?`${relative}/${entry.name}`:entry.name,kind:entry.isDirectory()?'directory':'file'};
        const digest=createHash('sha256').update(candidate.kind).update('\0').update(candidate.name,'utf16le').digest();
        for(let i=0;i<32;i++)xor[i]^=digest[i];
        sum=(sum+digest.readBigUInt64BE(0))&0xffffffffffffffffn;valid++;
        if(previous&&compareEntry(candidate,previous.last)<=0)continue;
        // Retain only the lowest pageLimit+1 entries in a deterministic total
        // order, regardless of filesystem enumeration order or Unicode form.
        let lo=0,hi=candidates.length;while(lo<hi){const mid=(lo+hi)>>1;if(compareEntry(candidates[mid],candidate)<0)lo=mid+1;else hi=mid;}
        if(lo<=pageLimit){candidates.splice(lo,0,candidate);if(candidates.length>pageLimit+1)candidates.pop();}
      }} finally { await stream.close().catch(()=>{}); }
      if(overflow)return fail('DIRECTORY_TOO_LARGE','文件夹项目过多，超出一次安全扫描上限。');
      await verifyChain(resolved);
      const after=await examine(resolved.absolute,'directory'),version=`${fingerprint(after)}:${valid}:${xor.toString('hex')}:${sum.toString(16)}`;
      if(!still(resolved.root))throw new Error('changed');
      if(fingerprint(before)!==fingerprint(after)||previous&&previous.version!==version)return fail('DIRECTORY_CHANGED','文件夹内容已变化，请重新打开。');
      const entries=[];let bytes=0;
      for(const candidate of candidates){
        if(entries.length>=pageLimit)break;
        const itemBytes=Buffer.byteLength(JSON.stringify(candidate),'utf8')+1;
        if(bytes+itemBytes>PAGE_BYTES){if(!entries.length)return fail('ENTRY_TOO_LARGE','文件路径超过显示上限。');break;}
        entries.push(candidate);bytes+=itemBytes;
      }
      const truncated=entries.length<candidates.length;
      let nextCursor=null;
      if(truncated){
        if(!entries.length)return fail('ENTRY_TOO_LARGE','文件路径超过显示上限。');
        // Tokens can be retried, but do not retain file contents or authorise a
        // different root/path. Capacity and lifetime are explicitly bounded.
        for(const [id,record] of cursors){if(record.expires<=Date.now())cursors.delete(id);}
        while(cursors.size>=CURSOR_LIMIT)cursors.delete(cursors.keys().next().value);
        nextCursor=randomUUID();cursors.set(nextCursor,{rootId,path:relative,root:resolved.root,version,last:entries.at(-1),expires:Date.now()+CURSOR_TTL});
      }
      return ok({entries,truncated,nextCursor});
    } catch(error) { return error instanceof RootChanged?rootChanged():fail('DIRECTORY_UNAVAILABLE','文件夹不可访问或资料地址已变化。'); }
  }
  async function readStableFile({rootId,path:relative=''}={},limit,processBytes,{isCurrent=()=>true}={}) {
    let handle;
    try {
      if(typeof isCurrent!=='function'||await isCurrent()!==true)return fail('FILE_CONTEXT_CHANGED','对话或账号已变化，请重新选择文件。');
      const resolved=await resolve(rootId,relative,'file');
      handle=await fs.open(resolved.absolute,'r');const before=await handle.stat({bigint:true});
      const candidate=await fs.lstat(resolved.absolute,{bigint:true});
      if(!before.isFile()||before.nlink>1n||fingerprint(before)!==fingerprint(candidate))throw new Error('changed');
      const bound=typeof limit==='function'?limit(resolved):limit;
      if(bound===null)return fail('FILE_ATTACHMENT_UNSUPPORTED','暂支持 TXT、Markdown、PNG、JPEG，以及提取 PDF、DOCX、XLSX 文本。');
      if(before.size>BigInt(bound))return fail('FILE_TOO_LARGE','文件超过当前读取大小限制。');
      const bytes=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error('short');offset+=read.bytesRead;}
      const result=await processBytes(bytes,resolved);
      const after=await handle.stat({bigint:true}),pathAfter=await fs.lstat(resolved.absolute,{bigint:true});
      if(fingerprint(before)!==fingerprint(after)||fingerprint(before)!==fingerprint(pathAfter))throw new Error('changed');
      await verifyChain(resolved);
      if(await isCurrent()!==true)return fail('FILE_CONTEXT_CHANGED','对话或账号已变化，请重新选择文件。');
      if(!still(resolved.root))throw new Error('changed');
      return result;
    } catch(error) { return error instanceof RootChanged?rootChanged():fail('FILE_UNAVAILABLE','文件不可访问或资料地址已变化。'); }
    finally { await handle?.close().catch(()=>{}); }
  }
  async function readFile(args={}) {
    return readStableFile(args,maxFileBytes,async(bytes,resolved)=>{
      const mimeType=imageMime(bytes),format=documentFormat(bytes,resolved.absolute);
      let preview;
      if(mimeType)preview={kind:'image',mimeType,data:`data:${mimeType};base64,${bytes.toString('base64')}`};
      else if(format){const parsed=await parsePreview(bytes,format,pythonExecutable,parserTimeoutMs);if(!parsed.ok)return parsed;preview={kind:'text',sourceFormat:format,...parsed.value};}
      else{
        if(bytes.includes(0))return fail('FILE_NOT_TEXT','该文件不能作为文本预览。');
        let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return fail('FILE_NOT_TEXT','该文件不能作为 UTF-8 文本预览。');}
        preview={kind:'text',text};
      }
      return ok({name:path.basename(resolved.absolute),path:args.path??'',byteLength:bytes.length,...preview});
    });
  }
  async function readAttachment(args={},control={}) {
    // Parsed documents may be larger than the resulting bounded text; retain a
    // finite input budget and never misrepresent an incomplete extraction.
    const bound=resolved=>{
      const ext=path.extname(resolved.absolute).toLowerCase();
      return ['.txt','.md','.markdown'].includes(ext)?TURN_ATTACHMENT_LIMITS.textBytes:
        ['.png','.jpg','.jpeg'].includes(ext)?TURN_ATTACHMENT_LIMITS.imageBytes:
        ['.pdf','.docx','.xlsx'].includes(ext)?16*1024*1024:null;
    };
    return readStableFile(args,bound,async(bytes,resolved)=>{
      const name=path.basename(resolved.absolute),extension=path.extname(name).toLowerCase();
      let attachmentName=name,mediaType,sourceFormat='original',warnings=[],content=bytes;
      if(['.txt','.md','.markdown'].includes(extension))mediaType=extension==='.txt'?'text/plain':'text/markdown';
      else if(['.png','.jpg','.jpeg'].includes(extension))mediaType=extension==='.png'?'image/png':'image/jpeg';
      else if(['.pdf','.docx','.xlsx'].includes(extension)){
        const format=documentFormat(bytes,resolved.absolute);
        if(!format)return fail('FILE_FORMAT_INVALID','文件格式与扩展名不匹配，无法提取内容。');
        const parsed=await parsePreview(bytes,format,pythonExecutable,parserTimeoutMs);if(!parsed.ok)return parsed;
        if(parsed.value.truncated||!parsed.value.text.trim())return fail('FILE_EXTRACTION_INCOMPLETE','文件未能完整提取文本，请选择其他文件。');
        content=Buffer.from(parsed.value.text,'utf8');attachmentName=name+'.txt';mediaType='text/plain';sourceFormat='extracted';warnings=parsed.value.warnings;
      }else return fail('FILE_ATTACHMENT_UNSUPPORTED','暂支持 TXT、Markdown、PNG、JPEG，以及提取 PDF、DOCX、XLSX 文本。');
      if(content.length>(mediaType.startsWith('image/')?TURN_ATTACHMENT_LIMITS.imageBytes:TURN_ATTACHMENT_LIMITS.textBytes))return fail('FILE_ATTACHMENT_TOO_LARGE','文件内容超过对话附件大小限制。');
      const data=content.toString('base64');
      const parsed=parseTurnAttachments([{name:attachmentName,mediaType,data}]);
      if(!parsed.ok)return fail('FILE_ATTACHMENT_INVALID',parsed.error.message);
      return ok({name,attachmentName,mediaType,byteLength:content.length,data,sourceFormat,warnings});
    },control);
  }
  async function openEntry({rootId,path:relative='',kind='file'}={},control={},folder=false){
    const isCurrent=control.isCurrent??(()=>true);
    if(typeof isCurrent!=='function'||!['file','directory'].includes(kind)||!folder&&kind!=='file')return fail('FILE_OPEN_INVALID','打开请求无效。');
    if(!openLocal)return fail('FILE_OPEN_UNAVAILABLE','本机打开功能不可用。');
    try{
      if(await isCurrent()!==true)return fail('FILE_CONTEXT_CHANGED','账号或资料地址已变化，请重新选择。');
      const resolved=await resolve(rootId,relative,kind);
      // Windows shell associations for scripts/executables/shortcuts can run
      // commands rather than display a file. Folder access remains available.
      if(!folder&&/\.(?:exe|com|bat|cmd|ps1|psm1|psd1|py|pyw|pyz|jar|sh|pl|rb|vbs|vbe|js|jse|ws|wsf|wsh|sct|wsc|msh\d*(?:xml)?|hta|msi|msp|msix|msixbundle|appx|appxbundle|application|gadget|msc|dll|scr|cpl|chm|lnk|url|scf|reg|inf|pif|appref-ms|website)$/i.test(resolved.absolute))return fail('FILE_OPEN_UNSUPPORTED','此文件类型不能通过资料库直接运行，可打开所在文件夹。');
      const target=folder&&kind==='file'?path.dirname(resolved.absolute):resolved.absolute;
      const parent=folder?await examine(target,'directory'):null;
      await verifyChain(resolved);
      if(folder&&identity(await examine(target,'directory'))!==identity(parent))throw new Error('changed');
      if(await isCurrent()!==true||!still(resolved.root))return fail('FILE_CONTEXT_CHANGED','账号或资料地址已变化，请重新选择。');
      const launched=await openLocal({path:target,kind:folder?'directory':'file'});
      if(launched?.ok!==true)return launched?.error?launched:fail('FILE_OPEN_FAILED','Windows 未能打开所选位置。');
      if(await isCurrent()!==true||!still(resolved.root))return fail('FILE_CONTEXT_CHANGED_AFTER_OPEN','打开请求可能已发送；账号或资料地址已变化，请核对系统中打开的窗口。');
      return ok({opened:true});
    }catch(error){return error instanceof RootChanged?rootChanged():fail('FILE_OPEN_FAILED','无法打开文件或所在文件夹，请重新选择。');}
  }
  const openFile=(args,control)=>openEntry(args,control,false);
  const openFolder=(args,control)=>openEntry(args,control,true);
  return Object.freeze({addRoot,restoreRoot,removeRoot,listRoots,listChildren,readFile,readAttachment,openFile,openFolder,setProjectDocument});
}
