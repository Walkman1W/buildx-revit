import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {CodexClient} from '../lib/codex-client.mjs';
import {resolveLocalRuntimes} from '../lib/local-runtimes.mjs';
import {createPanelServer} from '../lib/panel-server.mjs';

// Real client protocol boundary with a simulated local Codex. No credentials,
// real account, network or Revit process is used by these tests.
function fixture(initialAccount){
  const children=[],settings={account:initialAccount};let client;
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.messages=[];
    child.stdin.write=(line,callback)=>{
      const message=JSON.parse(line);child.messages.push(message);queueMicrotask(()=>callback?.());
      if(message.id===undefined)return true;
      let result={};
      if(message.method==='account/read')result=settings.account;
      if(message.method==='thread/start')result={thread:{id:'fixture-thread'}};
      if(message.method==='mcpServerStatus/list'){
        const group=client.profile.groups.find(item=>item.name===message.params.serverName);
        result={data:[{name:group.name,runtimeStatus:'connected',tools:Object.fromEntries(group.toolNames.map(name=>[name,{}]))}]};
      }
      queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n')));return true;
    };
    child.finish=()=>{if(child.finished)return;child.finished=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.stdin.end=()=>queueMicrotask(child.finish);child.kill=()=>{queueMicrotask(child.finish);return true;};children.push(child);return child;
  };
  client=new CodexClient(process.cwd(),{},{spawn,resolveRuntimes:()=>({codex:'fixture-codex',python:'fixture-python'}),readConfiguredNames:()=>['revit_local'],closeTimeoutMs:5,killTimeoutMs:5});
  return {client,settings,children};
}

test('missing signed-in account gives guidance but never starts login or claims readiness; explicit reconnect rechecks',async t=>{
  const f=fixture({requiresOpenaiAuth:true,account:null});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_INVALID'});
  assert.equal(f.client.state.setupIssue,'sign_in_required');assert.equal(f.client.state.ready,false);
  assert.ok(f.children[0].messages.every(item=>item.method!=='account/login/start'&&item.method!=='account/logout'));
  assert.ok(f.children[0].messages.every(item=>item.method!=='thread/start'));
  await f.client.close();
  f.settings.account={requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}};
  await f.client.start();assert.equal(f.client.state.setupIssue,null);assert.equal(f.client.state.ready,true);
  assert.equal(f.children.length,2);assert.ok(f.children[1].messages.some(item=>item.method==='account/read'));
});

test('a missing account property is not claimed to prove sign-in is required',async t=>{
  const f=fixture({requiresOpenaiAuth:true});t.after(()=>f.client.close());await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_INVALID'});
  assert.equal(f.client.state.setupIssue,null);assert.equal(f.client.state.ready,false);
});

test('an account notification invalidates earlier sign-in guidance without assuming success',async t=>{
  const f=fixture({requiresOpenaiAuth:true,account:null});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_INVALID'});assert.equal(f.client.state.setupIssue,'sign_in_required');
  f.children[0].stdout.emit('data',Buffer.from(JSON.stringify({method:'account/login/completed',params:{}})+'\n'));
  assert.equal(f.client.state.setupIssue,null);assert.equal(f.client.state.ready,false);
});

test('live local status endpoint preserves the account/read setup fact without starting a login',async t=>{
  const f=fixture({requiresOpenaiAuth:true,account:null});
  const app=createPanelServer({root:process.cwd(),codex:f.client,invokeWorkbench:async()=>{throw new Error('unexpected model call');},port:0});
  const address=await app.listen();t.after(async()=>{for(const child of f.children)child.finish();await app.close();});
  await app.connect();const response=await fetch(address.origin+'/api/status');const status=await response.json();
  assert.equal(response.status,200);assert.equal(status.setupIssue,'sign_in_required');assert.equal(status.ready,false);
  assert.ok(f.children[0].messages.every(item=>item.method!=='account/login/start'));
});

test('only typed local runtime failures produce installation guidance',async()=>{
  for(const [code,expected] of [['CODEX_NOT_FOUND','codex_missing'],['PYTHON_NOT_FOUND','python_missing'],['CODEX_PATH_AMBIGUOUS','codex_path_ambiguous'],['CODEX_WRAPPER_ONLY','codex_wrapper_only'],['PYTHON_PATH_UNVERIFIED','python_path_unverified'],['toString',null]]){
    let spawned=false;const client=new CodexClient(process.cwd(),{},{spawn:()=>{spawned=true;},resolveRuntimes:()=>{throw Object.assign(new Error('unrelated diagnostic'),{code});},readConfiguredNames:()=>[]});
    await assert.rejects(client.start());assert.equal(client.state.setupIssue,expected);assert.equal(client.state.ready,false);assert.equal(spawned,false);
  }
});

test('runtime owner reports distinct missing and invalid executable categories',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'buildx-setup-owner-'));
  const env={Path:'',LOCALAPPDATA:path.join(home,'appdata')};
  assert.throws(()=>resolveLocalRuntimes({home,env}),{code:'CODEX_NOT_FOUND'});
  assert.throws(()=>resolveLocalRuntimes({home,env:{...env,BUILDX_CODEX_EXE:'codex.exe'}}),{code:'CODEX_PATH_INVALID'});
  const codex=path.join(home,'bin','codex.exe');await mkdir(path.dirname(codex));await writeFile(codex,'fixture');env.Path=path.dirname(codex);
  assert.throws(()=>resolveLocalRuntimes({home,env}),{code:'PYTHON_NOT_FOUND'});
  assert.throws(()=>resolveLocalRuntimes({home,env:{...env,BUILDX_PYTHON_EXE:'python.exe'}}),{code:'PYTHON_PATH_INVALID'});
});

test('guidance uses only known status categories and clears old content on recovery',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const match=source.match(/function renderCodexSetup\(issue\) \{[\s\S]*?\n\}/);assert.ok(match);
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:''});return elements.get(id);};
  const context=vm.createContext({$:get});vm.runInContext(match[0],context);
  context.renderCodexSetup('sign_in_required');assert.equal(get('codex-setup-guide').hidden,false);assert.match(get('codex-setup-detail').textContent,/codex login/);
  context.renderCodexSetup('codex_missing');assert.match(get('codex-setup-title').textContent,/尚未找到/);
  context.renderCodexSetup('codex_wrapper_only');assert.match(get('codex-setup-detail').textContent,/命令包装/);
  context.renderCodexSetup('python_path_unverified');assert.match(get('codex-setup-detail').textContent,/不会启动/);
  context.renderCodexSetup('unknown-or-untrusted');assert.equal(get('codex-setup-guide').hidden,true);assert.equal(get('codex-setup-detail').textContent,'');
  context.renderCodexSetup(null);assert.equal(get('codex-setup-guide').hidden,true);
});
