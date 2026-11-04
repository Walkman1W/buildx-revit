import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {inspectExistingPanelDirectory} from './lib/panel-audit.mjs';
import {recoverAbandonedChatLock,runRecoveryProcess} from './lib/chat-lock-recovery.mjs';
import {createPanelChatStore} from './lib/chat-store.mjs';

const windows=process.platform==='win32';
const record=()=>JSON.stringify({schemaVersion:2,source:'local-codex-panel',owner:randomUUID(),pid:123,createdUtc:new Date().toISOString()})+'\n';
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-lock-recovery-'));
  const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));
  t.after(async()=>{const actual=await fs.realpath(dir);assert.equal(actual.toLowerCase(),resolved.toLowerCase());await fs.rm(resolved,{recursive:true,force:true});});
  return {dir,file:path.join(dir,'.panel-chat.lock'),chain:inspectExistingPanelDirectory(dir).value.chain};
}
function owner(file,data){
  const code=`import fs from 'node:fs/promises';let f=await fs.open(process.argv[1],'wx');await f.writeFile(process.argv[2]);process.stdout.write('ready\\n');process.stdin.resume();`;
  return spawn(process.execPath,['--input-type=module','-e',code,file,data],{stdio:['pipe','pipe','pipe'],windowsHide:true});
}
async function ready(child){await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error(`child exited ${code}`)));});}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await new Promise(resolve=>child.once('close',resolve));}

test('an active legacy Node owner is never recovered; after crash its exact lock is retained', {skip:!windows},async t=>{
  const f=await fixture(t),data=record(),child=owner(f.file,data);t.after(()=>stop(child));await ready(child);
  assert.equal(await recoverAbandonedChatLock(f.file,f.chain),false);
  assert.equal(await fs.readFile(f.file,'utf8'),data);assert.deepEqual(await fs.readdir(f.dir),['.panel-chat.lock']);
  await stop(child);
  assert.equal(await recoverAbandonedChatLock(f.file,f.chain),true);
  const files=await fs.readdir(f.dir);assert.equal(files.length,1);assert.match(files[0],/^\.panel-chat\.lock\.recovered\.[a-f0-9-]{36}$/);
  assert.equal(await fs.readFile(path.join(f.dir,files[0]),'utf8'),data);
});

test('concurrent recovery preserves exactly one original and never overwrites the archive', {skip:!windows},async t=>{
  const f=await fixture(t),data=record();await fs.writeFile(f.file,data,{flag:'wx'});
  const outcomes=await Promise.all([recoverAbandonedChatLock(f.file,f.chain),recoverAbandonedChatLock(f.file,f.chain)]);
  assert.equal(outcomes.filter(Boolean).length,1);
  const files=await fs.readdir(f.dir);assert.equal(files.length,1);assert.equal(await fs.readFile(path.join(f.dir,files[0]),'utf8'),data);
});

test('unknown records and replaced directory identities fail closed without mutation', {skip:!windows},async t=>{
  const f=await fixture(t);
  for(const bytes of ['', '{"schemaVersion":2', '{"unexpected":true}\n']){
    await fs.writeFile(f.file,bytes);assert.equal(await recoverAbandonedChatLock(f.file,f.chain),false);assert.equal(await fs.readFile(f.file,'utf8'),bytes);
  }
  const data=record();await fs.writeFile(f.file,data);
  const mismatched=f.chain.map((entry,index)=>index===f.chain.length-1?{...entry,identity:'0:0:0'}:entry);
  assert.equal(await recoverAbandonedChatLock(f.file,mismatched),false);assert.equal(await fs.readFile(f.file,'utf8'),data);
  assert.deepEqual(await fs.readdir(f.dir),['.panel-chat.lock']);
});

test('a replaced history directory is not adopted or changed', {skip:!windows},async t=>{
  const f=await fixture(t),dir=path.join(f.dir,'history'),old=path.join(f.dir,'original');await fs.mkdir(dir);
  const originalChain=inspectExistingPanelDirectory(dir).value.chain,filename='.panel-chat.lock',data=record();
  await fs.writeFile(path.join(dir,filename),data);await fs.rename(dir,old);await fs.mkdir(dir);await fs.writeFile(path.join(dir,filename),data);
  assert.equal(await recoverAbandonedChatLock(path.join(dir,filename),originalChain),false);
  assert.equal(await fs.readFile(path.join(dir,filename),'utf8'),data);assert.equal(await fs.readFile(path.join(old,filename),'utf8'),data);
  assert.deepEqual(await fs.readdir(dir),[filename]);
});

test('hard links fail closed without modifying the linked lock', {skip:!windows},async t=>{
  const f=await fixture(t),data=record(),alias=path.join(f.dir,'alias');await fs.writeFile(f.file,data);await fs.link(f.file,alias);
  assert.equal(await recoverAbandonedChatLock(f.file,f.chain),false);
  assert.equal(await fs.readFile(f.file,'utf8'),data);assert.equal(await fs.readFile(alias,'utf8'),data);
});

test('unavailable Windows helper leaves the original lock in place', {skip:!windows},async t=>{
  const f=await fixture(t),data=record(),originalRoot=process.env.SystemRoot;await fs.writeFile(f.file,data);
  try{process.env.SystemRoot=path.join(f.dir,'missing-system-root');assert.equal(await recoverAbandonedChatLock(f.file,f.chain),false);}
  finally{process.env.SystemRoot=originalRoot;}
  assert.equal(await fs.readFile(f.file,'utf8'),data);assert.deepEqual(await fs.readdir(f.dir),['.panel-chat.lock']);
});

test('production store recovers a crashed owner and never modifies existing history', {skip:!windows},async t=>{
  const f=await fixture(t),data=record(),child=owner(f.file,data);t.after(()=>stop(child));await ready(child);
  const sentinel=path.join(f.dir,'existing-history.jsonl'),original='{"preserve":"original history"}\n';await fs.writeFile(sentinel,original);
  const live=createPanelChatStore({stateDirectory:f.dir});t.after(()=>live.close());
  assert.equal((await live.ready()).error.code,'CHAT_STORE_LOCKED');
  await stop(child);
  const recovered=createPanelChatStore({stateDirectory:f.dir});t.after(()=>recovered.close());
  assert.equal((await recovered.ready()).ok,true);
  const names=await fs.readdir(f.dir),archive=names.find(name=>name.startsWith('.panel-chat.lock.recovered.'));
  assert.ok(archive);assert.equal(await fs.readFile(path.join(f.dir,archive),'utf8'),data);
  assert.equal(await fs.readFile(sentinel,'utf8'),original);
  assert.equal((await recovered.close()).ok,true);
});

test('competing production owners after a crash admit at most one writer', {skip:!windows},async t=>{
  const f=await fixture(t),data=record();await fs.writeFile(f.file,data,{flag:'wx'});
  const first=createPanelChatStore({stateDirectory:f.dir}),second=createPanelChatStore({stateDirectory:f.dir});
  t.after(()=>first.close());t.after(()=>second.close());
  const results=await Promise.all([first.ready(),second.ready()]);
  assert.equal(results.filter(result=>result.ok).length,1);
  assert.equal(results.filter(result=>!result.ok&&result.error.code==='CHAT_STORE_LOCKED').length,1);
  const files=await fs.readdir(f.dir),archives=files.filter(name=>name.startsWith('.panel-chat.lock.recovered.'));
  assert.equal(archives.length,1);assert.equal(await fs.readFile(path.join(f.dir,archives[0]),'utf8'),data);
});

test('independent Node processes racing after a crash admit only one live owner', {skip:!windows},async t=>{
  const f=await fixture(t),data=record();await fs.writeFile(f.file,data,{flag:'wx'});
  const moduleUrl=new URL('./lib/chat-store.mjs',import.meta.url).href;
  const code=`import {createPanelChatStore} from ${JSON.stringify(moduleUrl)};const store=createPanelChatStore({stateDirectory:process.argv[1]});const result=await store.ready();process.stdout.write((result.ok?'READY':result.error.code)+'\\n');if(result.ok)process.stdin.resume();`;
  const child=()=>spawn(process.execPath,['--input-type=module','-e',code,f.dir],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const a=child(),b=child();t.after(()=>stop(a));t.after(()=>stop(b));
  const line=proc=>new Promise((resolve,reject)=>{let text='';proc.once('error',reject);proc.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(text.trim());});proc.once('exit',()=>{if(!text.includes('\n'))reject(new Error('fixture owner exited without status'));});});
  const results=await Promise.all([line(a),line(b)]);
  assert.deepEqual([...results].sort(),['CHAT_STORE_LOCKED','READY']);
  const winner=results[0]==='READY'?a:b;assert.equal(winner.exitCode,null);assert.ok(await fs.stat(f.file));
  const archives=(await fs.readdir(f.dir)).filter(name=>name.startsWith('.panel-chat.lock.recovered.'));
  assert.equal(archives.length,1);assert.equal(await fs.readFile(path.join(f.dir,archives[0]),'utf8'),data);
  await stop(a);await stop(b);
});

for(const stage of ['before','after'])test(`helper termination ${stage} atomic rename preserves the original bytes`, {skip:!windows},async t=>{
  const f=await fixture(t),data=record(),archive=path.join(f.dir,`.panel-chat.lock.recovered.${randomUUID()}`),marker=archive+'.stage';await fs.writeFile(f.file,data,{flag:'wx'});
  const source=await fs.readFile(new URL('./lib/chat-lock-recovery.ps1',import.meta.url),'utf8');
  const needle='return SetFileInformationByHandle(handle, 3, buffer, (uint)(offset + target.Length + 2));';
  assert.ok(source.includes(needle));
  const pause='File.WriteAllText(archive + ".stage", "ready"); System.Threading.Thread.Sleep(60000);';
  const replacement=stage==='before'?`${pause} ${needle}`:`bool renamed = SetFileInformationByHandle(handle, 3, buffer, (uint)(offset + target.Length + 2)); ${pause} return renamed;`;
  const script=path.join(f.dir,`fixture-${stage}.ps1`);await fs.writeFile(script,source.replace(needle,replacement));
  const info=await fs.lstat(f.file,{bigint:true}),id=`${info.dev}:${info.ino}:${info.birthtimeNs}`;
  const request={file:f.file,archive,chain:f.chain,fileIdentity:id,sha256:createHash('sha256').update(data).digest('hex')};
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',script],{stdio:'ignore',windowsHide:true,env:{...process.env,BUILDX_CHAT_LOCK_RECOVERY_REQUEST:JSON.stringify(request)}});
  t.after(()=>stop(child));
  let observed=false;for(let n=0;n<120;n++){try{await fs.access(marker);observed=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert.equal(observed,true,'isolated helper did not reach the requested stage');await stop(child);
  assert.equal(await fs.readFile(stage==='before'?f.file:archive,'utf8'),data);
  if(stage==='before')await assert.rejects(fs.access(archive));else await assert.rejects(fs.access(f.file));
});

test('timed-out helper with a descendant terminates without waiting on inherited pipes', {skip:!windows},async t=>{
  const f=await fixture(t),marker=path.join(f.dir,'descendant-exited'),started=path.join(f.dir,'descendant-started');
  const descendant=`require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'done'),4000)`;
  const main=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit',windowsHide:true});setTimeout(()=>{},60000);`;
  const before=Date.now();assert.equal(await runRecoveryProcess(process.execPath,['-e',main],{}, {timeoutMs:1800}),false);
  assert.ok(Date.now()-before<3000,'timeout must not wait for a descendant to close pipes');
  const pid=Number(await fs.readFile(started,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  await new Promise(resolve=>setTimeout(resolve,4500));
  // On Windows the parent may own a kill-on-close job that terminates its
  // descendant, otherwise the fixture terminates itself after four seconds.
  let finished=true;try{await fs.access(marker);}catch{try{process.kill(pid,0);finished=false;}catch(error){if(error.code!=='ESRCH')throw error;}}
  assert.equal(finished,true,'owned fixture descendant did not terminate');
});
