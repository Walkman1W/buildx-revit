import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {CodexClientCore} from './lib/codex-client-core.mjs';

function profile(){
  const toolNames=Object.freeze(['fixture_read']),group=Object.freeze({name:'fixture_group',toolNames,statusTimeout:1000,failFast:true});
  return Object.freeze({id:'fixture',service:'fixture-codex',mode:'fixture',toolNames,groups:Object.freeze([group]),
    clientInfo:Object.freeze({name:'fixture',version:'1'}),buildLaunchArgs:()=>['fixture-stdio'],buildInstructions:()=>'fixed fixture instruction',
    connectingTools:'fixture checking',catalogFailed:'fixture catalog failure',catalogNotReady:'fixture not ready',verifiedDiagnostic:'fixture_verified',denialMessage:'fixture denied'});
}
function childFactory(profile){
  const children=[];
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.messages=[];
    child.stdin.write=(line,callback)=>{
      const request=JSON.parse(line);child.messages.push(request);
      queueMicrotask(()=>{
        callback?.();if(request.id===undefined)return;
        const result=request.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}}:
          request.method==='thread/start'?{thread:{id:'fixture-thread'}}:request.method==='mcpServerStatus/list'?
            {data:[{name:'fixture_group',runtimeStatus:'connected',tools:Object.fromEntries(profile.toolNames.map(name=>[name,{}]))}]}:{};
        child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
      });return true;
    };
    child.stdin.end=()=>queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});child.kill=()=>{throw new Error('Fixture must close normally');};children.push(child);return child;
  };
  return {children,dependencies:{spawn,resolveRuntimes:()=>({codex:'fixture-codex',python:'fixture-python'}),readConfiguredNames:()=>[],closeTimeoutMs:5,killTimeoutMs:5}};
}

test('core captures one internal frozen profile and cannot substitute mutable data or getters',()=>{
  const trusted=profile(),client=new CodexClientCore(process.cwd(),trusted);
  assert.equal(client.profile,trusted);assert.throws(()=>{client.profile=profile();},TypeError);assert.throws(()=>{client.profile.groups[0].toolNames.push('extra');},TypeError);
  for(const value of [undefined,null,{},[trusted],{...trusted},Object.freeze({...trusted,toolNames:['mutable']}),Object.freeze({...trusted,groups:[...trusted.groups]})])
    assert.throws(()=>new CodexClientCore(process.cwd(),value),/冻结/);
  let reads=0;const accessor=Object.freeze({...trusted,get service(){reads++;return 'mutable getter';}});
  assert.throws(()=>new CodexClientCore(process.cwd(),accessor),/冻结/);assert.equal(reads,0);
});

test('isolated core starts and closes from only core plus runtime resolver without research composition files',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-codex-core-'));
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('buildx-codex-core-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const name of ['codex-client-core.mjs','local-runtimes.mjs'])await fs.copyFile(new URL('./lib/'+name,import.meta.url),path.join(directory,name));
  const {CodexClientCore:IsolatedCore}=await import(pathToFileURL(path.join(directory,'codex-client-core.mjs')).href);
  const trusted=profile(),fake=childFactory(trusted),client=new IsolatedCore(directory,trusted,fake.dependencies);t.after(()=>client.close());
  await client.start();assert.equal(client.state.ready,true);assert.equal(client.state.toolCount,1);assert.equal(client.state.service,'fixture-codex');assert.equal(fake.children.length,1);
  const messages=fake.children[0].messages;assert.deepEqual(messages.map(message=>message.method),['initialize','initialized','account/read','thread/start','mcpServerStatus/list']);
  assert.equal(messages.find(message=>message.method==='thread/start').params.developerInstructions,'fixed fixture instruction');
  assert.deepEqual((await fs.readdir(directory)).sort(),['codex-client-core.mjs','local-runtimes.mjs']);assert.deepEqual(await client.close(),{closed:true,generation:1});
});
