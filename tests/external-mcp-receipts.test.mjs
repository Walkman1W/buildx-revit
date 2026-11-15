import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,open,writeFile,utimes,rename,mkdir} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {createExternalMcpReceipts} from '../lib/external-mcp-receipts.mjs';
import {snapshotExternalMcpData} from '../lib/external-mcp-owner.mjs';

const binding={accountId:'test-account',sessionId:'test-session',connectionId:'test-connection',conversationId:'test-conversation'};
const proof=Object.freeze({async verify(){return true;}}); // test fixture only: not an ACL assertion
const fixture=fileURLToPath(new URL('../test-support/external-mcp-receipts-fixture.mjs',import.meta.url));
const digest=value=>snapshotExternalMcpData(value).digest;
function attempt(){const schema={type:'object',properties:{value:{type:'string'}}},args={value:'example'};return {attemptId:randomUUID(),serverId:randomUUID(),generation:randomUUID(),tool:'test-tool',argumentDigest:digest(args),schemaDigest:digest(schema),server:{command:'test.exe',args:[],cwd:'C:\\fixture',executableSha256:'a'.repeat(64)},inputSchema:schema,arguments:args,sensitivePaths:[],outcome:'unknown'};}

test('attempt is persisted before dispatch, outcome appends and original unknown remains',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-log-')),store=createExternalMcpReceipts({root,identity:binding,privateRootOwner:proof}),a=attempt();
  assert.deepEqual(await store.ready(),{ok:true,unresolved:[]});assert.equal(await store.recordAttempt(a),true);
  const blocked=attempt();assert.equal(await store.recordAttempt(blocked),false);
  assert.equal((await store.ready()).unresolved.length,1);
  const result={content:[{type:'text',text:'test result'}]},outcome={...a,outcome:'response_received',responseDigest:digest(result),result,isError:false};
  assert.equal(await store.recordOutcome(outcome),true);assert.equal((await store.ready()).unresolved.length,0);
  const folder=path.join(root,'mcp-'+createHash('sha256').update(binding.accountId).digest('hex'));
  assert.equal(JSON.parse(await readFile(path.join(folder,'a-'+a.attemptId+'.json'),'utf8')).payload.outcome,'unknown');
  assert.equal(JSON.parse(await readFile(path.join(folder,'o-'+a.attemptId+'.json'),'utf8')).payload.result.content[0].text,'test result');
  assert.equal((await store.close()).ok,true);
});

test('changing proof, account or operation data cannot complete another attempt',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-proof-'));let allowed=true;
  const dynamicProof=Object.freeze({async verify(){return allowed;}}),owner=createExternalMcpReceipts({root,identity:binding,privateRootOwner:dynamicProof}),a=attempt();
  assert.equal(await owner.recordAttempt(a),true);
  const r={content:[]},outcome={...a,arguments:{value:'changed'},outcome:'response_received',responseDigest:digest(r),result:r,isError:false};
  assert.equal(await owner.recordOutcome(outcome),false);allowed=false;assert.equal(await owner.recordAttempt(attempt()),false);
  allowed=true;assert.equal((await owner.close()).ok,true);
  const different=createExternalMcpReceipts({root,identity:{...binding,accountId:'other-account'},privateRootOwner:proof});assert.deepEqual(await different.ready(),{ok:true,unresolved:[]});assert.equal((await different.close()).ok,true);
});

test('crash after durable attempt retains unknown and stale lock blocks new owner',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-crash-')),a=attempt(),encoded=Buffer.from(JSON.stringify(a)).toString('base64url');
  const child=fork(fixture,[root,encoded],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const started=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});assert.equal(started.stored,true);
  const ended=new Promise(resolve=>child.once('close',resolve));child.kill();await ended;
  const folder=path.join(root,'mcp-'+createHash('sha256').update(binding.accountId).digest('hex'));
  const names=await readdir(folder);assert.ok(names.includes('.external-mcp.lock'));const saved=JSON.parse(await readFile(path.join(folder,'a-'+a.attemptId+'.json'),'utf8'));assert.equal(saved.payload.outcome,'unknown');
  const replacement=createExternalMcpReceipts({root,identity:binding,privateRootOwner:proof});assert.deepEqual(await replacement.ready(),{ok:false,code:'RECEIPT_LOCKED'});
  assert.equal(await replacement.recordAttempt(attempt()),false);assert.equal(JSON.parse(await readFile(path.join(folder,'a-'+a.attemptId+'.json'),'utf8')).payload.outcome,'unknown');
});

test('same inode and size rewrite during read is detected before returning the record',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-race-')),a=attempt(),first=createExternalMcpReceipts({root,identity:binding,privateRootOwner:proof});
  assert.equal(await first.recordAttempt(a),true);assert.equal((await first.close()).ok,true);let changed=false;
  const racedOpen=async(file,...args)=>{
    const h=await open(file,...args);
    if(!path.basename(file).startsWith('a-')||changed)return h;
    return {stat:(...x)=>h.stat(...x),close:()=>h.close(),read:async(...x)=>{
      const result=await h.read(...x);if(!changed){changed=true;const data=await readFile(file);await writeFile(file,Buffer.alloc(data.length,0x20));const future=new Date(Date.now()+5000);await utimes(file,future,future);}return result;
    }};
  };
  const second=createExternalMcpReceipts({root,identity:binding,privateRootOwner:proof},{open:racedOpen});
  assert.deepEqual(await second.ready(),{ok:false,code:'RECEIPT_RECORD_CHANGED'});assert.equal(changed,true);assert.equal((await second.close()).ok,true);
});

test('replacing the selected private root fails closed without modifying the replacement',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-root-')),root=path.join(parent,'private');await mkdir(root);
  const owner=createExternalMcpReceipts({root,identity:binding,privateRootOwner:proof});await rename(root,path.join(parent,'old'));await mkdir(root);
  assert.deepEqual(await owner.ready(),{ok:false,code:'RECEIPT_ROOT_CHANGED'});assert.deepEqual(await readdir(root),[]);
});
