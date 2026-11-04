import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {captureReadonlyReceiptOwner} from './lib/workbench-receipt.mjs';
const directory=fileURLToPath(new URL('./workbench/validation/20261027-command-receipt-inspection/',import.meta.url));
async function fixture(){await fs.mkdir(directory,{recursive:true});const root=await fs.mkdtemp(path.join(directory,'owned-')),queue=path.join(root,'queue'),id=randomUUID(),session='a'.repeat(32),host={sessionId:session,pid:process.pid};for(const folder of ['inbox','outbox','processing'])await fs.mkdir(path.join(queue,folder),{recursive:true});await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));const request={id,targetSession:session,operation:'status',args:{},createdUtc:new Date().toISOString()},payload=JSON.stringify(request),temp=path.join(queue,'inbox',id+'.tmp');await fs.writeFile(temp,payload);let interpreted=0;const owner=captureReadonlyReceiptOwner({queue,preparedPath:temp,request,payload,host,interpret:text=>{interpreted++;return JSON.parse(text);}});assert.ok(owner&&Object.isFrozen(owner));const published=path.join(queue,'processing',id+'.json'),outbox=path.join(queue,'outbox',id+'.json');await fs.rename(temp,published);return {root,queue,id,session,payload,owner,published,outbox,get interpreted(){return interpreted;}};}

test('original file identity and bytes gate every read; this owner never publishes a request',async()=>{
  const f=await fixture();assert.equal(f.owner.inspect().value.status,'pending');await fs.writeFile(f.outbox,JSON.stringify({status:'received'}));assert.equal(f.owner.inspect().value.status,'received');assert.equal(f.interpreted,1);
  await fs.writeFile(f.published,f.payload+' ');assert.equal(f.owner.inspect().ok,false);assert.equal(f.interpreted,1);await fs.writeFile(f.published,f.payload);const held=f.published+'.held';await fs.rename(f.published,held);await fs.writeFile(f.published,f.payload);assert.equal(f.owner.inspect().ok,false);assert.equal(f.interpreted,1);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);assert.equal(f.owner.close().ok,true);assert.equal(f.owner.inspect().error.code,'RECEIPT_OWNER_CLOSED');
});
test('replacement directory and linked receipt are not adopted',async t=>{
  await t.test('directory replacement',async()=>{const f=await fixture(),outbox=path.join(f.queue,'outbox');await fs.rename(outbox,outbox+'.held');await fs.mkdir(outbox);assert.equal(f.owner.inspect().ok,false);assert.equal(f.owner.close().ok,true);});
  await t.test('hardlink',async()=>{const f=await fixture(),foreign=path.join(f.root,'foreign.json');await fs.writeFile(foreign,'{}');await fs.link(foreign,f.outbox);assert.equal(f.owner.inspect().ok,false);assert.equal(f.owner.close().ok,true);});
});
test('failed read cleanup retains its descriptor until the same owner confirms close',async t=>{
  const f=await fixture(),close=fsSync.closeSync;let fail=true;t.mock.method(fsSync,'closeSync',fd=>{if(fail){fail=false;throw new Error('controlled close failure');}return close(fd);});const result=f.owner.inspect();assert.equal(result.error.code,'RECEIPT_CLEANUP_PENDING');assert.equal(f.owner.close().ok,true);assert.equal(f.owner.inspect().error.code,'RECEIPT_OWNER_CLOSED');
});

test('host process, version and start identity must all match even when the session string matches',async()=>{
  const f=await fixture(),hostFile=path.join(f.queue,'host.json'),original=JSON.parse(await fs.readFile(hostFile,'utf8'));
  await fs.writeFile(hostFile,JSON.stringify({...original,pid:original.pid+1}));assert.equal(f.owner.inspect().value.status,'host_changed');assert.equal(f.interpreted,0);
  await fs.writeFile(hostFile,JSON.stringify(original));assert.equal(f.owner.inspect().value.status,'pending');assert.equal(f.owner.close().ok,true);
  const host={sessionId:f.session,pid:process.pid,version:'0.6.2',startedUtc:new Date().toISOString()},preparedPath=path.join(f.queue,'inbox',f.id+'.tmp');await fs.writeFile(hostFile,JSON.stringify(host));await fs.writeFile(preparedPath,f.payload);
  const owner=captureReadonlyReceiptOwner({queue:f.queue,preparedPath,request:JSON.parse(f.payload),payload:f.payload,host,interpret:()=>{throw new Error('Must not interpret a foreign host receipt');}});assert.ok(owner);
  for(const change of [{version:'0.6.3'},{startedUtc:'2026-01-01T00:00:00.000Z'}]){await fs.writeFile(hostFile,JSON.stringify({...host,...change}));assert.equal(owner.inspect().value.status,'host_changed');}
  assert.equal(owner.close().ok,true);
});
