import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runPanelService} from './lib/server-lifecycle.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelChatStore} from './lib/chat-store.mjs';
import {createPanelServer} from './lib/panel-server.mjs';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(app){
  const processObject=new EventEmitter();processObject.pid=123;
  const audits=[],logs=[],errors=[],writes=[];
  const lifecycle={audit:(_file,data)=>audits.push(data),flush:async()=>audits.push({code:'flush'})};
  const filesystem={mkdir:async()=>writes.push('mkdir'),writeFile:async()=>writes.push('write')};
  const output={log:value=>logs.push(JSON.parse(value)),error:value=>errors.push(JSON.parse(value))};
  const run=runPanelService({app,lifecycle,root:'fixture-root',processObject,filesystem,output});
  return {run,processObject,audits,logs,errors,writes};
}

test('normal startup reports ready and graceful signal closes the original owner',async()=>{
  let closes=0,connects=0;
  const f=fixture({listen:async()=>({port:1234}),connect:()=>{connects++;},close:async()=>{closes++;return {closed:true};}});
  await f.run;assert.deepEqual(f.writes,['mkdir','write']);assert.equal(connects,1);
  f.processObject.emit('SIGTERM');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closes,1);assert.equal(f.logs.at(-1).code,'service_closed');assert.equal(f.errors.length,0);
});

test('signal during history readiness closes once and late startup cannot publish or connect',async()=>{
  const waiting=deferred(),closing=deferred();let closes=0,connects=0;
  const f=fixture({listen:()=>waiting.promise,connect:()=>{connects++;},close:()=>{closes++;return closing.promise;}});
  assert.equal(f.processObject.listenerCount('SIGTERM'),1);
  f.processObject.emit('SIGTERM');f.processObject.emit('SIGINT');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closes,1);
  waiting.resolve({port:1234});closing.resolve({closed:true});await f.run;
  assert.equal(connects,0);assert.deepEqual(f.writes,[]);assert.equal(f.logs.at(-1).code,'service_closed');
  assert.equal(f.audits.filter(row=>row.code==='service_stopping').length,1);
});

test('cleanup failure remains visible and a later explicit signal can retry the same owner',async()=>{
  const waiting=deferred();let closes=0;
  const app={listen:()=>waiting.promise,connect:()=>assert.fail('must not connect'),close:async()=>++closes===1?{closed:false}:{closed:true}};
  const f=fixture(app);f.processObject.emit('SIGTERM');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.processObject.exitCode,1);assert.equal(f.errors.at(-1).error_code,'service_cleanup_pending');
  f.processObject.emit('SIGTERM');await new Promise(resolve=>setImmediate(resolve));assert.equal(closes,2);
  waiting.reject(Object.assign(new Error('controlled startup failure'),{code:'CHAT_STORE_LOCKED'}));await f.run;
  assert.equal(f.audits.find(row=>row.code==='service_start_failed').error_code,'CHAT_STORE_LOCKED');
  assert.equal(f.errors.at(-1).error_code,'CHAT_STORE_LOCKED');
  assert.equal(f.logs.at(-1).code,'service_closed');assert.equal(f.processObject.exitCode,1);
});

test('an audit error during a signal never prevents cleanup of the same owner',async()=>{
  const gate=deferred(),processObject=new EventEmitter(),errors=[];processObject.pid=123;let closes=0;
  const run=runPanelService({root:'fixture-root',processObject,app:{listen:()=>gate.promise,connect:()=>assert.fail('must not connect'),close:async()=>{closes++;return {closed:true};}},
    lifecycle:{audit:(_file,data)=>{if(data.code==='service_stopping')throw new Error('fixture');},flush:async()=>{}},
    filesystem:{mkdir:async()=>assert.fail('must not write'),writeFile:async()=>assert.fail('must not write')},output:{log:()=>{},error:value=>errors.push(JSON.parse(value))}});
  processObject.emit('SIGTERM');gate.resolve({port:1234});await run;
  assert.equal(closes,1);assert.equal(processObject.exitCode,1);assert.equal(errors.at(-1).error_code,'service_audit_failed');
});

test('ordinary startup failure closes and flushes, and does not conceal cleanup failure',async()=>{
  let closes=0;
  const f=fixture({listen:async()=>{throw Object.assign(new Error('fixture'),{code:'CHAT_STORE_LOCKED'});},connect:()=>assert.fail('must not connect'),close:async()=>{closes++;throw new Error('fixture');}});
  await f.run;assert.equal(closes,1);assert.equal(f.processObject.exitCode,1);
  assert.deepEqual(f.errors.map(row=>row.error_code),['CHAT_STORE_LOCKED','service_cleanup_pending']);
  assert.deepEqual(f.audits.map(row=>row.code),['service_start_failed','flush']);
});

test('production panel shutdown during actual history lock creation removes only its own lock',async t=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-startup-signal-'));
  const stateDirectory=path.join(temporary,'history'),lock=path.join(stateDirectory,'.panel-chat.lock');
  const lockCreated=deferred(),release=deferred();
  const history=createPanelChatStore({stateDirectory},{open:async(file,flags)=>{
    const handle=await fs.open(file,flags);
    if(file===lock&&flags==='wx'){lockCreated.resolve();await release.promise;}
    return handle;
  }});
  class Codex extends EventEmitter{state={ready:false,mode:'document-workbench'};starts=0;async start(){this.starts++;}async close(){return {closed:true};}}
  const codex=new Codex(),root=fileURLToPath(new URL('.',import.meta.url));
  const app=createPanelServer({root,codex,historyStore:history,port:0,profile:'model',invokeWorkbench:async()=>{throw new Error('unexpected');}});
  const f=fixture(app);
  try{
    await lockCreated.promise;assert.equal((await fs.stat(lock)).isFile(),true);
    f.processObject.emit('SIGTERM');release.resolve();await f.run;
    await assert.rejects(fs.stat(lock),{code:'ENOENT'});
    assert.equal(app.server.listening,false);assert.equal(codex.starts,0);assert.deepEqual(f.writes,[]);
    assert.equal(f.errors.length,0);assert.equal(f.logs.at(-1).code,'service_closed');
  }finally{
    release.resolve();await app.close();
    const checked=path.resolve(temporary);assert.ok(checked.startsWith(path.resolve(os.tmpdir())+path.sep));
    assert.equal((await fs.lstat(checked)).isSymbolicLink(),false);await fs.rm(checked,{recursive:true,force:true});
  }
});
