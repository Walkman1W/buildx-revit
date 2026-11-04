import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {NATIVE_MODEL_QUERY_OPERATION_BY_TOOL} from './lib/native-model-queries.mjs';

const project=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(project,'artifacts');
const base={schemaVersion:2,installationId:'6ab8f6cf-0bad-4149-9184-e19b2031da4d',nodeExecutable:'C:\\fixture-runtime\\node.exe',pythonExecutable:'C:\\fixture-runtime\\python.exe',codexExecutable:'C:\\existing-codex\\codex.exe'};
const session='e'.repeat(32);
async function fixture(t,{schemaVersion=2,invalidConfiguration=false}={}){
  await fs.mkdir(artifacts,{recursive:true});const stage=await fs.mkdtemp(path.join(artifacts,'installed-layout-mcp-')),programRoot=path.join(stage,'program'),externalData=path.join(stage,'data'),dataRoot=schemaVersion===1?programRoot:externalData;
  await fs.mkdir(programRoot);await fs.mkdir(externalData);const clients=[],requests=[],errors=[];let stopped=false,pump=null;
  t.after(async()=>{for(const client of clients)await client.close();stopped=true;if(pump)await pump;assert.deepEqual(errors,[]);const target=path.resolve(stage);assert.equal(path.dirname(target),path.resolve(artifacts));assert.ok(path.basename(target).startsWith('installed-layout-mcp-'));await fs.rm(target,{recursive:true,force:true});});
  await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(programRoot,'workbench-mcp.mjs'));
  for(const directory of ['lib','public','release'])await fs.cp(path.join(project,directory),path.join(programRoot,directory),{recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return entry.isDirectory()||entry.isFile()&&['.mjs','.json'].includes(path.extname(filename));}});
  await fs.writeFile(path.join(programRoot,'package.json'),JSON.stringify({private:true,type:'module'}));
  const config={...base,schemaVersion,...schemaVersion===2&&!invalidConfiguration?{dataRoot}:{}};await fs.writeFile(path.join(programRoot,'buildx-installation.json'),JSON.stringify(config));
  if(schemaVersion===2&&!invalidConfiguration)await fs.writeFile(path.join(dataRoot,'buildx-data-owner.json'),JSON.stringify({schemaVersion:1,installationId:base.installationId}));
  const queue=path.join(dataRoot,'workbench','queue');
  if(!invalidConfiguration){
    for(const directory of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,directory),{recursive:true});
    await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.8.1',atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL)}));
    pump=(async()=>{while(!stopped){for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);await fs.rename(path.join(queue,'inbox',filename),processing);const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);assert.equal(request.operation,'health');
      const result={operation:'health',hostSession:session,atomicReadSnapshot:true,snapshot:{hostSession:session,hostVersion:'0.8.1',document:null,capabilities:{atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL)}},value:{operation:'health',hostSession:session,document:null,modifiedByOperation:false,value:{schema_version:1,status:'no_document',document_open:false}}};
      const temporary=path.join(queue,'outbox',filename+'.tmp');await fs.writeFile(temporary,JSON.stringify({id:request.id,ok:true,result,completedUtc:new Date().toISOString()}));await fs.rename(temporary,path.join(queue,'outbox',filename));
    }await new Promise(resolve=>setTimeout(resolve,4));}})().catch(error=>errors.push(String(error)));
  }
  const connect=async()=>{const stderr=[],transport=new StdioClientTransport({command:process.execPath,args:[path.join(programRoot,'workbench-mcp.mjs'),'--workspace'],cwd:programRoot,stderr:'pipe'});transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));const client=new Client({name:'installed-layout-verification',version:'1.0.0'},{capabilities:{}});clients.push(client);await client.connect(transport);await client.listTools();return {client,stderr};};
  const runCommandStore=async()=>{
    const script=path.join(programRoot,'controlled-command-store.mjs');await fs.writeFile(script,"import {invokeCommand} from './lib/command-store.mjs'; const saved=await invokeCommand('revit_save_command',{command_id:'installed-layout-fixture',name:'Layout fixture',description:'Stores source only; never invokes Revit.',code:'return 17;'}); const read=await invokeCommand('revit_get_command',{command_id:saved.command_id,revision:saved.revision}); console.log(JSON.stringify({saved,read}));");
    const child=spawnSync(process.execPath,[script],{cwd:programRoot,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
  };
  return {stage,programRoot,dataRoot,externalData,queue,requests,connect,runCommandStore};
}

test('schema2 production MCP queue and stored-command defaults use the external data root',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),{client,stderr}=await f.connect();
  const response=await client.callTool({name:'revit_health',arguments:{}},{timeout:7000});assert.equal(response.isError,false,JSON.stringify(response));assert.equal(response.structuredContent.value.document_open,false);assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);
  const commands=await f.runCommandStore();assert.equal(commands.read.code,'return 17;');assert.equal(commands.saved.created,true);
  const filename=path.join(f.dataRoot,'workbench','commands',commands.saved.command_id,commands.saved.revision+'.json');assert.equal(JSON.parse(await fs.readFile(filename,'utf8')).code,'return 17;');
  const viaMcp=await client.callTool({name:'revit_get_command',arguments:{command_id:commands.saved.command_id,revision:commands.saved.revision}},{timeout:7000});assert.equal(viaMcp.isError,false,JSON.stringify(viaMcp));assert.equal(JSON.parse(viaMcp.content[0].text).code,'return 17;');assert.equal(f.requests.length,1,'reading stored source does not invoke Revit');
  await assert.rejects(fs.stat(path.join(f.programRoot,'workbench')),error=>error.code==='ENOENT');assert.deepEqual(stderr,[]);
});

test('schema1 production subprocesses retain the legacy queue and command roots without migrating data',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t,{schemaVersion:1}),history=path.join(f.programRoot,'runtime-history','retained.txt');await fs.mkdir(path.dirname(history));await fs.writeFile(history,'legacy history');
  const {client}=await f.connect(),response=await client.callTool({name:'revit_health',arguments:{}},{timeout:7000});assert.equal(response.isError,false,JSON.stringify(response));assert.equal(f.requests.length,1);
  const command=await f.runCommandStore();assert.equal(command.read.code,'return 17;');assert.ok((await fs.stat(path.join(f.programRoot,'workbench','commands'))).isDirectory());assert.equal(await fs.readFile(history,'utf8'),'legacy history');assert.deepEqual(await fs.readdir(f.externalData),[]);
});

test('an invalid installed layout aborts the production MCP entry instead of publishing into program data',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t,{invalidConfiguration:true});
  const child=spawnSync(process.execPath,[path.join(f.programRoot,'workbench-mcp.mjs'),'--workspace'],{cwd:f.programRoot,input:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.notEqual(child.status,0);assert.match(child.stderr,/installation configuration is invalid/);assert.equal(child.stdout,'');assert.equal(f.requests.length,0);
  for(const root of [f.programRoot,f.externalData])await assert.rejects(fs.stat(path.join(root,'workbench')),error=>error.code==='ENOENT');
});
