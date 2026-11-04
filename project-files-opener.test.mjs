import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createProjectFilesOpener} from './lib/project-files-opener.mjs';

function fixture({autoClose=true,timeoutMs=1000,cleanupTimeoutMs=10}={}){
  let child,call,count=0;
  const spawn=(file,args,options)=>{
    count++;child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kills=0;
    child.kill=()=>{child.kills++;if(autoClose)queueMicrotask(()=>child.emit('close',null,'SIGTERM'));};
    call={file,args,options};return child;
  };
  const opener=createProjectFilesOpener({spawn,platform:'win32',systemRoot:'C:\\Windows',timeoutMs,cleanupTimeoutMs});
  return {opener,get child(){return child;},get call(){return call;},get count(){return count;}};
}

test('Windows helper receives the selected path as stdin data and uses the default association',async()=>{
  const f=fixture(),target='D:\\资料\\报告 & $(example) "样例".pdf',running=f.opener.open({path:target,kind:'file'});
  assert.equal(f.call.options.shell,false);assert.equal(f.call.options.windowsHide,true);assert.ok(f.call.file.endsWith('powershell.exe'));
  const source=Buffer.from(f.call.args.at(-1),'base64').toString('utf16le');assert.match(source,/UseShellExecute = \$true/);assert.doesNotMatch(source,/报告/);assert.equal(f.call.args.some(value=>value.includes('报告')),false);
  const chunks=[];for await(const chunk of f.child.stdin)chunks.push(chunk);assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{path:target});
  f.child.emit('exit',0,null);f.child.emit('close',0,null);assert.deepEqual(await running,{ok:true,value:{accepted:true}});assert.deepEqual(await f.opener.close(),{closed:true});
});

test('an unclosed helper remains owned and blocks another request until cleanup is confirmed',async()=>{
  const f=fixture({autoClose:false,timeoutMs:5,cleanupTimeoutMs:5}),pending=f.opener.open({path:'D:\\资料',kind:'directory'}),original=f.child;
  const uncertain=await pending;assert.equal(uncertain.error.code,'OPEN_CLEANUP_PENDING');assert.match(uncertain.error.message,/可能已发送/);assert.equal(original.kills,1);
  assert.equal((await f.opener.open({path:'D:\\另一个',kind:'directory'})).error.code,'OPEN_BUSY');assert.equal(f.count,1);
  assert.deepEqual(await f.opener.close(),{closed:false});original.emit('close',null,'SIGTERM');assert.deepEqual(await f.opener.close(),{closed:true});
});

test('bad input, unsupported platforms and failed helpers report errors without exposing paths',async()=>{
  const f=fixture();assert.equal((await f.opener.open({path:'relative',kind:'file'})).error.code,'OPEN_INPUT_INVALID');assert.equal(f.count,0);
  const unsupported=createProjectFilesOpener({platform:'linux',systemRoot:'C:\\Windows'});assert.equal((await unsupported.open({path:'C:\\report.pdf',kind:'file'})).error.code,'OPEN_UNAVAILABLE');
  const pending=f.opener.open({path:'C:\\private\\report.pdf',kind:'file'});f.child.stderr.write('secret');f.child.emit('close',1,null);const result=await pending;
  assert.equal(result.error.code,'OPEN_FAILED');assert.match(result.error.message,/未确认/);assert.doesNotMatch(JSON.stringify(result),/private|secret/);
});
