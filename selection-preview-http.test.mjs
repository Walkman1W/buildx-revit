import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from './lib/panel-server.mjs';
import {invokeAtomicWorkbenchRead} from './lib/workbench-client.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
class FakeCodex extends EventEmitter{
  constructor(){super();this.state={ready:true,error:false,message:'fake ready',toolCount:31};this.threads=0;this.turns=[];this.interrupts=[];this.starts=0;this.closes=0;}
  async start(){this.starts++;this.state={...this.state,ready:true,error:false};this.emit('state',this.state);}
  failed(message){this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);}
  async close(){this.closes++;this.failed('fake connection closed');return {closed:true};}
  async newThread(){return 'thread-'+(++this.threads);}
  async turn(threadId,text){const turnId='turn-'+(this.turns.length+1);this.turns.push({threadId,text,turnId});if(this.onTurn)await this.onTurn(this.turns.at(-1));return {turn:{id:turnId}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});}
  notify(method,turn,params={}){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...params});}
}
async function setup(t,options={}){
  const codex=new FakeCodex(),calls=[],records=[];
  const app=createPanelServer({root,codex,port:0,invokeWorkbench:async(...args)=>{calls.push(args);throw new Error('unexpected Revit read');},audit:(file,data)=>records.push({file,data}),...options});
  const {origin}=await app.listen();const data=await(await fetch(origin+'/api/status')).json();
  const streams=[];
  t.after(async()=>{for(const stream of streams)stream.abort();await app.close();});
  async function post(route,value={},headers={}){const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Chat':data.csrf,Origin:origin,...headers},body:JSON.stringify({client:'client-a',...value})});return {status:response.status,data:await response.json()};}
  async function events(client='client-a'){
    const controller=new AbortController();streams.push(controller);const response=await fetch(origin+'/api/events?client='+client,{signal:controller.signal});const reader=response.body.getReader();let buffer='';
    return {async next(){while(true){const index=buffer.indexOf('\n\n');if(index>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);if(!block.startsWith('event: '))continue;return {event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};}const {value,done}=await reader.read();if(done)throw new Error('stream ended');buffer+=new TextDecoder().decode(value);}},abort:()=>controller.abort()};
  }
  return {app,codex,calls,records,origin,post,events};
}

const doc={title:'Model A',path:'D:\\model.rvt',activeViewId:12,activeViewType:'ThreeD'};
const snapshot={hostSession:'a'.repeat(32),document:doc};
const answer=()=>({operation:'get_selection',hostSession:snapshot.hostSession,document:doc,snapshot,value:{total:1,returned:1,truncated:false,items:[{element_id:42}]}});
test('existing HTTP context replaces its snapshot and send captures again',async t=>{
 let calls=[]; const f=await setup(t,{invokeAtomicContextRead:async(name)=>{calls.push(name);return name==='revit_workbench_status'?{...snapshot,snapshot}:answer();}});
 assert.equal((await f.post('context',{includeDocument:true})).status,200);const before=f.app.snapshot('client-a').session.context;
 const result=await f.post('context',{includeDocument:false,includeSelection:true});assert.equal(result.status,200);assert.deepEqual(result.data.context.selection.elementIds,['42']);
 const after=f.app.snapshot('client-a').session.context;assert.deepEqual(after,result.data.context);assert.equal(after.document.title,before.document.title);
 assert.equal((await f.post('turn',{message:'选择',context:{includeSelection:true}})).status,202);assert.deepEqual(calls,['revit_workbench_status','revit_get_selection','revit_get_selection']);
});
test('failed existing context read publishes error and clears old context without retry',async t=>{
 let calls=0;const f=await setup(t,{invokeAtomicContextRead:async name=>{calls++;if(name==='revit_get_selection')throw new Error('fixture failure');return {...snapshot,snapshot};}});
 assert.equal((await f.post('context',{includeDocument:true})).status,200);assert.equal((await f.post('context',{includeSelection:true})).status,502);
 const context=f.app.snapshot('client-a').session.context;assert.equal(context.document,null);assert.match(context.error,/fixture failure/);assert.equal(calls,2);
});
