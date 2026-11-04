import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {stageCustomerChatSources,snapshotCustomerComponent,CUSTOMER_COMPONENT_MODULE_PATHS} from './test-support/customer-chat-fixture.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),ownedChildren=new Map();
const identity=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const oldRecord='{"fixture":"old-data-run-record","pid":1}\n';

async function run(scenario){
  assert.equal(ownedChildren.size,0,'Unconfirmed previous exact child prevents another entry');
  const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-entry-layout-'));
  const originalIdentity=identity(await fs.lstat(base,{bigint:true})),component=path.join(base,'component'),dataRoot=path.join(base,'data'),workspace=path.join(dataRoot,'workspace');
  const selected=process.env.BUILDX_TEST_CUSTOMER_COMPONENT;if(selected!==undefined){assert.ok(selected);assert.equal(path.isAbsolute(selected),true);}
  const evidenceBase=process.env.BUILDX_ENTRY_LAYOUT_EVIDENCE??path.join(root,'workbench/validation/20261025-customer-data-root/cases');
  const evidence=path.join(evidenceBase,scenario+'-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));await fs.mkdir(evidence,{recursive:true});
  const productionInputs=await stageCustomerChatSources({sourceRoot:selected??root,componentRoot:component,entry:true});
  await fs.mkdir(dataRoot);
  if(scenario!=='missing-workspace')await fs.mkdir(workspace);
  if(scenario==='overlap')await fs.mkdir(path.join(component,'workspace'));
  let alias=null;
  if(scenario==='junction'){alias=path.join(base,'data-alias');await fs.symlink(dataRoot,alias,'junction');}
  const recordPath=path.join(dataRoot,'runtime/customer-chat/server.json');let recordIdentity=null;
  if(['happy','snapshot-swap'].includes(scenario)){
    await fs.mkdir(path.dirname(recordPath),{recursive:true});await fs.writeFile(recordPath,oldRecord,{flag:'wx'});recordIdentity=identity(await fs.lstat(recordPath,{bigint:true}));
    if(scenario==='happy')for(const rel of ['public/index.html','prompts/buildx-customer-chat.zh-CN.md']){const p=path.join(workspace,rel);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,'wrong workspace resource fixture\n');}
  }
  for(const p of [path.join(base,'tools/codex.exe'),path.join(base,'tools/python.exe'),path.join(base,'codex-home/config.toml')]){await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,'Fixture only; not executable or actual login configuration\n');}
  const componentBefore=await snapshotCustomerComponent(component);
  const env={...process.env,BUILDX_MODE:'customer',BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_abcdefghijklmnopqrst',BUILDX_DATA_ROOT:scenario==='overlap'?component:scenario==='junction'?alias:dataRoot,CODEX_HOME:scenario==='invalid-home'?'relative-code-home':path.join(base,'codex-home'),BUILDX_CODEX_EXE:path.join(base,'tools/codex.exe'),BUILDX_PYTHON_EXE:path.join(base,'tools/python.exe')};
  delete env.NODE_OPTIONS;if(scenario==='missing-data-root')delete env.BUILDX_DATA_ROOT;
  const argv=[path.join(root,'test-support/customer-entry-layout-runner.mjs'),component,base,evidence,scenario,JSON.stringify(CUSTOMER_COMPONENT_MODULE_PATHS)];
  const child=spawn(process.execPath,argv,{cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const owner={pid:child.pid??null,closeObserved:false,exitCode:null,signal:null,terminationRequested:false,spawnError:null};ownedChildren.set(child,owner);
  const stdout=[],stderr=[];let outBytes=0,errBytes=0,problem=null,settle,passed=false,removed=false,result=null;
  const close=new Promise(resolve=>{settle=resolve;});
  const stop=code=>{problem??=code;if(!owner.closeObserved){owner.terminationRequested=true;try{child.kill();}catch{problem??='TERMINATION_FAILED';}}};
  child.on('error',error=>{owner.spawnError=error.code??error.name;problem??='SPAWN_FAILED';});
  child.stdout.on('data',bytes=>{outBytes+=bytes.length;if(outBytes<=128*1024)stdout.push(Buffer.from(bytes));else stop('STDOUT_LIMIT');});
  child.stderr.on('data',bytes=>{errBytes+=bytes.length;if(errBytes<=32*1024)stderr.push(Buffer.from(bytes));else stop('STDERR_LIMIT');});
  child.once('close',(code,signal)=>{owner.closeObserved=true;owner.exitCode=code;owner.signal=signal;ownedChildren.delete(child);settle();});
  let timeout;
  try{
    await Promise.race([close,new Promise(resolve=>{timeout=setTimeout(()=>{stop('DEADLINE');resolve();},20000);})]);clearTimeout(timeout);
    if(!owner.closeObserved){let cleanup;try{await Promise.race([close,new Promise(resolve=>{cleanup=setTimeout(resolve,3000);})]);}finally{clearTimeout(cleanup);}}
    await fs.writeFile(path.join(evidence,'child-stdout.json'),Buffer.concat(stdout));await fs.writeFile(path.join(evidence,'child-stderr.txt'),Buffer.concat(stderr));
    assert.equal(owner.closeObserved,true);assert.equal(owner.signal,null);assert.equal(owner.terminationRequested,false);assert.equal(owner.spawnError,null);assert.equal(problem,null);
    result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)).trim());
    assert.equal(result.passed,true,result.problem?.message);assert.equal(result.exactModuleGraph,true);assert.equal(result.productionModules.length,14);assert.equal(result.entryImported,true);assert.equal(result.foreignNetworkCalls,0);
    assert.equal(owner.exitCode,scenario==='happy'?0:1);assert.equal(result.openedAuditFiles,result.confirmedAuditCloses);
    assert.deepEqual(await snapshotCustomerComponent(component),componentBefore);
    for(const input of productionInputs)assert.equal(digest(await fs.readFile(path.join(component,...input.path.split('/')))),input.sha256);
    if(scenario==='happy'){
      assert.equal(Buffer.concat(stderr).length,0);assert.equal(result.resourcesFromComponent,true);assert.equal(result.sseCompleted,true);assert.equal(result.sseEnded,true);assert.equal(result.canonicalMessages,2);assert.equal(result.closeObserved,true);assert.equal(result.nativeCloseEvents,1);assert.equal(result.nativeKillCalls,0);assert.equal(result.explicitConfirmation,true);
      assert.equal(await fs.readFile(recordPath,'utf8'),oldRecord);assert.equal(identity(await fs.lstat(recordPath,{bigint:true})),recordIdentity);
      assert.equal(result.runDirectories.length,1);assert.equal(result.threadCwd,workspace);
    }else{
      const lines=Buffer.concat(stderr).toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(lines,[{service:'buildx-customer-chat',error_code:'customer_startup_failed'}]);
      assert.equal(result.listenCalls,0);assert.equal(result.openedAuditFiles,0);assert.equal(result.nativeLaunches.length,0);assert.equal(result.authPaths.length,0);assert.equal(result.runDirectories.length,0);
      if(scenario==='snapshot-swap'){
        assert.equal(result.snapshotSwapApplied,true);assert.equal(result.dataRuntimeCreated,false);
        const displaced=path.join(base,'displaced-data/runtime/customer-chat/server.json');
        assert.equal(await fs.readFile(displaced,'utf8'),oldRecord);assert.equal(identity(await fs.lstat(displaced,{bigint:true})),recordIdentity);
      }
    }
    passed=true;
  }finally{
    clearTimeout(timeout);
    if(passed&&owner.closeObserved){
      assert.equal(path.dirname(path.resolve(base)),path.resolve(parent));assert.ok(path.basename(base).startsWith('buildx-entry-layout-'));assert.equal(await fs.realpath(base),base);assert.equal(identity(await fs.lstat(base,{bigint:true})),originalIdentity);
      if(alias){assert.equal((await fs.lstat(alias)).isSymbolicLink(),true);assert.equal(await fs.realpath(alias),dataRoot);await fs.unlink(alias);}
      await fs.rm(base,{recursive:true});await assert.rejects(fs.lstat(base),{code:'ENOENT'});removed=true;
    }
    await fs.writeFile(path.join(evidence,'scenario-summary.json'),JSON.stringify({scenario,passed,sourceRoot:selected??root,productionInputs,componentRoot:component,dataRoot,child:owner,problem,result,tempRemoved:removed,tempRetained:removed?null:base,actualCodexCloudRevitGUI:false,permanentServiceControl:false,realListener:scenario==='happy'?'owned_random_loopback_only':'none'},null,2)+'\n');
  }
}

test('actual configured customer entry separates release resources, data logs and default Codex workspace through confirmed HTTP/SSE dialogue',{timeout:30000},()=>run('happy'));
test('configured entry refuses invalid external data directories before mkdir, listener, native or Auth requests',{timeout:120000},async()=>{
  for(const scenario of ['missing-data-root','overlap','missing-workspace','junction','invalid-home'])await run(scenario);
});
test('entry binds the observed data-root snapshot before the writer can adopt an ordinary replacement',{timeout:25000},()=>run('snapshot-swap'));
