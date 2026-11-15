import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createProjectFilesPicker} from '../../lib/project-files-picker.mjs';

function fixture({autoKill=false,timeoutMs=1000,cleanupTimeoutMs=20}={}){
  let processCount=0,child,lastCall;
  const spawn=(file,args,options)=>{
    processCount++;lastCall={file,args,options};child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killCount=0;
    child.kill=()=>{child.killCount++;if(autoKill)queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;};
    return child;
  };
  const picker=createProjectFilesPicker({spawn,platform:'win32',systemRoot:'C:\\Windows',timeoutMs,cleanupTimeoutMs});
  return {picker,get child(){return child;},get count(){return processCount;},get call(){return lastCall;}};
}
const send=(child,value,code=0)=>{child.stdout.write(Buffer.from(JSON.stringify(value)));child.emit('exit',code,null);child.emit('close',code,null);};

test('fixed file and folder dialogs produce only selected absolute paths; cancellation remains distinct',async()=>{
  const f=fixture();const file=f.picker.pick({kind:'file'});
  assert.match(f.call.file,/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(f.call.options.shell,false);assert.equal(f.call.options.windowsHide,true);assert.ok(f.call.args.includes('-STA'));
  const script=Buffer.from(f.call.args.at(-1),'base64').toString('utf16le');assert.match(script,/OpenFileDialog/);assert.doesNotMatch(script,/C:\\private/);
  send(f.child,{path:'C:\\private\\文件.txt'});assert.deepEqual(await file,{ok:true,value:{path:'C:\\private\\文件.txt'}});
  const folder=f.picker.pick({kind:'directory'});assert.match(Buffer.from(f.call.args.at(-1),'base64').toString('utf16le'),/FolderBrowserDialog/);
  send(f.child,{path:null});assert.deepEqual(await folder,{ok:true,value:{path:null}});assert.deepEqual(await f.picker.close(),{closed:true});
});

test('concurrent dialog is refused; abort waits for the owned process close',async()=>{
  const f=fixture({autoKill:true});const controller=new AbortController(),first=f.picker.pick({kind:'file',signal:controller.signal});
  assert.equal((await f.picker.pick({kind:'directory'})).error.code,'PICKER_BUSY');assert.equal(f.count,1);
  controller.abort();assert.equal((await first).error.code,'PICKER_CANCELLED');assert.equal(f.child.killCount,1);
  const next=f.picker.pick({kind:'directory'});send(f.child,{path:'D:\\materials'});assert.equal((await next).value.path,'D:\\materials');
});

test('timed-out child that does not close remains owned and blocks new dialogs until late close',async()=>{
  const f=fixture({timeoutMs:5,cleanupTimeoutMs:8});const pending=f.picker.pick({kind:'file'});
  assert.equal((await pending).error.code,'PICKER_CLEANUP_PENDING');const original=f.child;
  assert.equal((await f.picker.pick({kind:'file'})).error.code,'PICKER_BUSY');assert.equal(f.count,1);
  original.emit('close',null,'SIGTERM');const next=f.picker.pick({kind:'file'});send(f.child,{path:'D:\\next.txt'});assert.equal((await next).ok,true);
});

test('close preserves ownership when termination is unconfirmed and retries only original child',async()=>{
  const f=fixture({cleanupTimeoutMs:8});const pending=f.picker.pick({kind:'file'}),original=f.child;
  assert.deepEqual(await f.picker.close(),{closed:false});assert.equal((await pending).error.code,'PICKER_CLEANUP_PENDING');
  assert.deepEqual(await f.picker.close(),{closed:false});assert.equal(f.count,1);original.emit('close',null,'SIGTERM');assert.deepEqual(await f.picker.close(),{closed:true});
});

test('invalid outputs, oversized outputs, spawn errors and unsupported environments fail without leaking stderr',async()=>{
  const f=fixture({autoKill:true});let operation=f.picker.pick({kind:'file'});f.child.stderr.write('private secret');send(f.child,{path:'relative.txt'});assert.equal((await operation).error.code,'PICKER_OUTPUT_INVALID');
  operation=f.picker.pick({kind:'file'});f.child.stdout.write(Buffer.alloc(131073));assert.equal((await operation).error.code,'PICKER_OUTPUT_INVALID');
  const unsupported=createProjectFilesPicker({spawn:()=>{throw new Error('must not run');},platform:'linux',systemRoot:'C:\\Windows'});
  assert.equal((await unsupported.pick({kind:'file'})).error.code,'PICKER_UNAVAILABLE');
  const bad=createProjectFilesPicker({spawn:()=>{throw new Error('secret');},platform:'win32',systemRoot:'C:\\Windows'});
  assert.equal((await bad.pick({kind:'file'})).error.code,'PICKER_START_FAILED');assert.equal((await bad.pick({kind:'bad'})).error.code,'PICKER_INPUT_INVALID');
  const asynchronous=fixture({autoKill:true});const failed=asynchronous.picker.pick({kind:'file'});asynchronous.child.emit('error',new Error('private'));assert.equal((await failed).error.code,'PICKER_FAILED');
});
