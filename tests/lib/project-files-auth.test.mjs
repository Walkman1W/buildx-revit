import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createProjectFilesAuth} from '../../lib/project-files-auth.mjs';

test('real DPAPI authenticates exact bytes and rejects changed bytes, scope and proof', {skip:process.platform!=='win32'}, async()=>{
  const owner=createProjectFilesAuth(),payload=Buffer.from('{"action":"add","path":"D:\\fixture\\one.txt"}');
  const sealed=await owner.seal({scope:'research:local',payload});assert.equal(sealed.ok,true);
  const verified=await owner.verify({scope:'research:local',payload,proof:sealed.value.proof});assert.deepEqual(verified,{ok:true,value:{valid:true}});
  const changed=await owner.verify({scope:'research:local',payload:Buffer.from('changed'),proof:sealed.value.proof});assert.deepEqual(changed,{ok:true,value:{valid:false}});
  const other=await owner.verify({scope:'other:account',payload,proof:sealed.value.proof});assert.equal(other.ok,false);
  const bytes=Buffer.from(sealed.value.proof,'base64');bytes[Math.floor(bytes.length/2)]^=1;
  const altered=await owner.verify({scope:'research:local',payload,proof:bytes.toString('base64')});assert.equal(altered.ok,false);
  assert.deepEqual(await owner.close(),{closed:true});
});

function fakeChild({closeOnKill=true,output='{"ok":true,"valid":true}'}={}){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=0;
  child.stdin.on('data',()=>{});child.kill=()=>{child.kills++;if(closeOnKill)queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;};
  child.complete=()=>{child.stdout.write(output);child.stdout.end();child.emit('close',0,null);};return child;
}

test('rejects invalid inputs before spawn; fixed script does not contain user payload',async()=>{
  let called=0,seen;const child=fakeChild();
  const owner=createProjectFilesAuth({platform:'win32',systemRoot:'C:\\Windows',spawn:(exe,args,options)=>{called++;seen={exe,args,options};queueMicrotask(()=>child.complete());return child;}});
  assert.equal((await owner.verify({scope:'',payload:Buffer.from('x'),proof:'eA=='})).ok,false);assert.equal(called,0);
  const result=await owner.verify({scope:'test',payload:Buffer.from('sensitive fixture'),proof:'eA=='});assert.equal(result.value.valid,true);
  assert.equal(seen.args.join(' ').includes('sensitive fixture'),false);assert.equal(seen.options.shell,false);assert.equal(seen.options.windowsHide,true);
  assert.deepEqual(await owner.close(),{closed:true});
});

test('timeout with no close retains ownership and refuses another helper until the original closes',async()=>{
  const child=fakeChild({closeOnKill:false});let count=0;
  const owner=createProjectFilesAuth({platform:'win32',systemRoot:'C:\\Windows',timeoutMs:10,cleanupTimeoutMs:10,spawn:()=>{count++;return child;}});
  const result=await owner.seal({scope:'test',payload:Buffer.from('data')});assert.equal(result.error.code,'AUTH_CLEANUP_PENDING');
  const next=await owner.seal({scope:'test',payload:Buffer.from('data')});assert.equal(next.error.code,'AUTH_BUSY');assert.equal(count,1);
  assert.deepEqual(await owner.close(),{closed:false});child.emit('close',null,'SIGTERM');assert.deepEqual(await owner.close(),{closed:true});
});

test('malformed and oversized helper output never becomes an authenticated proof',async()=>{
  for(const output of ['{"ok":true,"valid":"true"}','x'.repeat(140000)]){
    const child=fakeChild({output}),owner=createProjectFilesAuth({platform:'win32',systemRoot:'C:\\Windows',spawn:()=>{queueMicrotask(()=>child.complete());return child;}});
    const result=await owner.verify({scope:'test',payload:Buffer.from('x'),proof:'eA=='});assert.equal(result.ok,false);assert.deepEqual(await owner.close(),{closed:true});
  }
});
