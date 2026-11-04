import {constants} from 'node:fs';
import {lstat,mkdir,open,opendir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
import {panelConversationId,panelSnapshot,projectPanelConversation,panelConversationEvents} from './panel-chat-format.mjs';
import {recoverAbandonedChatLock} from './chat-lock-recovery.mjs';

const fail = (code, message) => ({ok:false,error:{code,message}});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const keys = (value, names) => plain(value) && Object.keys(value).every(key => names.includes(key));
const json = value => JSON.parse(JSON.stringify(value));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const types = new Set(['turn.started','turn.finished','draft.saved']);
const emptyDraft = () => ({text:'',references:[],includeSelection:false});
const ATTACHMENT_FILE_BYTES=2*1024*1024,ATTACHMENT_TURN_BYTES=4*1024*1024;
const ATTACHMENT_SCOPE_BYTES=256*1024*1024,ATTACHMENT_SCOPE_COUNT=512;
const attachmentSuffixes=Object.freeze(['.attachment','.attachment.png','.attachment.jpg']);
const attachmentId=name=>{const suffix=typeof name==='string'&&attachmentSuffixes.find(value=>name.endsWith(value));return suffix&&panelConversationId(name.slice(0,-suffix.length))?name.slice(0,-suffix.length):null;};
const attachmentFilename=name=>attachmentId(name)!==null;
const attachmentName=file=>file.id+(file.kind==='image'?(file.mediaType==='image/png'?'.attachment.png':'.attachment.jpg'):'.attachment');
// The HTTP parser owns content interpretation. This owner separately proves the
// bounded bytes and digest before retaining a copy across asynchronous work.
function attachmentSnapshots(files){
  if(!Array.isArray(files)||files.length>4)throw ioError('CHAT_ATTACHMENT_INVALID','每轮最多添加4个附件。');
  const ids=new Set();let total=0;
  for(const file of files){
    if(!keys(file,['id','name','kind','mediaType','bytes','sha256','data','text'])||![Object.prototype,null].includes(Object.getPrototypeOf(file))||Object.values(Object.getOwnPropertyDescriptors(file)).some(value=>!Object.hasOwn(value,'value'))||!panelConversationId(file.id)||ids.has(file.id)||typeof file.name!=='string'||file.name.length<1||file.name.length>255||file.name.includes('\0')||!['text','image'].includes(file.kind)||!(file.kind==='text'?['text/plain','text/markdown'].includes(file.mediaType):['image/png','image/jpeg'].includes(file.mediaType))||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>ATTACHMENT_FILE_BYTES||!Buffer.isBuffer(file.data)||file.data.length!==file.bytes||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||file.text!==undefined&&typeof file.text!=='string')throw ioError('CHAT_ATTACHMENT_INVALID','附件快照格式或大小无效。');
    ids.add(file.id);total+=file.bytes;if(total>ATTACHMENT_TURN_BYTES)throw ioError('CHAT_ATTACHMENT_LIMIT','本轮附件超过4MiB保存预算。');
  }
  return files.map(file=>{const data=Buffer.from(file.data);if(createHash('sha256').update(data).digest('hex')!==file.sha256)throw ioError('CHAT_ATTACHMENT_CHANGED','附件正文与摘要不一致，未保存。');return {metadata:Object.freeze({id:file.id,name:file.name,kind:file.kind,mediaType:file.mediaType,bytes:file.bytes,sha256:file.sha256}),data};});
}

function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (plain(value)) return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function safeJson(value) {
  const pending = [{value,depth:0}]; let examined=0;
  while(pending.length) {
    const current=pending.pop(); if(++examined>20000||current.depth>32)return false;
    const entry=current.value;
    if(entry===null||typeof entry==='string'||typeof entry==='boolean')continue;
    if(typeof entry==='number'){if(!Number.isFinite(entry))return false;continue;}
    if(!Array.isArray(entry)&&!plain(entry))return false;
    for(const item of Object.values(entry))pending.push({value:item,depth:current.depth+1});
  }
  return true;
}
function references(value) {
  return Array.isArray(value)&&value.length<=100&&value.every(item=>plain(item)&&typeof item.path==='string'&&
    item.path.length>0&&typeof item.text==='string'&&safeJson(item));
}
function mentions(value,text) {
  if(!Array.isArray(value)||value.length>200)return false;
  let end=0;
  for(const item of value) {
    if(!keys(item,['start','end','id','name'])||!Number.isSafeInteger(item.start)||item.start<end||
      !Number.isSafeInteger(item.end)||item.end<=item.start||item.end>text.length||
      typeof item.id!=='string'||typeof item.name!=='string')return false;
    end=item.end;
  }
  return true;
}
function validPayload(type,payload) {
  if(type==='draft.saved')return keys(payload,['text','references','includeSelection'])&&typeof payload.text==='string'&&references(payload.references)&&typeof payload.includeSelection==='boolean';
  if(type==='turn.started') {
    const user=payload?.user;
    return keys(payload,['turnId','user','includeSelection'])&&uuid(payload.turnId)&&typeof payload.includeSelection==='boolean'&&
      keys(user,['id','text','mentions','references','attachments'])&&uuid(user.id)&&typeof user.text==='string'&&
      mentions(user.mentions,user.text)&&references(user.references)&&Array.isArray(user.attachments)&&
      user.attachments.length<=100&&user.attachments.every(name=>typeof name==='string'&&name.length<=8192);
  }
  if(type==='turn.finished') {
    const assistant=payload?.assistant,tool=assistant?.tool;
    return keys(payload,['turnId','assistant','status'])&&uuid(payload.turnId)&&['completed','failed','stopped'].includes(payload.status)&&
      keys(assistant,['id','text','tool'])&&uuid(assistant.id)&&typeof assistant.text==='string'&&
      (tool===null||(keys(tool,['name','status'])&&typeof tool.name==='string'&&typeof tool.status==='string'));
  }
  return false;
}
function titleOf(user) {
  const text=user.text.replace(/\s+/gu,' ').trim();
  return [...(text||user.references[0]?.path.split(/[\\/]/u).at(-1)||user.attachments[0]||'新对话')].slice(0,28).join('');
}
function project(id,events) {
  if(!events.length||events[0].type!=='session.created')return fail('CHAT_LOG_INVALID','对话记录缺少创建信息。');
  const created=events[0];
  const session={id,title:'新对话',createdAt:created.timestamp,updatedAt:created.timestamp,messageCount:0,preview:''};
  const messages=[],turns=new Set(),ids=new Set(); let pendingTurnId=null,draft=emptyDraft();
  for(let index=0;index<events.length;index++) {
    const event=events[index];
    if(!keys(event,['schemaVersion','source','sessionId','id','type','timestamp','payload'])||event.schemaVersion!==1||event.source!=='ui-preview'||
      event.sessionId!==id||!uuid(event.id)||!date(event.timestamp)||ids.has(event.id))return fail('CHAT_LOG_INVALID','对话记录格式无效，请保留原文件并检查。');
    ids.add(event.id);
    if(index===0){if(event.type!=='session.created'||!keys(event.payload,[])||Object.keys(event.payload).length)return fail('CHAT_LOG_INVALID','对话创建记录无效。');continue;}
    if(!types.has(event.type)||!validPayload(event.type,event.payload))return fail('CHAT_LOG_INVALID','对话事件格式无效，请保留原文件并检查。');
    const payload=event.payload;
    if(event.type==='turn.started') {
      if(pendingTurnId||turns.has(payload.turnId)||messages.some(message=>message.id===payload.user.id))return fail('CHAT_LOG_INVALID','对话轮次顺序无效。');
      turns.add(payload.turnId); pendingTurnId=payload.turnId;
      if(!messages.length)session.title=titleOf(payload.user);
      messages.push({...json(payload.user),reply:false,turnId:payload.turnId,includeSelection:payload.includeSelection,timestamp:event.timestamp});
      messages.push({id:'pending:'+payload.turnId,text:'',reply:true,turnId:payload.turnId,pending:true,status:'pending',timestamp:event.timestamp});
      draft={...emptyDraft(),includeSelection:payload.includeSelection};
    } else if(event.type==='turn.finished') {
      if(pendingTurnId!==payload.turnId||messages.some(message=>message.id===payload.assistant.id))return fail('CHAT_LOG_INVALID','对话结果与当前轮次不匹配。');
      const pending=messages.at(-1);
      if(!pending?.pending||pending.turnId!==payload.turnId)return fail('CHAT_LOG_INVALID','对话结果缺少对应请求。');
      messages[messages.length-1]={...json(payload.assistant),reply:true,turnId:payload.turnId,pending:false,status:payload.status,timestamp:event.timestamp};
      pendingTurnId=null;
    } else draft=json(payload);
    session.updatedAt=event.timestamp;
  }
  session.messageCount=messages.filter(message=>!message.pending).length;
  const last=messages.findLast(message=>!message.pending);
  session.preview=last?[...last.text.replace(/\s+/gu,' ')].slice(0,100).join(''):'';
  return {ok:true,session,messages,draft,...(pendingTurnId?{pendingTurnId}:{})};
}

const ioError=(code,message)=>Object.assign(new Error(message),{chatCode:code});
const fileIdentity=stat=>{
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1n)throw ioError('CHAT_LOG_INVALID','对话记录不是独立普通文件。');
  if(typeof stat.dev!=='bigint'||typeof stat.ino!=='bigint'||stat.ino===0n||typeof stat.birthtimeNs!=='bigint')throw ioError('CHAT_IDENTITY_UNKNOWN','文件身份无法核实。');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};
const codeOf=error=>error?.chatCode??(error?.code==='ENOENT'?'CHAT_SESSION_NOT_FOUND':error?.code==='EEXIST'?'CHAT_LOG_CHANGED':'CHAT_STORE_UNAVAILABLE');

// Shared by both named formats. The audit module remains a body-free sink;
// only its existing directory identity observations are reused here.
function createJsonlOwner(stateDirectory,{maxFileBytes,maxEventBytes,exclusive=false,openFile=open,attachmentScopeBytes=ATTACHMENT_SCOPE_BYTES}){
  let chain=[],pendingDirectory=stateDirectory,admission=null;
  const missing=[];
  while(true){
    const observed=inspectExistingPanelDirectory(pendingDirectory);
    if(observed.ok){chain=observed.value.chain.map(item=>({...item}));break;}
    if(observed.error.code!=='audit_directory_missing'){admission='CHAT_DIRECTORY_INVALID';break;}
    const parent=path.dirname(pendingDirectory);if(parent===pendingDirectory){admission='CHAT_DIRECTORY_INVALID';break;}
    missing.unshift(pendingDirectory);pendingDirectory=parent;
  }
  const directories=new Map(),retained=new Map();
  let tail=Promise.resolve(),accepting=true,closed=false,lock=null,blocked=null,retentionTimer=null;
  const serial=action=>{const job=tail.then(action,action);tail=job.catch(()=>{});return job;};
  const result=(code,message)=>fail(code,message??'本地对话记录暂不可用，原文件已保留。');
  const comparePath=value=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);
  const sameChain=(observed,expected)=>observed.length===expected.length&&observed.every((part,index)=>part.identity===expected[index].identity&&comparePath(part.path)===comparePath(expected[index].path));
  function verify(expected){const observed=inspectExistingPanelDirectory(expected.at(-1).path);if(!observed.ok||!sameChain(observed.value.chain,expected))throw ioError('CHAT_DIRECTORY_CHANGED','对话目录身份已变化。');}
  function retainedFault(){const item=[...retained.values()][0]??lock;if(!item)return result(blocked??'CHAT_STORE_CLOSED');return {ok:false,error:{code:'CHAT_CLEANUP_PENDING',message:'本地保存句柄尚未关闭，请先核对清理。',cleanupId:item.cleanupId,...item.primaryCode?{primaryCode:item.primaryCode}:{}}};}
  function ensureUsable(){if(!accepting||closed)throw ioError('CHAT_STORE_CLOSED','本地保存已关闭。');if(admission)throw ioError(admission,'对话目录未通过检查。');if(blocked||retained.size)throw ioError('CHAT_CLEANUP_PENDING','本地保存清理尚未确认。');}
  async function closeHandle(item){
    try{await item.handle.close();retained.delete(item.cleanupId);}
    catch{retained.set(item.cleanupId,item);retentionTimer??=setInterval(()=>{},2**30);throw ioError('CHAT_CLEANUP_PENDING','本地保存句柄关闭未确认。');}
    if(!retained.size&&retentionTimer!==null){clearInterval(retentionTimer);retentionTimer=null;}
  }
  async function withHandle(file,flags,operation){
    const handle=await openFile(file,flags),item={handle,cleanupId:randomUUID()};let value,error;
    try{value=await operation(handle);}catch(caught){error=caught;}
    try{await closeHandle(item);}catch(caught){if(error)item.primaryCode=codeOf(error);error=caught;}
    if(error)throw error;return value;
  }
  async function prepare(){
    ensureUsable();verify(chain);
    while(missing.length){const next=missing[0];await mkdir(next);const observed=inspectExistingPanelDirectory(next);if(!observed.ok||!sameChain(observed.value.chain.slice(0,chain.length),chain))throw ioError('CHAT_DIRECTORY_CHANGED','创建期间目录身份已变化。');chain=observed.value.chain.map(item=>({...item}));missing.shift();}
    verify(chain);
    if(exclusive&&!lock){
      const file=path.join(stateDirectory,'.panel-chat.lock');let handle;
      try{handle=await openFile(file,'wx');}catch(error){
        if(error.code!=='EEXIST')throw error;
        // A recovery succeeds only when Windows grants an exclusive handle to
        // the exact original lock and the helper archives it while holding
        // that handle. PID absence by itself is never sufficient proof.
        if(!await recoverAbandonedChatLock(file,chain))throw ioError('CHAT_STORE_LOCKED','对话目录已由其他保存实例占用或锁状态无法核实，未接管。');
        verify(chain);
        try{handle=await openFile(file,'wx');}catch(retry){if(retry.code==='EEXIST')throw ioError('CHAT_STORE_LOCKED','对话目录已由其他保存实例占用，未接管。');throw retry;}
      }
      lock={handle,cleanupId:randomUUID(),identity:null,closed:false,file};
      try{lock.identity=fileIdentity(await handle.stat({bigint:true}));if(fileIdentity(await lstat(file,{bigint:true}))!==lock.identity)throw ioError('CHAT_LOG_CHANGED','保存锁身份已变化。');verify(chain);await handle.writeFile(JSON.stringify({schemaVersion:2,source:'local-codex-panel',owner:randomUUID(),pid:process.pid,createdUtc:new Date().toISOString()})+'\n');await handle.sync();}
      catch(error){blocked=codeOf(error);throw error;}
    }
    if(lock){if(lock.closed||fileIdentity(await lock.handle.stat({bigint:true}))!==lock.identity||fileIdentity(await lstat(lock.file,{bigint:true}))!==lock.identity)throw ioError('CHAT_LOG_CHANGED','保存锁身份已变化。');}
  }
  async function directory(subdir,create){
    if(subdir!==''&&!/^[a-f0-9]{64}$/.test(subdir))throw ioError('CHAT_SCOPE_INVALID','对话分区无效。');
    if(create||exclusive)await prepare();else{ensureUsable();if(missing.length)throw ioError('CHAT_SESSION_NOT_FOUND','未找到对话目录。');verify(chain);}
    if(!subdir)return chain;
    const target=path.join(stateDirectory,subdir),known=directories.get(subdir);if(known){verify(known);return known;}
    let observed=inspectExistingPanelDirectory(target);
    if(!observed.ok){if(!create||observed.error.code!=='audit_directory_missing')throw ioError(observed.error.code==='audit_directory_missing'?'CHAT_SESSION_NOT_FOUND':'CHAT_DIRECTORY_INVALID','对话分区不可用。');verify(chain);await mkdir(target);observed=inspectExistingPanelDirectory(target);}
    if(!observed.ok||!sameChain(observed.value.chain.slice(0,chain.length),chain))throw ioError('CHAT_DIRECTORY_CHANGED','对话分区身份已变化。');
    const value=observed.value.chain.map(item=>({...item}));directories.set(subdir,value);verify(value);return value;
  }
  const destination=(subdir,name)=>{if(!(uuid(name.slice(0,-6))&&name.endsWith('.jsonl'))&&!(exclusive&&attachmentFilename(name)))throw ioError('CHAT_SESSION_INVALID','对话编号无效。');return path.join(stateDirectory,subdir,name);};
  async function readOwned(subdir,name,budget=maxFileBytes){
    try{const expected=await directory(subdir,false),file=destination(subdir,name),named=await lstat(file,{bigint:true}),id=fileIdentity(named);
      if(named.size>BigInt(Math.min(attachmentFilename(name)?ATTACHMENT_FILE_BYTES:maxFileBytes,budget)))throw ioError('CHAT_LOG_LIMIT','对话记录超过本次读取预算。');
      return await withHandle(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0),async handle=>{
        const info=await handle.stat({bigint:true});if(fileIdentity(info)!==id||info.size!==named.size||fileIdentity(await lstat(file,{bigint:true}))!==id)throw ioError('CHAT_LOG_CHANGED','读取前记录已变化。');verify(expected);
        const size=Number(info.size),bytes=Buffer.alloc(size+1);let offset=0;
        while(offset<bytes.length){const piece=await handle.read(bytes,offset,bytes.length-offset,offset);if(!piece.bytesRead)break;offset+=piece.bytesRead;}
        const after=await handle.stat({bigint:true});verify(expected);
        if(offset!==size||fileIdentity(after)!==id||after.size!==info.size||after.mtimeNs!==info.mtimeNs||fileIdentity(await lstat(file,{bigint:true}))!==id)throw ioError('CHAT_LOG_CHANGED','读取期间记录已变化。');
        return {ok:true,bytes:bytes.subarray(0,size),info:{identity:id,size,mtimeNs:after.mtimeNs},bytesRead:size};
      });
    }catch(error){return retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined);}
  }
  const read=(subdir,name,budget=maxFileBytes)=>serial(()=>readOwned(subdir,name,budget));
  const readAttachment=(subdir,id)=>serial(async()=>{try{
    if(!exclusive||!panelConversationId(id))throw ioError('CHAT_ATTACHMENT_INVALID','附件编号无效。');
    const expected=await directory(subdir,false),found=[];
    for(const suffix of attachmentSuffixes){const name=id+suffix;try{await lstat(destination(subdir,name),{bigint:true});found.push(name);}catch(error){if(error.code!=='ENOENT')throw error;}}
    verify(expected);if(found.length!==1)throw ioError(found.length?'CHAT_ATTACHMENT_AMBIGUOUS':'CHAT_SESSION_NOT_FOUND',found.length?'附件编号对应多个快照，未猜选。':'未找到附件快照。');
    return readOwned(subdir,found[0],ATTACHMENT_FILE_BYTES);
  }catch(error){return retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined);}});
  async function names(subdir){return serial(async()=>{let item,value,error;try{const expected=await directory(subdir,false);const handle=await opendir(path.join(stateDirectory,subdir));item={handle,cleanupId:randomUUID()};const names=[];let examined=0;while(true){const entry=await handle.read();if(!entry)break;if(++examined>4096)throw ioError('CHAT_SESSION_LIMIT','目录条目超过读取预算。');if(!entry.name.endsWith('.jsonl')||!uuid(entry.name.slice(0,-6)))continue;if(names.length>=2000)throw ioError('CHAT_SESSION_LIMIT','对话数量超过目录预算。');names.push({name:entry.name,file:entry.isFile()&&!entry.isSymbolicLink()});}verify(expected);value={ok:true,names:names.sort((a,b)=>a.name.localeCompare(b.name))};}catch(caught){error=caught;}if(item)try{await closeHandle(item);}catch(caught){if(error)item.primaryCode=codeOf(error);error=caught;}return error?retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined):value;});}
  async function write(subdir,name,bytes,expectedInfo){return serial(async()=>{try{
    const expected=await directory(subdir,true),file=destination(subdir,name);verify(expected);
    if(bytes.length>maxFileBytes)throw ioError('CHAT_LOG_LIMIT','对话记录达到保存预算。');
    if(expectedInfo){const observed=await lstat(file,{bigint:true});if(fileIdentity(observed)!==expectedInfo.identity||Number(observed.size)!==expectedInfo.size||observed.mtimeNs!==expectedInfo.mtimeNs)throw ioError('CHAT_LOG_CHANGED','保存前记录已变化。');}
    const flags=expectedInfo?constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW||0):'wx';
    return await withHandle(file,flags,async handle=>{const opened=await handle.stat({bigint:true}),id=fileIdentity(opened);if(expectedInfo&&(id!==expectedInfo.identity||Number(opened.size)!==expectedInfo.size||opened.mtimeNs!==expectedInfo.mtimeNs))throw ioError('CHAT_LOG_CHANGED','保存前记录已变化。');if(fileIdentity(await lstat(file,{bigint:true}))!==id)throw ioError('CHAT_LOG_CHANGED','记录名称已变化。');verify(expected);if(opened.size+BigInt(bytes.length)>BigInt(maxFileBytes))throw ioError('CHAT_LOG_LIMIT','当前对话记录已达到保存上限，请新建对话。');await handle.writeFile(bytes);await handle.sync();const after=await handle.stat({bigint:true});verify(expected);if(fileIdentity(after)!==id||fileIdentity(await lstat(file,{bigint:true}))!==id||after.size!==opened.size+BigInt(bytes.length))throw ioError('CHAT_WRITE_UNKNOWN','对话写入结果未能核对。');return {ok:true};});
  }catch(error){return retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined);}});}
  // Attachments share the transcript's serial admission, directory identity,
  // exclusive lock and cleanup owner. No second runtime or sidecar metadata.
  async function writeAttachments(subdir,files){return serial(async()=>{
    const saved=[],created=[];try{
      if(!exclusive)throw ioError('CHAT_ATTACHMENT_INVALID','此记录格式不保存附件。');
      const expected=await directory(subdir,true),observed=[],observedIds=new Set();let count=0,total=0,examined=0;
      const handle=await opendir(path.join(stateDirectory,subdir)),item={handle,cleanupId:randomUUID()};let scanError;
      try{while(true){const entry=await handle.read();if(!entry)break;if(++examined>4096)throw ioError('CHAT_SESSION_LIMIT','目录条目超过读取预算。');if(!attachmentSuffixes.some(value=>entry.name.endsWith(value)))continue;
          const id=attachmentId(entry.name);if(!id)throw ioError('CHAT_ATTACHMENT_INVALID','附件目录包含无法核实的快照。');
          if(observedIds.has(id))throw ioError('CHAT_ATTACHMENT_AMBIGUOUS','附件编号对应多个快照，未猜选。');observedIds.add(id);
          const file=destination(subdir,entry.name),info=await lstat(file,{bigint:true}),identity=fileIdentity(info);count++;total+=Number(info.size);
          if(info.size>BigInt(ATTACHMENT_FILE_BYTES)||count>ATTACHMENT_SCOPE_COUNT||total>attachmentScopeBytes)throw ioError('CHAT_ATTACHMENT_LIMIT','本地附件已达到保存上限。');
          observed.push({file,identity,size:info.size,mtimeNs:info.mtimeNs});
        }verify(expected);
      }catch(error){scanError=error;}
      try{await closeHandle(item);}catch(error){if(scanError)item.primaryCode=codeOf(scanError);scanError=error;}
      if(scanError)throw scanError;
      if(count+files.length>ATTACHMENT_SCOPE_COUNT||total+files.reduce((sum,file)=>sum+file.data.length,0)>attachmentScopeBytes)throw ioError('CHAT_ATTACHMENT_LIMIT','本地附件已达到保存上限。');
      // Preflight every name and all counted identities before creating a file.
      // Partial writes are retained and count toward the next admission.
      for(const file of files)for(const suffix of attachmentSuffixes){try{await lstat(destination(subdir,file.metadata.id+suffix),{bigint:true});throw ioError('CHAT_ATTACHMENT_EXISTS','附件编号已存在，未覆盖原快照。');}catch(error){if(error.code!=='ENOENT')throw error;}}
      for(const value of observed){const info=await lstat(value.file,{bigint:true});if(fileIdentity(info)!==value.identity||info.size!==value.size||info.mtimeNs!==value.mtimeNs)throw ioError('CHAT_ATTACHMENT_CHANGED','附件目录在保存前已变化。');}verify(expected);
      for(const value of files){const file=destination(subdir,attachmentName(value.metadata));
        await withHandle(file,'wx',async output=>{created.push(value.metadata.id);const opened=await output.stat({bigint:true}),identity=fileIdentity(opened);if(opened.size!==0n||fileIdentity(await lstat(file,{bigint:true}))!==identity)throw ioError('CHAT_ATTACHMENT_CHANGED','附件文件身份无法核实。');verify(expected);await output.writeFile(value.data);await output.sync();const after=await output.stat({bigint:true});verify(expected);if(fileIdentity(after)!==identity||fileIdentity(await lstat(file,{bigint:true}))!==identity||after.size!==BigInt(value.data.length))throw ioError('CHAT_WRITE_UNKNOWN','附件保存结果尚未确认。');});
        saved.push(value.metadata);
      }
      return {ok:true,attachments:Object.freeze(saved),localImages:Object.freeze(saved.filter(file=>file.kind==='image').map(file=>Object.freeze({type:'localImage',path:destination(subdir,attachmentName(file))})))};
    }catch(error){const failure=retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined);return {...failure,attachments:Object.freeze(saved),...(created.length?{partial:true,createdIds:Object.freeze(created),retainedSnapshots:true}:{})};}
  });}
  const ready=()=>serial(async()=>{try{await prepare();return {ok:true,value:{closed:false}};}catch(error){return retained.size?retainedFault():result(codeOf(error),error.chatCode?error.message:undefined);}});
  async function releaseLock(){
    if(!lock)return;
    verify(chain);if(!lock.identity||fileIdentity(await lstat(lock.file,{bigint:true}))!==lock.identity)throw ioError('CHAT_LOG_CHANGED','保存锁身份已变化，未删除其他文件。');
    if(!lock.closed){try{await lock.handle.close();lock.closed=true;}catch{retentionTimer??=setInterval(()=>{},2**30);throw ioError('CHAT_CLEANUP_PENDING','保存锁关闭未确认。');}}
    verify(chain);if(fileIdentity(await lstat(lock.file,{bigint:true}))!==lock.identity)throw ioError('CHAT_LOG_CHANGED','保存锁身份已变化，未删除其他文件。');await unlink(lock.file);lock=null;
  }
  const close=()=>{accepting=false;return serial(async()=>{try{for(const item of [...retained.values()])await closeHandle(item);await releaseLock();closed=true;if(retentionTimer!==null){clearInterval(retentionTimer);retentionTimer=null;}return {ok:true,value:{closed:true}};}catch(error){return retainedFault();}});};
  const cleanup=id=>serial(async()=>{const item=retained.get(id);try{if(item)await closeHandle(item);else if(lock?.cleanupId===id)await releaseLock();else return result('CHAT_CLEANUP_ID_INVALID','清理编号无效。');if(!retained.size&&blocked==='CHAT_CLEANUP_PENDING')blocked=null;if(!accepting&&!retained.size){await releaseLock();closed=true;}if(!retained.size&&!lock&&retentionTimer!==null){clearInterval(retentionTimer);retentionTimer=null;}return {ok:true,value:{closed}};}catch{return retainedFault();}});
  return {read,names,write,writeAttachments,readAttachment,ready,close,cleanup};
}

function decodeLines(bytes,maxEventBytes,overhead=1024,maxEvents=100000){
  try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.endsWith('\n'))return fail('CHAT_LOG_INCOMPLETE','对话记录末尾未写完整，原文件已保留。');const lines=text.slice(0,-1).split('\n');if(lines.length>maxEvents)return fail('CHAT_LOG_LIMIT','对话事件数量超过读取范围。');return {ok:true,events:lines.map(line=>{if(!line||Buffer.byteLength(line)>maxEventBytes+overhead)throw new Error();return JSON.parse(line);})};}catch{return fail('CHAT_LOG_INVALID','对话记录无法读取，原文件已保留。');}
}

/** Owns immutable, versioned JSONL events; UI messages are only derived views.
 * No credentials, file bodies or ambient process environment are collected here.
 */
export function createChatStore({stateDirectory,maxFileBytes=16*1024*1024,maxEventBytes=256*1024,maxSessions=2000,
  now=()=>new Date().toISOString()}={}) {
  if(typeof stateDirectory!=='string'||!path.isAbsolute(stateDirectory)||typeof now!=='function'||
    ![maxFileBytes,maxEventBytes,maxSessions].every(value=>Number.isSafeInteger(value)&&value>0))throw new TypeError('Absolute chat directory and positive budgets required.');
  const queues=new Map();
  const io=createJsonlOwner(stateDirectory,{maxFileBytes,maxEventBytes});
  const serial=(id,action)=>{const previous=queues.get(id)||Promise.resolve(),work=previous.then(action,action);queues.set(id,work);
    void work.finally(()=>{if(queues.get(id)===work)queues.delete(id);}).catch(()=>{});return work;};
  const filename=id=>id.toLowerCase()+'.jsonl';
  async function read(id) {
    const file=await io.read('',filename(id));if(!file.ok)return file;
    const decoded=decodeLines(file.bytes,maxEventBytes);if(!decoded.ok)return decoded;
    const result=project(id.toLowerCase(),decoded.events);return result.ok?{...result,events:decoded.events,info:file.info}:result;
  }
  async function listSessions() {
    const sessions=[],directory=await io.names('');if(!directory.ok)return directory.error.code==='CHAT_SESSION_NOT_FOUND'?{ok:true,sessions}:directory;
    for(const entry of directory.names) {
      const id=entry.name.slice(0,-6);if(!uuid(id))continue;
      if(!entry.file)return fail('CHAT_LOG_INVALID','本地对话记录的文件类型无效。');
      if(sessions.length>=maxSessions)return fail('CHAT_SESSION_LIMIT','本地对话数量超过读取范围。');
      const result=await serial(id,()=>read(id));
      if(!result.ok)return {...result,sessionId:id};
      sessions.push(result.session);
    }
    sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    return {ok:true,sessions};
  }
  function getSession(id) {
    if(!uuid(id))return Promise.resolve(fail('CHAT_SESSION_INVALID','对话编号无效。'));
    return serial(id.toLowerCase(),async()=>{const result=await read(id);if(!result.ok)return result;const {events,info,...view}=result;return view;});
  }
  function createSession(id) {
    if(!uuid(id))return Promise.resolve(fail('CHAT_SESSION_INVALID','对话编号无效。'));
    id=id.toLowerCase();
    return serial('$create',()=>serial(id,async()=>{
      const existing=await read(id);if(existing.ok)return {ok:true,session:existing.session,created:false};
      if(existing.error.code!=='CHAT_SESSION_NOT_FOUND')return existing;
      const directory=await io.names('');if(!directory.ok&&directory.error.code!=='CHAT_SESSION_NOT_FOUND')return directory;
      if(directory.ok&&directory.names.filter(entry=>entry.file).length>=maxSessions)return fail('CHAT_SESSION_LIMIT','本地对话数量已达到保存上限。');
      const timestamp=now();if(!date(timestamp))return fail('CHAT_TIME_INVALID','无法确认保存时间。');
      const event={schemaVersion:1,source:'ui-preview',sessionId:id,id:randomUUID(),type:'session.created',timestamp,payload:{}};
      const written=await io.write('',filename(id),Buffer.from(JSON.stringify(event)+'\n'),null);
      if(!written.ok){if(written.error.code==='CHAT_LOG_CHANGED'){const result=await read(id);return result.ok?{ok:true,session:result.session,created:false}:result;}return written;}
      const result=project(id,[event]);return {ok:true,session:result.session,created:true};
    }));
  }
  function appendEvent(id,input) {
    if(!uuid(id)||!keys(input,['id','type','payload'])||!uuid(input.id)||!types.has(input.type)||!validPayload(input.type,input.payload))
      return Promise.resolve(fail('CHAT_EVENT_INVALID','对话事件格式无效。'));
    let snapshot;
    try{snapshot=json(input);if(Buffer.byteLength(JSON.stringify(snapshot))>maxEventBytes)return Promise.resolve(fail('CHAT_EVENT_LIMIT','本次对话内容过大，尚未保存。'));}
    catch{return Promise.resolve(fail('CHAT_EVENT_INVALID','对话内容无法保存。'));}
    id=id.toLowerCase();snapshot.id=snapshot.id.toLowerCase();
    return serial(id,async()=>{
      const current=await read(id);if(!current.ok)return current;
      const prior=current.events.find(event=>event.id===snapshot.id);
      if(prior)return prior.type===snapshot.type&&canonical(prior.payload)===canonical(snapshot.payload)
        ?{ok:true,event:prior,duplicate:true}:fail('CHAT_EVENT_CONFLICT','相同事件编号对应了不同内容，未修改历史。');
      if(snapshot.type==='turn.started'&&current.pendingTurnId)return fail('CHAT_TURN_PENDING','上一轮回复尚未结束，请先停止或核对。');
      if(snapshot.type==='turn.finished'&&current.pendingTurnId!==snapshot.payload.turnId)return fail('CHAT_TURN_MISMATCH','回复与当前轮次不匹配，未修改历史。');
      const timestamp=now();if(!date(timestamp))return fail('CHAT_TIME_INVALID','无法确认保存时间。');
      const event={schemaVersion:1,source:'ui-preview',sessionId:id,...snapshot,timestamp};
      const projected=project(id,[...current.events,event]);if(!projected.ok)return fail('CHAT_EVENT_CONFLICT','对话事件顺序有冲突，未修改历史。');
      const line=Buffer.from(JSON.stringify(event)+'\n');if(current.info.size+line.length>maxFileBytes)return fail('CHAT_LOG_LIMIT','当前对话记录已达到保存上限，请新建对话。');
      const written=await io.write('',filename(id),line,current.info);return written.ok?{ok:true,event}:written;
    });
  }
  return Object.freeze({listSessions,getSession,createSession,appendEvent,ready:io.ready,close:async()=>{await Promise.allSettled([...queues.values()]);return io.close();},cleanup:io.cleanup});
}

/** Production-only partitioned transcript store. It never imports prototype logs. */
export function createPanelChatStore({stateDirectory,maxFileBytes=16*1024*1024,maxEventBytes=1024*1024,maxSessions=2000,maxListReadBytes=16*1024*1024,now=()=>new Date().toISOString()}={},internalDependencies={}){
  if(typeof stateDirectory!=='string'||!path.isAbsolute(stateDirectory)||typeof now!=='function'||![maxFileBytes,maxEventBytes,maxSessions,maxListReadBytes].every(value=>Number.isSafeInteger(value)&&value>0)||maxFileBytes>16*1024*1024||maxEventBytes>2*1024*1024||maxSessions>2000||maxListReadBytes>32*1024*1024||!keys(internalDependencies,['open','attachmentScopeBytes'])||internalDependencies.open!==undefined&&typeof internalDependencies.open!=='function'||internalDependencies.attachmentScopeBytes!==undefined&&(!Number.isSafeInteger(internalDependencies.attachmentScopeBytes)||internalDependencies.attachmentScopeBytes<1||internalDependencies.attachmentScopeBytes>ATTACHMENT_SCOPE_BYTES))throw new TypeError('Absolute production chat directory and bounded budgets required.');
  const io=createJsonlOwner(stateDirectory,{maxFileBytes,maxEventBytes,exclusive:true,openFile:internalDependencies.open??open,attachmentScopeBytes:internalDependencies.attachmentScopeBytes??ATTACHMENT_SCOPE_BYTES});
  let tail=Promise.resolve(),accepting=true;
  const serial=action=>{if(!accepting)return Promise.resolve(fail('CHAT_STORE_CLOSED','本地保存已关闭。'));const work=tail.then(action,action).catch(error=>fail(codeOf(error),'本地保存结果尚未确认，请核对后继续。'));tail=work;return work;};
  const scopeDirectory=scope=>typeof scope==='string'&&scope.length>0&&scope.length<=512&&!scope.includes('\0')?createHash('sha256').update(scope).digest('hex'):null;
  async function read(scope,id,budget=maxFileBytes){
    const subdir=scopeDirectory(scope);if(!subdir||!panelConversationId(id))return fail('CHAT_SESSION_INVALID','对话分区或编号无效。');
    const file=await io.read(subdir,id+'.jsonl',budget);if(!file.ok)return file;
    const decoded=decodeLines(file.bytes,maxEventBytes,0,20000);if(!decoded.ok)return {...decoded,bytesRead:file.bytesRead};
    const view=projectPanelConversation(id,decoded.events);return view.ok?{...view,events:decoded.events,info:file.info,bytesRead:file.bytesRead}:{...view,bytesRead:file.bytesRead};
  }
  function get(scope,id){return serial(async()=>{const value=await read(scope,id);if(!value.ok)return value;return {ok:true,session:value.session,draft:value.draft,summary:value.summary};});}
  function save(scope,sessionView,proposedDraft){
    let snapshot,draft;try{snapshot=json(sessionView);draft=proposedDraft===undefined?undefined:json(proposedDraft);}catch{return Promise.resolve(fail('CHAT_SNAPSHOT_INVALID','对话内容无法保存。'));}
    return serial(async()=>{
      const parsed=panelSnapshot(snapshot),subdir=scopeDirectory(scope);if(!parsed.ok)return parsed;if(!subdir)return fail('CHAT_SCOPE_INVALID','对话分区无效。');
      const id=parsed.id,current=await read(scope,id);if(!current.ok&&current.error.code!=='CHAT_SESSION_NOT_FOUND')return current;
      if(!current.ok){const names=await io.names(subdir);if(names.ok&&names.names.length>=maxSessions)return fail('CHAT_SESSION_LIMIT','本地对话数量已达到保存上限。');if(!names.ok&&names.error.code!=='CHAT_SESSION_NOT_FOUND')return names;}
      const prepared=panelConversationEvents(id,current.ok?current.events:[],snapshot,draft,now());if(!prepared.ok)return prepared;
      const lines=[];for(const event of prepared.events){const bytes=Buffer.from(JSON.stringify(event)+'\n');if(bytes.length>maxEventBytes)return fail('CHAT_EVENT_LIMIT','本次对话内容超过保存预算。');lines.push(bytes);}
      const total=lines.reduce((sum,bytes)=>sum+bytes.length,0);if(total+(current.ok?current.info.size:0)>maxFileBytes)return fail('CHAT_LOG_LIMIT','当前对话记录已达到保存上限，请新建对话。');
      const written=await io.write(subdir,id+'.jsonl',Buffer.concat(lines,total),current.ok?current.info:null);if(!written.ok)return written;
      return {ok:true,changed:prepared.events.length>0,session:prepared.projected.session,draft:prepared.projected.draft,summary:prepared.projected.summary};
    });
  }
  function list(scope,{cursor=null,limit=100}={}){return serial(async()=>{
    const subdir=scopeDirectory(scope);if(!subdir||cursor!==null&&!panelConversationId(cursor)||!Number.isSafeInteger(limit)||limit<1||limit>200)return fail('CHAT_SCOPE_INVALID','对话列表参数无效。');
    const names=await io.names(subdir);if(!names.ok)return names.error.code==='CHAT_SESSION_NOT_FOUND'?{ok:true,sessions:[],issues:[],complete:true,nextCursor:null}:names;
    const sessions=[],issues=[];let bytes=0,examined=0,last=cursor,complete=true;
    for(const entry of names.names){const id=entry.name.slice(0,-6);if(cursor&&id<=cursor)continue;if(examined>=limit){complete=false;break;}
      const value=entry.file?await read(scope,id,maxListReadBytes-bytes):fail('CHAT_LOG_INVALID','记录文件类型无效。');
      if(!value.ok&&value.error.code==='CHAT_LOG_LIMIT'&&examined>0){complete=false;break;}
      examined++;last=id;bytes+=value.bytesRead??0;if(value.ok)sessions.push(value.summary);else issues.push({id,code:value.error.code});
      if(bytes>=maxListReadBytes){complete=false;break;}
    }
    sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    return {ok:true,sessions,issues,complete,nextCursor:complete?null:last,bytesRead:bytes};
  });}
  const close=()=>{accepting=false;return tail.then(()=>io.close());};
  function saveTurnAttachments(scope,files){
    const subdir=scopeDirectory(scope);if(!subdir)return Promise.resolve(fail('CHAT_SCOPE_INVALID','对话分区无效。'));
    let snapshots;try{snapshots=attachmentSnapshots(files);}catch(error){return Promise.resolve(fail(codeOf(error),error.chatCode?error.message:'附件格式无效。'));}
    return serial(()=>io.writeAttachments(subdir,snapshots));
  }
  function readTurnAttachment(scope,id){return serial(async()=>{
    const subdir=scopeDirectory(scope);if(!subdir||!panelConversationId(id))return fail('CHAT_ATTACHMENT_INVALID','附件分区或编号无效。');
    const value=await io.readAttachment(subdir,id);if(!value.ok)return value;
    return {ok:true,bytes:value.bytes,sha256:createHash('sha256').update(value.bytes).digest('hex'),size:value.bytes.length};
  });}
  return Object.freeze({ready:()=>serial(()=>io.ready()),list,get,save,saveTurnAttachments,readTurnAttachment,close,cleanup:io.cleanup});
}
