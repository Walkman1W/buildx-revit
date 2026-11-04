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
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const sameParent=(base,parent)=>path.dirname(path.resolve(base))===path.resolve(parent);
const serverSentinel='{"fixture":"preserve-old-record","pid":1}\n';

async function scenario(name){
  assert.equal(ownedChildren.size,0,'Unconfirmed prior child prevents another scenario');
  const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-entry-admission-'));
  const baseIdentity=identity(await fs.lstat(base,{bigint:true})),component=path.join(base,'component');
  const selected=process.env.BUILDX_TEST_CUSTOMER_COMPONENT;
  if(selected!==undefined){assert.ok(selected);assert.equal(path.isAbsolute(selected),true);}
  const evidenceBase=process.env.BUILDX_ENTRY_ADMISSION_EVIDENCE??path.join(root,'workbench','validation','20261025-customer-entry-admission');
  const evidence=path.join(evidenceBase,name+'-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));
  await fs.mkdir(evidence,{recursive:true});
  const productionInputs=await stageCustomerChatSources({sourceRoot:selected??root,componentRoot:component,entry:true});
  const componentBefore=await snapshotCustomerComponent(component);
  const dataRoot=path.join(base,'data'),workspace=path.join(dataRoot,'workspace');
  await fs.mkdir(workspace,{recursive:true});
  const sentinelPath=path.join(dataRoot,'runtime','customer-chat','server.json');
  let sentinelIdentity=null;
  if(name==='listen-failure'){
    await fs.mkdir(path.dirname(sentinelPath),{recursive:true});
    await fs.writeFile(sentinelPath,serverSentinel,{flag:'wx'});
    sentinelIdentity=identity(await fs.lstat(sentinelPath,{bigint:true}));
  }
  const env={...process.env,BUILDX_MODE:'customer',BUILDX_DATA_ROOT:dataRoot,BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_abcdefghijklmnopqrst',CODEX_HOME:name==='invalid-home'?'relative-code-home':path.join(base,'codex-home')};
  delete env.NODE_OPTIONS;
  const argv=[path.join(root,'test-support/customer-entry-admission-runner.mjs'),component,evidence,name,JSON.stringify(CUSTOMER_COMPONENT_MODULE_PATHS)];
  const child=spawn(process.execPath,argv,{cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const record={pid:child.pid??null,closeObserved:false,exitCode:null,signal:null,terminationRequested:false,spawnError:null};ownedChildren.set(child,record);
  const stdout=[],stderr=[];let stdoutBytes=0,stderrBytes=0,problem=null,settle,passed=false,removed=false,result=null;
  const close=new Promise(resolve=>{settle=resolve;});
  const stop=code=>{problem??=code;if(!record.closeObserved){record.terminationRequested=true;try{child.kill();}catch{problem??='OWNED_TERMINATION_FAILED';}}};
  child.on('error',error=>{record.spawnError=error.code??error.name;problem??='SPAWN_FAILED';});
  child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;if(stdoutBytes<=128*1024)stdout.push(Buffer.from(bytes));else stop('STDOUT_LIMIT');});
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes<=32*1024)stderr.push(Buffer.from(bytes));else stop('STDERR_LIMIT');});
  child.once('close',(code,signal)=>{record.closeObserved=true;record.exitCode=code;record.signal=signal;ownedChildren.delete(child);settle();});
  let timer;
  try{
    await Promise.race([close,new Promise(resolve=>{timer=setTimeout(()=>{stop('DEADLINE');resolve();},15000);})]);clearTimeout(timer);
    if(!record.closeObserved){let cleanup;try{await Promise.race([close,new Promise(resolve=>{cleanup=setTimeout(resolve,3000);})]);}finally{clearTimeout(cleanup);}}
    await fs.writeFile(path.join(evidence,'child-stdout.json'),Buffer.concat(stdout));await fs.writeFile(path.join(evidence,'child-stderr.txt'),Buffer.concat(stderr));
    assert.equal(record.closeObserved,true);assert.equal(record.exitCode,1);assert.equal(record.signal,null);assert.equal(record.spawnError,null);assert.equal(record.terminationRequested,false);assert.equal(problem,null);
    result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)).trim());
    assert.equal(result.entryImported,true);assert.equal(result.entryExitCode,1);assert.equal(result.exactModuleGraph,true);assert.equal(result.productionModules.length,14);
    assert.equal(result.nativeSpawnCalls,0);assert.equal(result.networkCalls,0);assert.equal(result.openedAuditFiles,result.confirmedAuditCloses);
    const errors=Buffer.concat(stderr).toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(errors,[{service:'buildx-customer-chat',error_code:'customer_startup_failed'}]);
    for(const input of productionInputs)assert.equal(digest(await fs.readFile(path.join(component,...input.path.split('/')))),input.sha256);
    if(name==='invalid-home'){
      assert.equal(result.listenCalls,0);assert.equal(result.runtimeCreated,false,'Rejected factory configuration must not create runtime or failure logs');
      assert.equal(result.componentRuntimeCreated,false);
      assert.equal(result.openedAuditFiles,0);assert.deepEqual(result.lifecycleCodes,[]);
      await assert.rejects(fs.lstat(path.join(component,'runtime')),{code:'ENOENT'});
      assert.deepEqual(await snapshotCustomerComponent(component),componentBefore);
    }else{
      assert.equal(result.listenCalls,1);assert.equal(result.runtimeCreated,true);assert.deepEqual(result.lifecycleCodes,['service_start_failed']);
      assert.equal(result.componentRuntimeCreated,false);assert.equal(result.runDirectories.length,1);
      assert.equal(result.openedAuditFiles,1);assert.equal(result.oldServerRecord,serverSentinel);
      assert.equal(identity(await fs.lstat(sentinelPath,{bigint:true})),sentinelIdentity);assert.equal(await fs.readFile(sentinelPath,'utf8'),serverSentinel);
      assert.deepEqual(await snapshotCustomerComponent(component),componentBefore);
    }
    passed=true;
  }finally{
    clearTimeout(timer);
    if(passed&&record.closeObserved){
      assert.equal(sameParent(base,parent),true);assert.ok(path.basename(base).startsWith('buildx-entry-admission-'));
      assert.equal(await fs.realpath(base),base);assert.equal(identity(await fs.lstat(base,{bigint:true})),baseIdentity);
      await fs.rm(base,{recursive:true});await assert.rejects(fs.lstat(base),{code:'ENOENT'});removed=true;
    }
    await fs.writeFile(path.join(evidence,'scenario-summary.json'),JSON.stringify({scenario:name,passed,componentRoot:component,sourceRoot:selected??root,sourceInputCount:productionInputs.length,productionInputs,child:record,problem,result,tempRemoved:removed,tempRetained:removed?null:base,actualCodexCloudRevitGUI:false,realListenerBound:false},null,2)+'\n');
  }
}

test('configured customer entry rejects invalid CODEX_HOME without creating runtime or audit files',{timeout:25000},()=>scenario('invalid-home'));
test('admitted customer entry preserves its old record and closes the same audit after an injected listen failure',{timeout:25000},()=>scenario('listen-failure'));
