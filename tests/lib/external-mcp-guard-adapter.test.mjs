import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createExternalMcpGuardAdapter} from '../../lib/external-mcp-guard-adapter.mjs';

const base=fileURLToPath(new URL('../../',import.meta.url));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const input=()=>({command:process.execPath,cwd:base,args:[],executableIdentity:'test',executableSha256:'a'.repeat(64),cwdIdentity:'test',environment:{},maxBufferSize:65536,StdioClientTransport});
function fixture(overrides={}){
  const counts={start:0,rawClose:0,confirm:0,dispose:0};
  const raw={start:async()=>{},send:async()=>{},close:async()=>{counts.rawClose++;if(overrides.rawClose)return overrides.rawClose();raw.onclose?.();}};
  const session=Object.freeze({transport:raw,
    startAtomic:async()=>{counts.start++;if(overrides.start)return overrides.start();},
    confirmClosed:async()=>{counts.confirm++;return overrides.confirm?overrides.confirm():true;},
    disposeUnstarted:async()=>{counts.dispose++;return overrides.dispose?overrides.dispose():true;}});
  const guard=createExternalMcpGuardAdapter({launcher:Object.freeze({prepare:()=>session})});
  return {guard,raw,counts,transport:guard.createTransport(input())};
}

test('missing or malformed trusted launcher cannot produce a transport',()=>{
  assert.throws(()=>createExternalMcpGuardAdapter());
  const bad=createExternalMcpGuardAdapter({launcher:Object.freeze({prepare:()=>({})})});
  assert.throws(()=>bad.createTransport(input()));
});

test('prepared transport has not spawned and disposal excludes a concurrent start',async()=>{
  const gate=deferred(),f=fixture({dispose:()=>gate.promise});
  const dispose=f.guard.disposeUnstarted({transport:f.transport});
  await assert.rejects(f.transport.start());assert.equal(f.counts.start,0);
  const second=f.guard.disposeUnstarted({transport:f.transport});
  gate.resolve(true);assert.equal(await dispose,true);assert.equal(await second,true);
  assert.equal(f.counts.dispose,1);assert.equal(await f.guard.disposeUnstarted({transport:f.transport}),false);
});

test('failed unstarted disposal is retained for retry and foreign transports are refused',async()=>{
  let complete=false;const f=fixture({dispose:()=>complete});
  assert.equal(await f.guard.disposeUnstarted({transport:{}}),false);
  assert.equal(await f.guard.disposeUnstarted({transport:f.transport}),false);
  complete=true;assert.equal(await f.guard.disposeUnstarted({transport:f.transport}),true);assert.equal(f.counts.dispose,2);
});

test('SDK close of a never-started transport emits close only after confirmed disposal',async()=>{
  let confirmed=false,closed=0;const f=fixture({dispose:()=>confirmed});f.transport.onclose=()=>closed++;
  await assert.rejects(f.transport.close());assert.equal(closed,0);
  confirmed=true;await f.transport.close();assert.equal(closed,1);assert.equal(f.counts.start,0);
  await f.transport.close();assert.equal(closed,1);
});

test('SDK onclose alone does not release until native job and pipe proof confirms',async()=>{
  let confirmed=false,closed=0;const f=fixture({confirm:()=>confirmed});
  f.transport.onclose=()=>closed++;await f.transport.start();f.raw.onclose();
  await new Promise(r=>setImmediate(r));assert.equal(closed,0);
  await assert.rejects(f.transport.close());assert.equal(closed,0);
  confirmed=true;await f.transport.close();assert.equal(closed,1);
  await f.transport.close();assert.equal(closed,1);
});

test('close cannot release an in-flight or failed atomic launch prematurely',async()=>{
  const gate=deferred(),f=fixture({start:()=>gate.promise});let closed=0;
  f.transport.onclose=()=>closed++;const starting=assert.rejects(f.transport.start());const closing=f.transport.close();
  await new Promise(r=>setImmediate(r));assert.equal(f.counts.rawClose,0);assert.equal(closed,0);
  gate.resolve();await starting;await closing;assert.equal(f.counts.rawClose,1);assert.equal(closed,1);
});

test('a raw close blocks messages synchronously while job proof is pending',async()=>{
  const gate=deferred(),f=fixture({confirm:()=>gate.promise});await f.transport.start();
  f.raw.onclose();assert.throws(()=>f.transport.send({}));
  gate.resolve(true);await new Promise(r=>setImmediate(r));
});

test('raw close during startup cannot return the transport to running',async()=>{
  const gate=deferred(),f=fixture({start:()=>gate.promise});const starting=assert.rejects(f.transport.start());
  await new Promise(r=>setImmediate(r));f.raw.onclose();gate.resolve();await starting;
  assert.throws(()=>f.transport.send({}));
});

test('explicit close blocks messages before underlying close completes',async()=>{
  const gate=deferred(),f=fixture({rawClose:()=>gate.promise});await f.transport.start();
  const closing=f.transport.close();assert.throws(()=>f.transport.send({}));
  gate.resolve();await closing;
});

test('native confirmation retry never duplicates an in-flight confirmation',async()=>{
  const gate=deferred(),f=fixture({confirm:()=>gate.promise});await f.transport.start();
  f.raw.onclose();await new Promise(r=>setImmediate(r));
  const first=f.transport.close(),second=f.transport.close();await new Promise(r=>setImmediate(r));
  assert.equal(f.counts.confirm,1);gate.resolve(true);await Promise.all([first,second]);
  assert.equal(f.counts.rawClose,1);
});

test('a failed raw close is not sent twice when job proof is later recovered',async()=>{
  let confirmed=false;const f=fixture({rawClose:()=>{throw Error('unknown');},confirm:()=>confirmed});
  let closed=0;f.transport.onclose=()=>closed++;await f.transport.start();
  await assert.rejects(f.transport.close());assert.equal(closed,0);assert.equal(f.counts.rawClose,1);
  confirmed=true;await f.transport.close();assert.equal(closed,1);assert.equal(f.counts.rawClose,1);
});

test('adapter retains unconfirmed sessions and retries cleanup after caller loses ownership',async()=>{
  let confirmed=false;const f=fixture({confirm:()=>confirmed});await f.transport.start();
  assert.deepEqual(await f.guard.close(),{closed:false,remaining:1});
  assert.throws(()=>f.guard.createTransport(input()));
  confirmed=true;assert.deepEqual(await f.guard.close(),{closed:true,remaining:0});
  assert.equal(f.counts.rawClose,1);
});

test('adapter refuses new transports immediately while disposal is in flight',async()=>{
  const gate=deferred(),f=fixture({dispose:()=>gate.promise});const closing=f.guard.close();
  assert.throws(()=>f.guard.createTransport(input()));gate.resolve(true);
  assert.deepEqual(await closing,{closed:true,remaining:0});assert.equal(f.counts.dispose,1);
});

test('SDK client handshake and tool list traverse an isolated fixture transport',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-adapter-'));
  const factory=Object.freeze({prepare:spec=>{
    // Test-only launcher: ordinary SDK spawning and assumed cleanup proof.
    // This fixture does not establish helper identity or Job ownership.
    const raw=new spec.StdioClientTransport({command:process.execPath,args:[path.join(base,'test-support','external-mcp-fixture.mjs'),path.join(dir,'marker.jsonl')],cwd:dir,stderr:'pipe',maxBufferSize:spec.maxBufferSize});
    return Object.freeze({transport:raw,startAtomic:()=>raw.start(),confirmClosed:async()=>true,disposeUnstarted:async()=>true});
  }});
  const adapter=createExternalMcpGuardAdapter({launcher:factory}),transport=adapter.createTransport(input());
  const client=new Client({name:'buildx-guard-adapter-fixture',version:'0.1.0'},{versionNegotiation:{mode:'legacy'}});
  try{await client.connect(transport,{timeout:10000});const {tools}=await client.listTools();assert.equal(tools[0].name,'record');}
  finally{await client.close();}
});
