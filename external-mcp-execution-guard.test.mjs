import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectExistingPanelDirectory} from './lib/panel-audit.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport,DEFAULT_INHERITED_ENV_VARS} from '@modelcontextprotocol/client/stdio';

// Isolated Win32 prototype tests only. The target is a newly compiled fixture;
// no installed plugin, user service, credentials or external network is used.
const root=path.dirname(fileURLToPath(import.meta.url));
const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT;
const id=s=>`${s.dev}:${s.ino}:${s.birthtimeNs}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-mcp-guard-fixture-'));
  const guard=path.join(dir,'guard.exe'),target=path.join(dir,'fixture.exe');
  for(const [source,out] of [['external-mcp-execution-guard.cs',guard],['external-mcp-execution-guard-fixture.cs',target]])
    execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/langversion:5',`/out:${out}`,'/reference:C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Web.Extensions.dll',path.join(root,'lib',source)],{windowsHide:true,timeout:30000,stdio:'pipe'});
  return {dir,guard,target};
}
async function request(f,args=[]){
  const stat=await fs.lstat(f.target,{bigint:true}),exe=inspectExistingPanelDirectory(path.dirname(f.target)),cwd=inspectExistingPanelDirectory(f.dir);
  assert.equal(exe.ok,true);assert.equal(cwd.ok,true);
  return {command:f.target,cwd:f.dir,args,executableIdentity:id(stat),executableSha256:hash(await fs.readFile(f.target)),executableChain:exe.value.chain,cwdChain:cwd.value.chain};
}
function launch(f,value){
  const env={SystemRoot:systemRoot,WINDIR:systemRoot,BUILDX_MCP_GUARD_BOOTSTRAP:JSON.stringify(value)};
  const child=spawn(f.guard,[],{cwd:f.dir,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',stdout='';const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stderr,stdout})));
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  return {child,done,read:()=>({stderr,stdout})};
}
async function waitFor(fn,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const value=fn();if(value)return value;await delay(40);}throw new Error('fixture timeout');}
async function ready(instance){
  return await waitFor(()=>{const {stderr,stdout}=instance.read();if(stderr.includes('BUILDX_GUARD_FAILED'))throw new Error(stderr.trim());if(!stderr.includes('BUILDX_GUARD_STARTED')||!stdout.includes('\n'))return null;return JSON.parse(stdout.split('\n')[0]);});
}

test('guard launches the exact verified child, preserves arguments, and holds file and directory identities', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const f=await fixture(),args=['white space','quoted"value','slash\\','中文',''];const instance=launch(f,await request(f,args));
  try{
    const value=await ready(instance);assert.deepEqual(value.args,args);assert.equal(value.cwd.toLowerCase(),f.dir.toLowerCase());assert.equal(value.bootstrap,null);
    assert.equal(instance.read().stderr.trim(),'BUILDX_GUARD_STARTED');
    await assert.rejects(fs.open(f.target,'r+'));
    const moved=f.target+'.moved';let renamed=false;try{await fs.rename(f.target,moved);renamed=true;}catch{}
    if(renamed){await fs.rename(moved,f.target);assert.fail('guard did not retain executable path');}
    const movedDir=f.dir+'-moved';let movedDirectory=false;try{await fs.rename(f.dir,movedDir);movedDirectory=true;}catch{}
    if(movedDirectory){await fs.rename(movedDir,f.dir);assert.fail('guard did not retain parent directory');}
    instance.child.stdin.end('quit\n');const result=await instance.done;assert.equal(result.code,0);assert.match(result.stderr,/BUILDX_GUARD_CLOSED/);
    const handle=await fs.open(f.target,'r+');await handle.close();
  }finally{if(instance.child.exitCode===null)instance.child.kill();await instance.done;}
});

test('changed executable identity or digest fails before target starts', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const f=await fixture(),original=await request(f);original.executableSha256='0'.repeat(64);
  const instance=launch(f,original);instance.child.stdin.end();const result=await instance.done;
  assert.notEqual(result.code,0);assert.equal(result.stdout,'');assert.match(result.stderr,/^BUILDX_GUARD_FAILED executable /);
});

test('two guards jointly retain the executable against repeated competing writes and renames', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const f=await fixture(),value=await request(f),first=launch(f,value),second=launch(f,value);
  try{
    await Promise.all([ready(first),ready(second)]);
    for(let i=0;i<25;i++){
      await assert.rejects(fs.open(f.target,'r+'));
      await assert.rejects(fs.rename(f.target,`${f.target}.race`));
    }
    first.child.stdin.end('quit\n');assert.match((await first.done).stderr,/BUILDX_GUARD_CLOSED/);
    await assert.rejects(fs.open(f.target,'r+'));
    await assert.rejects(fs.rename(f.target,`${f.target}.race`));
    second.child.stdin.end('quit\n');assert.match((await second.done).stderr,/BUILDX_GUARD_CLOSED/);
    const handle=await fs.open(f.target,'r+');await handle.close();
  }finally{for(const instance of [first,second]){if(instance.child.exitCode===null)instance.child.kill();await instance.done;}}
});

test('killing guard closes its own job and terminates child and descendant', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const f=await fixture(),instance=launch(f,await request(f,['--with-grandchild']));let value;
  try{
    value=await ready(instance);assert.ok(value.pid>0&&value.descendant>0);assert.ok(exists(value.pid)&&exists(value.descendant));
    instance.child.kill('SIGKILL');const result=await instance.done;assert.doesNotMatch(result.stderr,/BUILDX_GUARD_CLOSED/);
    await waitFor(()=>!exists(value.pid)&&!exists(value.descendant));
  }finally{if(instance.child.exitCode===null)instance.child.kill();await instance.done;}
});

test('public MCP stdio transport supports handshake, backpressure, cancellation and verified cleanup for isolated fixture', {skip:process.platform!=='win32',timeout:60000},async()=>{
  const f=await fixture(),marker=path.join(f.dir,'receipt.jsonl');
  f.target=process.execPath;
  const bootstrap=await request(f,[path.join(root,'lib','external-mcp-execution-guard-mcp-fixture.mjs'),marker]);
  const env=Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key=>[key,undefined]));
  Object.assign(env,{SYSTEMROOT:systemRoot,WINDIR:systemRoot,BUILDX_MCP_GUARD_BOOTSTRAP:JSON.stringify(bootstrap)});
  const transport=new StdioClientTransport({command:f.guard,args:[],cwd:f.dir,env,stderr:'pipe',maxBufferSize:512*1024});
  let diagnostic='';transport.stderr.on('data',chunk=>{diagnostic+=chunk.toString();});
  const client=new Client({name:'guard-test-client',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
  let pid;
  try{
    await client.connect(transport,{timeout:10000});
    const {tools}=await client.listTools(undefined,{timeout:10000});
    assert.deepEqual(tools.map(item=>item.name).sort(),['inspect','large','record']);
    const call=(name,args,options={})=>client.callTool({name,arguments:args},{timeout:10000,toolDefinition:tools.find(item=>item.name===name),...options});
    const inspected=await call('inspect',{});const info=JSON.parse(inspected.content[0].text);pid=info.pid;assert.equal(info.bootstrap,false);
    const data='汉'.repeat(45000);assert.equal((await call('large',{value:data})).content[0].text,data);
    const controller=new AbortController(),pending=call('record',{value:'once'},{signal:controller.signal});
    await waitFor(()=>existsSync(marker));
    controller.abort();await assert.rejects(pending);
    await delay(1500);assert.deepEqual((await fs.readFile(marker,'utf8')).trim().split('\n').map(JSON.parse),[{value:'once'}]);
    let observeClose;const closed=new Promise(resolve=>{observeClose=resolve;});
    const previous=transport.onclose;transport.onclose=()=>{previous?.();observeClose();};
    await client.close();await closed;
    await waitFor(()=>diagnostic.includes('BUILDX_GUARD_CLOSED'));
    await waitFor(()=>!exists(pid));
  }catch(error){throw new Error(`fixture transport failed; guard diagnostic: ${diagnostic.trim()}`,{cause:error});}
  finally{await transport.close();}
});

test('SDK helper termination cannot be reported as confirmed cleanup from onclose alone', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const f=await fixture(),marker=path.join(f.dir,'receipt.jsonl');f.target=process.execPath;
  const bootstrap=await request(f,[path.join(root,'lib','external-mcp-execution-guard-mcp-fixture.mjs'),marker]);
  const env=Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key=>[key,undefined]));
  Object.assign(env,{SYSTEMROOT:systemRoot,WINDIR:systemRoot,BUILDX_MCP_GUARD_BOOTSTRAP:JSON.stringify(bootstrap)});
  const transport=new StdioClientTransport({command:f.guard,args:[],cwd:f.dir,env,stderr:'pipe',maxBufferSize:512*1024});
  let diagnostic='';transport.stderr.on('data',chunk=>{diagnostic+=chunk.toString();});
  const client=new Client({name:'guard-test-client',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
  try{
    await client.connect(transport,{timeout:10000});const {tools}=await client.listTools();
    const response=await client.callTool({name:'inspect',arguments:{}},{toolDefinition:tools.find(item=>item.name==='inspect')});
    const pid=JSON.parse(response.content[0].text).pid;assert.ok(exists(pid));
    let observeClose;const closed=new Promise(resolve=>{observeClose=resolve;});
    const previous=transport.onclose;transport.onclose=()=>{previous?.();observeClose();};
    process.kill(transport.pid,'SIGKILL');await closed;
    assert.doesNotMatch(diagnostic,/BUILDX_GUARD_CLOSED/);
    await waitFor(()=>!exists(pid));
  }finally{await transport.close();}
});
