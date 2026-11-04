import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';
import {recoverAbandonedLibraryLock,validLibraryLock} from './project-files-lock-recovery.mjs';

const ok=value=>({ok:true,value});
const fail=(code,message='资料库地址存储未能核实，原记录已保留。')=>({ok:false,error:{code,message}});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const fileId=s=>{
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||typeof s.ino!=='bigint'||s.ino===0n||typeof s.birthtimeNs!=='bigint')throw new Error('identity');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
};
const fingerprint=s=>`${fileId(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const normalize=value=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);
const validPath=value=>typeof value==='string'&&value.length>0&&value.length<=32767&&!value.includes('\0')&&path.isAbsolute(value)&&path.normalize(value)===value;
const validEntry=value=>plain(value)&&Object.keys(value).length===2&&validPath(value.path)&&['file','directory'].includes(value.kind);
const key=value=>`${value.kind}\0${normalize(value.path)}`;

/** Account-bound append-only address journal. The application supplies the
 * existing panel state root and a verified stable account identity. This owner
 * does not establish Windows ACL privacy or protection from the same user.
 * Unknown writes are preserved, not overwritten or retried. Stale Windows
 * locks are archived only after a native exclusive identity-checked rename. */
export function createProjectFilesStore({stateDirectory,accountId,maxRecords=4096,maxRoots=64}={}){
  if(typeof stateDirectory!=='string'||!path.isAbsolute(stateDirectory)||typeof accountId!=='string'||!accountId||accountId.length>512||
     !Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>4096||!Number.isSafeInteger(maxRoots)||maxRoots<1||maxRoots>64)
    throw new TypeError('A state root and stable account are required');
  const root=path.resolve(stateDirectory),directory=path.join(root,'library-'+hash(accountId)),lockPath=path.join(directory,'.library.lock');
  let chain=null,lock=null,retained=null,closed=false,closing=false,faulted=false,tail=Promise.resolve();
  let entries=new Map(),sequence=0,lastHash='0'.repeat(64);
  const serial=fn=>{const work=tail.then(fn,fn);tail=work.catch(()=>{});return work;};
  const matches=(a,b)=>a.length===b.length&&a.every((item,i)=>normalize(item.path)===normalize(b[i].path)&&item.identity===b[i].identity);
  async function verify(){
    const found=inspectExistingPanelDirectory(directory);
    if(!found.ok||!chain||!matches(chain,found.value.chain))throw new Error('directory');
    const byPath=await fs.lstat(lockPath,{bigint:true}),byHandle=await lock.handle.stat({bigint:true});
    if(fileId(byPath)!==lock.id||fileId(byHandle)!==lock.id)throw new Error('lock');
  }
  async function readFile(file){
    const named=await fs.lstat(file,{bigint:true});if(named.size>262144n)throw new Error('capacity');
    const handle=await fs.open(file,'r');let bytes;
    try{
      const before=await handle.stat({bigint:true});if(fingerprint(before)!==fingerprint(named))throw new Error('changed');
      bytes=await handle.readFile();const after=await handle.stat({bigint:true}),again=await fs.lstat(file,{bigint:true});
      if(fingerprint(before)!==fingerprint(after)||fingerprint(before)!==fingerprint(again))throw new Error('changed');
    }finally{await handle.close();}
    return bytes;
  }
  async function scan(){
    await verify();const names=await fs.readdir(directory);
    const archivePattern=/^\.library\.lock\.recovered\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    if(names.some(name=>name!=='.library.lock'&&!/^entry-\d{8}\.json$/.test(name)&&!archivePattern.test(name)))throw new Error('unexpected');
    const archives=names.filter(name=>archivePattern.test(name));if(archives.length>128)throw new Error('capacity');
    for(const name of archives){const bytes=await readFile(path.join(directory,name));if(bytes.length>1024||!validLibraryLock(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))))throw new Error('invalid');}
    const records=names.filter(name=>/^entry-\d{8}\.json$/.test(name)).sort();if(records.length>maxRecords)throw new Error('capacity');
    let prior='0'.repeat(64),number=0;const current=new Map();
    for(const name of records){
      number++;if(name!==`entry-${String(number).padStart(8,'0')}.json`)throw new Error('sequence');
      const bytes=await readFile(path.join(directory,name));let event;
      try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('invalid');}
      if(!plain(event)||Object.keys(event).sort().join(',')!=='action,entry,previous,schema,sequence'||event.schema!==1||event.sequence!==number||event.previous!==prior||!['add','remove'].includes(event.action)||!validEntry(event.entry))throw new Error('invalid');
      const id=key(event.entry);if(event.action==='add'){if(current.has(id)||current.size>=maxRoots)throw new Error('invalid');current.set(id,event.entry);}else if(!current.delete(id))throw new Error('invalid');
      prior=hash(bytes);
    }
    await verify();return {entries:current,sequence:number,lastHash:prior};
  }
  async function ready(){return serial(async()=>{
    if(closed||closing||faulted)return fail('LIBRARY_STORE_UNAVAILABLE');
    if(lock)return ok({ready:true});
    try{
      const observed=inspectExistingPanelDirectory(root);if(!observed.ok)throw new Error('directory');
      try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      const account=inspectExistingPanelDirectory(directory);if(!account.ok||!matches(observed.value.chain,account.value.chain.slice(0,observed.value.chain.length)))throw new Error('directory');
      chain=account.value.chain;
      let handle;
      try{handle=await fs.open(lockPath,'wx',0o600);}
      catch(error){
        if(error.code!=='EEXIST'||!await recoverAbandonedLibraryLock(lockPath,chain))throw error;
        handle=await fs.open(lockPath,'wx',0o600);
      }
      lock={handle,id:null};
      lock.id=fileId(await handle.stat({bigint:true}));if(fileId(await fs.lstat(lockPath,{bigint:true}))!==lock.id)throw new Error('lock');
      await handle.writeFile(JSON.stringify({schema:1,owner:randomUUID()}));await handle.sync();
      const loaded=await scan();entries=loaded.entries;sequence=loaded.sequence;lastHash=loaded.lastHash;return ok({ready:true});
    }catch(error){faulted=true;return fail(error?.code==='EEXIST'?'LIBRARY_STORE_LOCKED':'LIBRARY_STORE_UNAVAILABLE');}
  });}
  async function list(){return serial(async()=>{
    if(!lock||faulted||closing||closed)return fail('LIBRARY_STORE_UNAVAILABLE');
    try{const result=await scan();if(result.sequence!==sequence||result.lastHash!==lastHash)throw new Error('changed');return ok({entries:[...entries.values()].map(value=>({...value}))});}
    catch{faulted=true;return fail('LIBRARY_STORE_INVALID');}
  });}
  async function change(action,entry){return serial(async()=>{
    if(!lock||faulted||closing||closed)return fail('LIBRARY_STORE_UNAVAILABLE');
    if(!validEntry(entry))return fail('LIBRARY_ADDRESS_INVALID','资料地址无效。');
    try{
      const current=await scan();if(current.sequence!==sequence||current.lastHash!==lastHash)throw new Error('changed');
      const id=key(entry);if(action==='add'&&entries.has(id))return ok({changed:false});
      if(action==='remove'&&!entries.has(id))return fail('LIBRARY_ADDRESS_MISSING','资料地址不存在。');
      if(action==='add'){
        if(entries.size>=maxRoots)return fail('LIBRARY_ADDRESS_CAPACITY');
        try{const s=await fs.lstat(entry.path,{bigint:true});if(s.isSymbolicLink()||!(entry.kind==='file'?s.isFile()&&s.nlink===1n:s.isDirectory())||normalize(await fs.realpath(entry.path))!==normalize(entry.path))throw new Error('unavailable');}
        catch{return fail('LIBRARY_ADDRESS_UNAVAILABLE','所选地址不可访问或已变化。');}
      }
      if(sequence>=maxRecords)return fail('LIBRARY_STORE_CAPACITY');
      await verify();const event={schema:1,sequence:sequence+1,action,entry:{path:entry.path,kind:entry.kind},previous:lastHash};
      const bytes=Buffer.from(JSON.stringify(event)),file=path.join(directory,`entry-${String(sequence+1).padStart(8,'0')}.json`);
      const handle=await fs.open(file,'wx',0o600);retained={handle};
      const idBefore=fileId(await handle.stat({bigint:true}));if(fileId(await fs.lstat(file,{bigint:true}))!==idBefore)throw new Error('changed');
      await handle.writeFile(bytes);await handle.sync();
      if(fileId(await handle.stat({bigint:true}))!==idBefore||fileId(await fs.lstat(file,{bigint:true}))!==idBefore)throw new Error('changed');
      await handle.close();retained=null;
      const next=await scan();if(next.sequence!==sequence+1||next.lastHash!==hash(bytes))throw new Error('write');
      entries=next.entries;sequence=next.sequence;lastHash=next.lastHash;return ok({changed:true});
    }catch{faulted=true;return fail('LIBRARY_STORE_WRITE_UNKNOWN','地址保存结果尚未确认，原记录已保留。');}
  });}
  async function close(){closing=true;return serial(async()=>{
    if(closed)return {closed:true};
    if(retained){try{await retained.handle.close();retained=null;}catch{return {closed:false};}}
    if(!lock){closed=true;return {closed:true};}
    if(faulted){
      // Keep the lock *file* as an explicit unresolved marker, while releasing
      // our handle when possible. No future owner can silently adopt it.
      if(lock.handle){try{await lock.handle.close();lock.handle=null;}catch{return {closed:false};}}
      return {closed:false};
    }
    try{await scan();await verify();const current=await fs.lstat(lockPath,{bigint:true});if(fileId(current)!==lock.id)throw new Error('lock');await lock.handle.close();lock.handle=null;await fs.unlink(lockPath);lock=null;closed=true;return {closed:true};}
    catch{faulted=true;return {closed:false};}
  });}
  return Object.freeze({ready,list,add:entry=>change('add',entry),remove:entry=>change('remove',entry),close});
}
