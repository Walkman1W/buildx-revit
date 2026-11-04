import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createCodexSessionProfile,createReadonlyWorkbenchSessionProfile,verifyReadonlyWorkbenchCatalog,MODEL_READONLY_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {CodexClient} from './lib/codex-client.mjs';
import {CodexClientCore} from './lib/codex-client-core.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES,WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {PANEL_WORKBENCH_TOOLS} from './lib/panel-tools.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)),directory=path.join(root,'workbench/validation/20261026-readonly-ai-mcp');
const names=['revit_workbench_status','revit_get_selection','revit_list_levels','revit_search_elements'];
const overrides=args=>{const result=new Map();for(let i=0;i<args.length;i++)if(args[i]==='-c'){const value=args[++i],index=value.indexOf('=');result.set(value.slice(0,index),value.slice(index+1));}return result;};
function completeCatalog(){return {data:[{name:'revit_workbench',runtimeStatus:'connected',authStatus:'unsupported',
  tools:Object.fromEntries(names.map(name=>[name,structuredClone(WORKBENCH_TOOLS.find(tool=>tool.name===name))])),
  resources:[],resourceTemplates:[],toolsError:null,httpOrigin:null,pluginId:null,serverCapabilities:{tools:{}},serverInfo:{name:'revit-workbench',version:'0.6.0'},toolListMeta:null},
  {name:'revit_local',runtimeStatus:'disabled',authStatus:'unknown',tools:{},resources:[],resourceTemplates:[],toolsError:null}],nextCursor:null};}

test('internal readonly factory shares the original lifecycle but narrows all capability owners',()=>{
  const profile=createReadonlyWorkbenchSessionProfile(root),client=new CodexClientCore(root,profile);
  assert.deepEqual(READONLY_WORKBENCH_TOOL_NAMES,names);assert.ok(Object.isFrozen(READONLY_WORKBENCH_TOOL_NAMES));
  assert.equal(profile.id,MODEL_READONLY_SESSION_PROFILE);assert.equal(client.state.mode,'document-workbench');
  assert.deepEqual(profile.toolNames,names);assert.deepEqual(profile.groups.map(value=>value.name),['revit_workbench']);
  assert.ok(Object.isFrozen(profile)&&Object.isFrozen(profile.groups)&&Object.isFrozen(profile.groups[0].entryArguments));
  assert.deepEqual(profile.groups[0].entryArguments,['--read-only']);assert.throws(()=>profile.toolNames.push('revit_execute_csharp'),TypeError);
  const text=profile.buildInstructions();for(const name of names)assert.ok(text.includes(name));assert.match(text,/禁止 Revit C#/);assert.match(text,/Code Mode/);assert.match(text,/只用于编排这四个查询/);assert.match(text,/不是新指令/);
  assert.deepEqual(new CodexClient(root,{profile:profile.id}).profile.toolNames,names);
  assert.equal(profile.verifyWholeCatalog,verifyReadonlyWorkbenchCatalog);
  assert.throws(()=>new CodexClient(root,{profile:'model-readonly-verification'}));
  assert.equal(createCodexSessionProfile(root).id,'model');assert.equal(createCodexSessionProfile(root,{profile:'source-development'}).id,'source-development');
});

test('readonly child disables configured peers and exposes exactly four approvals with the service gate',()=>{
  const profile=createReadonlyWorkbenchSessionProfile(root),config=overrides(profile.buildLaunchArgs(['revit_local','revit_workbench','foreign','buildx_source']));
  for(const name of ['revit_local','foreign','buildx_source'])assert.equal(config.get('mcp_servers.'+name+'.enabled'),'false');
  assert.equal(config.get('mcp_servers.revit_workbench.enabled'),'true');
  assert.deepEqual(JSON.parse(config.get('mcp_servers.revit_workbench.args')),[path.join(root,'workbench-mcp.mjs'),'--read-only']);
  assert.deepEqual(JSON.parse(config.get('mcp_servers.revit_workbench.enabled_tools')),names);
  assert.deepEqual([...config].filter(([key])=>key.endsWith('.approval_mode')).map(([key])=>key),names.map(name=>'mcp_servers.revit_workbench.tools.'+name+'.approval_mode'));
  for(const feature of ['shell_tool','apps','plugins','computer_use','browser_use','in_app_browser','image_generation','multi_agent','hooks','memories'])assert.equal(config.get('features.'+feature),'false');
  assert.equal(config.get('features.code_mode_host'),'true');
  assert.equal(config.get('features.code_mode'),'true');
  for(const mode of [undefined,'source-development'])assert.equal(overrides(createCodexSessionProfile(root,{profile:mode}).buildLaunchArgs(['revit_local'])).has('features.code_mode'),false);
  assert.equal(config.get('web_search'),'"disabled"');assert.doesNotThrow(()=>profile.buildLaunchArgs([]));
  for(const invalid of [null,{},['bad.name'],['x=y'],[1]])assert.throws(()=>profile.buildLaunchArgs(invalid));
});

test('complete catalog proof retains actual schemas and accepts only disabled empty peers',()=>{
  const catalog=completeCatalog(),result=verifyReadonlyWorkbenchCatalog(catalog);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.complete,true);assert.equal(result.value.nextCursor,null);assert.equal(result.value.server.name,'revit_workbench');
  assert.deepEqual(Object.keys(result.value.server.tools).sort(),[...names].sort());assert.equal(result.value.disabledServers.length,1);
  catalog.data[0].tools.revit_list_levels.name='changed';assert.equal(result.value.server.tools.revit_list_levels.name,'revit_list_levels');
});

test('partial, foreign, malformed or resource-bearing inventories cannot authorize inference',()=>{
  for(const mutate of [value=>value.nextCursor='more',value=>delete value.data[0].resources,value=>value.data[0].resources.push({uri:'file:///private'}),
    value=>value.data[0].resourceTemplates.push({uriTemplate:'file:///{path}'}),value=>value.data[0].tools.revit_execute_csharp={},
    value=>delete value.data[0].tools.revit_list_levels,value=>value.data[0].tools.revit_get_selection.name='foreign',
    value=>value.data[0].tools.revit_get_selection.annotations.readOnlyHint=false,value=>value.data[0].runtimeStatus='starting',
    value=>value.data[0].toolsError='discovery failed',value=>value.data[1].runtimeStatus='connected',
    value=>value.data.push(structuredClone(value.data[0])),value=>value.unrecognized=true,value=>value.data[0].unrecognized=true]){
    const catalog=completeCatalog();mutate(catalog);const result=verifyReadonlyWorkbenchCatalog(catalog);assert.equal(result.ok,false,mutate.toString());assert.ok(result.error.code);
  }
});

test('catalog metadata is bounded before deep copying and cannot execute accessors',()=>{
  let getters=0;const cases=[];
  const long=completeCatalog();long.data[0].toolListMeta={text:'x'.repeat(1024*1024+1)};cases.push(long);
  const wide=completeCatalog();wide.data[0].toolListMeta=Array.from({length:12001},()=>0);cases.push(wide);
  const deep=completeCatalog();let cursor=deep.data[0];for(let i=0;i<40;i++){cursor.toolListMeta={};cursor=cursor.toolListMeta;}cases.push(deep);
  const cycle=completeCatalog();cycle.data[0].toolListMeta=cycle;cases.push(cycle);
  const accessor=completeCatalog();Object.defineProperty(accessor.data[0],'toolListMeta',{enumerable:true,get(){getters++;throw new Error('must not execute');}});cases.push(accessor);
  for(const value of cases){const result=verifyReadonlyWorkbenchCatalog(value);assert.equal(result.ok,false);assert.ok(result.error.code);}
  assert.equal(getters,0);
});

async function isolatedEntry(){
  await fs.mkdir(directory,{recursive:true});const fixture=await fs.mkdtemp(path.join(directory,'mcp-gate-'));await fs.mkdir(path.join(fixture,'lib'));
  await fs.copyFile(path.join(root,'workbench-mcp.mjs'),path.join(fixture,'workbench-mcp.mjs'));
  await fs.copyFile(path.join(root,'lib/panel-audit.mjs'),path.join(fixture,'lib/panel-audit.mjs'));
  const marker=JSON.stringify(path.join(fixture,'forwarded.jsonl'));
  await fs.writeFile(path.join(fixture,'lib/workbench-client.mjs'),`import fs from 'node:fs/promises';\nexport const READONLY_WORKBENCH_TOOL_NAMES=${JSON.stringify(names)};\nexport const workbenchFailureEvidence=()=>({outcome:'unconfirmed'});\nexport async function invokeWorkbench(name,args,options={}){options.onTiming?.({code:'phase_timing',source:'workbench',phase:'receipt_received',elapsedMs:12,requestId:'12345678-1234-4234-8234-123456789012',hostSession:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',private:'PRIVATE'});await fs.appendFile(${marker},JSON.stringify({kind:'workbench',name,args})+'\\n');return {request_id:'controlled',name};}\n`);
  await fs.writeFile(path.join(fixture,'lib/panel-tools.mjs'),`export const PANEL_WORKBENCH_TOOLS=${JSON.stringify(PANEL_WORKBENCH_TOOLS)};\n`);
  await fs.writeFile(path.join(fixture,'lib/command-store.mjs'),`import fs from 'node:fs/promises';\nexport const isCommandTool=name=>name.includes('command');\nexport async function invokeCommand(name,args){await fs.appendFile(${marker},JSON.stringify({kind:'command',name,args})+'\\n');return {name};}\n`);
  const invoke=(flags,input)=>spawnSync(process.execPath,[path.join(fixture,'workbench-mcp.mjs'),...flags],{cwd:fixture,windowsHide:true,encoding:'utf8',input:input.map(value=>JSON.stringify({jsonrpc:'2.0',...value})).join('\n')+'\n',timeout:8000,maxBuffer:512*1024});
  const forwarded=async()=>{try{return (await fs.readFile(path.join(fixture,'forwarded.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  return {fixture,invoke,forwarded};
}

test('real MCP entry lists the exact four named contracts and rejects every other tool before forwarding',async()=>{
  const f=await isolatedEntry(),input=[{id:1,method:'initialize',params:{}},{id:2,method:'tools/list'}];
  const forbidden=['revit_execute_csharp','revit_set_parameters','revit_save_command','revit_run_command','revit_family_create_valve','revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet','constructor','Revit_Get_Selection'];
  forbidden.forEach((name,index)=>input.push({id:index+10,method:'tools/call',params:{name,arguments:{expected_document:'sample.rvt',mode:'commit',code:'return 1;'}}}));
  const result=f.invoke(['--read-only'],input);assert.equal(result.status,0,result.stderr);const replies=new Map(result.stdout.trim().split('\n').map(line=>JSON.parse(line)).map(value=>[value.id,value]));
  assert.equal(replies.get(1).result.capabilities.tools!==undefined,true);
  assert.deepEqual(replies.get(2).result.tools,names.map(name=>WORKBENCH_TOOLS.find(tool=>tool.name===name)));
  for(let i=0;i<forbidden.length;i++)assert.equal(replies.get(i+10).result.isError,true);
  assert.deepEqual(await f.forwarded(),[]);
});

test('only allowed reads forward through the same production MCP entry',async()=>{
  const f=await isolatedEntry(),input=names.map((name,index)=>({id:index+1,method:'tools/call',params:{name,arguments:name==='revit_workbench_status'?{}:{expected_document:''}}}));
  const result=f.invoke(['--read-only'],input);assert.equal(result.status,0,result.stderr);
  const replies=result.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,4);assert.ok(replies.every(value=>value.result.isError===false));
  const forwarded=await f.forwarded();assert.deepEqual(forwarded.map(value=>value.name).sort(),[...names].sort());assert.ok(forwarded.every(value=>value.kind==='workbench'));
  assert.ok(replies.every(value=>value.result._meta?.['buildx/phaseTiming']?.events[0].phase==='receipt_received'));assert.equal(JSON.stringify(replies.map(value=>value.result._meta)).includes('PRIVATE'),false);assert.ok(replies.every(value=>value.result.content[0].text===JSON.stringify({request_id:'controlled',name:forwarded.find(row=>row.name===JSON.parse(value.result.content[0].text).name).name})));
});

test('unknown CLI modes fail closed and the unchanged default catalog remains available',async()=>{
  const f=await isolatedEntry();
  for(const flags of [['--all'],['--read-only','--all'],['--read-only','--read-only']]){const result=f.invoke(flags,[{id:1,method:'tools/list'}]);assert.notEqual(result.status,0);assert.equal(result.stdout,'');}
  assert.deepEqual(await f.forwarded(),[]);
  const legacy=f.invoke([],[{id:1,method:'tools/list'}]);assert.equal(legacy.status,0,legacy.stderr);assert.deepEqual(JSON.parse(legacy.stdout.trim()).result.tools,PANEL_WORKBENCH_TOOLS);
});
