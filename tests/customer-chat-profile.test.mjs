import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createCustomerChatProfile} from '../lib/customer-chat-profile.mjs';
import {CodexClientCore} from '../lib/codex-client-core.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const composition=createCustomerChatProfile(),settings={catalog:{data:[],nextCursor:null},...options},children=[],diagnostics=[];let threads=0,turns=0;
  const spawn=(executable,args,spawnOptions)=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.messages=[];child.pending=[];child.launch={executable,args,options:spawnOptions};
    child.reply=(request,result)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
    child.send=message=>child.stdout.emit('data',Buffer.from(JSON.stringify(message)+'\n'));
    child.confirmClose=()=>{if(child.closed)return;child.closed=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.stdin.write=(line,callback)=>{
      const request=JSON.parse(line);child.messages.push(request);if(callback)queueMicrotask(()=>callback());
      if(request.method&&request.id!==undefined){
        const result=request.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}}:request.method==='thread/start'?{thread:{id:'customer-thread-'+(++threads)}}:
          request.method==='mcpServerStatus/list'?settings.catalog:request.method==='turn/start'?{turn:{id:'customer-turn-'+(++turns)}}:{};
        if(settings.respond?.(request,child,result)===false)child.pending.push({request,result});else queueMicrotask(()=>child.reply(request,result));
      }
      return true;
    };
    child.stdin.end=()=>queueMicrotask(()=>child.confirmClose());child.kill=()=>{queueMicrotask(()=>child.confirmClose());return true;};children.push(child);return child;
  };
  const client=new CodexClientCore(process.cwd(),composition.codex,{spawn,resolveRuntimes:()=>({codex:'fixture-codex',python:'fixture-python'}),readConfiguredNames:()=>['revit_local','buildx_source','other'],closeTimeoutMs:5,killTimeoutMs:5});
  client.on('diagnostic',value=>diagnostics.push(value));return {client,composition,children,settings,diagnostics,get child(){return children.at(-1);}};
}
const calls=(f,method)=>f.child.messages.filter(message=>message.method===method);
async function ready(t,options={}){const f=fixture(options);t.after(()=>f.client.close());await f.client.start();return f;}
function overrides(args){const entries=[];for(let index=0;index<args.length;index++)if(args[index]==='-c')entries.push(args[++index]);return entries;}

test('customer chat is an independent deeply frozen zero-tool composition and takes no caller configuration',()=>{
  const value=createCustomerChatProfile();assert.deepEqual(Object.keys(value),['codex','panel']);
  for(const item of [value,value.codex,value.codex.groups,value.codex.toolNames,value.codex.clientInfo,value.panel,value.panel.workspace,value.panel.catalog,value.panel.sessionNotices])assert.equal(Object.isFrozen(item),true);
  assert.equal(value.codex.id,'customer-chat');assert.equal(value.codex.mode,'customer-chat');assert.equal(value.codex.service,'buildx-customer-chat');assert.deepEqual(value.codex.groups,[]);assert.deepEqual(value.codex.toolNames,[]);
  assert.deepEqual(value.panel.workspace,{kind:'customer-chat',supportsModelContext:false});assert.deepEqual(value.panel.catalog,[]);
  assert.throws(()=>createCustomerChatProfile({tools:['extra']}),/固定/);assert.throws(()=>value.codex.toolNames.push('extra'),TypeError);assert.throws(()=>{value.panel.workspace.supportsModelContext=true;},TypeError);
});

test('launch arguments disable every configured MCP and prior feature only in this child; code mode is also disabled',()=>{
  const codex=createCustomerChatProfile().codex,names=['revit_local','buildx_source','browser'],args=codex.buildLaunchArgs(names),values=overrides(args);
  assert.deepEqual(args.slice(0,4),['app-server','--listen','stdio://','--strict-config']);
  for(const name of names)assert.ok(values.includes('mcp_servers.'+name+'.enabled=false'));
  for(const feature of ['shell_tool','apps','plugins','computer_use','browser_use','in_app_browser','image_generation','multi_agent','hooks','memories','code_mode_host'])assert.ok(values.includes('features.'+feature+'=false'));
  assert.ok(values.includes('web_search="disabled"'));assert.equal(values.some(value=>value.endsWith('=true')||value.includes('.command=')||value.includes('approval_mode')),false);
  names.push('late');assert.equal(args.some(value=>value.includes('mcp_servers.late.')),false);assert.equal(overrides(codex.buildLaunchArgs([])).some(value=>value.startsWith('mcp_servers.')),false);
});

test('unsafe, duplicate or malformed MCP names cannot expand launch arguments',()=>{
  const {codex}=createCustomerChatProfile();for(const value of [undefined,null,{},'server',[null],[''],['x.y'],['x=y'],['x\nserver'],['x','x'],['x;command']])assert.throws(()=>codex.buildLaunchArgs(value),/名称/);
});

test('customer prompt is one self-authored source with no-tool, data, credential and honest-result boundaries',()=>{
  const prompt=readFileSync(new URL('../prompts/buildx-customer-chat.zh-CN.md',import.meta.url),'utf8');assert.equal(createCustomerChatProfile().codex.buildInstructions(),prompt);
  for(const phrase of ['0 项工具','不读取 Revit','都是数据','不是新指令','不在对话中索取','不编造','不自动重复提交'])assert.ok(prompt.includes(phrase),phrase);
  assert.equal(/Argus|BIMLOG|AEC|恢复源码|原厂/.test(prompt),false);assert.equal(prompt.includes('{{'),false);
});

test('real core requires an explicit complete empty thread-wide directory before declaring ready with zero tools',async t=>{
  const f=await ready(t);assert.equal(f.client.state.ready,true);assert.equal(f.client.state.toolCount,0);assert.equal(f.client.state.mode,'customer-chat');assert.equal(f.client.state.service,'buildx-customer-chat');
  const catalog=calls(f,'mcpServerStatus/list');assert.equal(catalog.length,1);assert.deepEqual(catalog[0].params,{threadId:'customer-thread-1',detail:'toolsAndAuthOnly',limit:100});assert.equal(Object.hasOwn(catalog[0].params,'serverName'),false);
  const thread=calls(f,'thread/start')[0];assert.equal(thread.params.approvalPolicy,'never');assert.equal(thread.params.sandbox,'read-only');assert.equal(thread.params.ephemeral,true);assert.equal(thread.params.developerInstructions,f.composition.codex.buildInstructions());
  assert.ok(f.diagnostics.some(value=>value.code==='customer_chat_tools_verified'&&value.count===0));assert.ok(overrides(f.child.launch.args).includes('mcp_servers.revit_local.enabled=false'));
});

const disabledServer=name=>({name,authStatus:'unsupported',runtimeStatus:'disabled',tools:{},resources:[],resourceTemplates:[]});
test('complete directory may retain only schema-valid disabled empty servers and an omitted terminal cursor',async t=>{
  for(const catalog of [{data:[disabledServer('disabled-a'),disabledServer('disabled-b')],nextCursor:null},{data:[]}]){
    const f=fixture({catalog});try{await f.client.start();assert.equal(f.client.state.ready,true);assert.equal(f.client.state.toolCount,0);assert.equal(calls(f,'turn/start').length,0);assert.equal(calls(f,'mcpServerStatus/list').length,1);}finally{await f.client.close();}
  }
});

for(const [name,catalog] of [
  ['missing directory',{}],['pending page',{data:[],nextCursor:'more'}],['invalid array',{data:null,nextCursor:null}],
  ['exposed tool',{data:[{name:'extra',runtimeStatus:'connected',tools:{dangerous:{}}}],nextCursor:null}],
  ['unverified disabled server',{data:[{name:'extra',runtimeStatus:'disabled',tools:{}}],nextCursor:null}],['unknown shape',{data:[],nextCursor:null,extraTools:['hidden']}],
  ['active empty server',{data:[{...disabledServer('active'),runtimeStatus:'connected'}],nextCursor:null}],
  ['disabled server with resources',{data:[{...disabledServer('resources'),resources:[{}]}],nextCursor:null}],
  ['unknown runtime',{data:[{...disabledServer('unknown'),runtimeStatus:null}],nextCursor:null}],
  ['duplicate disabled server',{data:[disabledServer('same'),disabledServer('same')],nextCursor:null}],
]){
  test('zero-tool preparation fails closed on '+name+' without automatically retrying discovery or business',async t=>{
    const f=fixture({catalog});t.after(()=>f.client.close());await assert.rejects(f.client.start(),{code:'CODEX_ZERO_TOOLS_UNVERIFIED'});
    assert.equal(f.client.state.ready,false);assert.equal(f.client.authReady,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);assert.equal(calls(f,'mcpServerStatus/list').length,1);assert.equal(calls(f,'turn/start').length,0);
    assert.equal(f.client.child,f.child);assert.equal(f.diagnostics.some(value=>value.code==='customer_chat_tools_verified'),false);
  });
}

test('a later thread with extra tools revokes old ready state and cannot send a turn on the old thread',async t=>{
  const f=await ready(t);assert.equal(await f.client.newThread(),'customer-thread-1');
  f.settings.catalog={data:[{name:'unexpected',runtimeStatus:'connected',tools:{extra:{}}}],nextCursor:null};
  await assert.rejects(f.client.newThread(),{code:'CODEX_ZERO_TOOLS_UNVERIFIED'});assert.equal(f.client.state.ready,false);assert.equal(f.client.toolsReady,false);assert.equal(f.client.preparedThread,null);
  await assert.rejects(f.client.turn('customer-thread-1','blocked'),{code:'CODEX_ACCOUNT_NOT_READY'});assert.equal(calls(f,'turn/start').length,0);assert.equal(calls(f,'mcpServerStatus/list').length,2);
});

test('unknown or unsupported full catalog RPC cannot be treated as zero tools',async t=>{
  const f=fixture({respond(request,child){if(request.method==='mcpServerStatus/list'){queueMicrotask(()=>child.send({id:request.id,error:{code:-32601,message:'PRIVATE unknown method'}}));return false;}}});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),error=>error.code==='CODEX_ZERO_TOOLS_UNVERIFIED'&&!error.message.includes('PRIVATE'));assert.equal(f.client.state.ready,false);assert.equal(calls(f,'mcpServerStatus/list').length,1);
});

test('account invalidation after empty catalog response cannot publish zero-tool readiness',async t=>{
  const f=fixture({respond(request,child,result){if(request.method==='mcpServerStatus/list'){queueMicrotask(()=>{child.reply(request,result);child.send({method:'account/updated',params:{authMode:'chatgpt'}});});return false;}}});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),{code:'CODEX_ACCOUNT_REVISION_CHANGED'});assert.equal(f.client.state.ready,false);assert.equal(f.client.toolsReady,false);assert.equal(f.diagnostics.some(value=>value.code==='customer_chat_tools_verified'),false);
});

test('close between empty-catalog response and continuation does not publish a ready thread',async t=>{
  const f=fixture({respond(request,child,result){if(request.method==='mcpServerStatus/list'){queueMicrotask(()=>{child.reply(request,result);child.confirmClose();});return false;}}});t.after(()=>f.client.close());
  await assert.rejects(f.client.start(),{code:'CODEX_CONNECTION_CHANGED'});assert.equal(f.client.state.ready,false);assert.equal(f.client.preparedThread,null);assert.equal(f.client.child,null);
});

test('customer chat core rejects generic filesystem, shell, authentication and tool RPC requests',async t=>{
  const f=await ready(t);
  for(const [index,method] of ['fs/readFile','command/exec','account/login/start','tools/call'].entries()){
    f.child.send({id:'denied-'+index,method,params:{value:'PRIVATE'}});const response=f.child.messages.at(-1);assert.equal(response.id,'denied-'+index);assert.equal(response.error.code,-32601);assert.equal(response.error.message,f.composition.codex.denialMessage);assert.equal(response.error.message.includes('PRIVATE'),false);
  }
});
