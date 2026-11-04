import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {CUSTOMER_MODULES,stageCustomerChatSources,snapshotCustomerComponent} from './test-support/customer-chat-fixture.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),ownedChildren=new Map();
const selected=process.env.BUILDX_TEST_CUSTOMER_COMPONENT;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function run(t,scenario){
  assert.equal(ownedChildren.size,0,'Prior exact Node process cleanup must be confirmed before a new scenario');
  const parent=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(parent,'buildx-customer-cwd-')),original=await fs.realpath(base);
  const evidence=path.join(root,'workbench/validation/20261025-customer-layout',scenario+'-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));await fs.mkdir(evidence,{recursive:true});
  let componentRoot,productionInputs=[];
  if(selected!==undefined){assert.ok(selected);assert.equal(path.isAbsolute(selected),true);componentRoot=path.resolve(selected);}
  else{componentRoot=path.join(base,'component');productionInputs=await stageCustomerChatSources({sourceRoot:root,componentRoot});}
  const componentBefore=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-before.json'),JSON.stringify(componentBefore,null,2)+'\n');
  assert.equal(componentBefore.filter(item=>item.kind==='file').length,selected===undefined?19:24);
  const sentinel=path.join(base,'workspace/public/index.html'),fakePrompt=path.join(base,'workspace/prompts/buildx-customer-chat.zh-CN.md');
  for(const name of [sentinel,fakePrompt,path.join(base,'tools/codex.exe'),path.join(base,'tools/python.exe'),path.join(base,'codex-home/config.toml')])await fs.mkdir(path.dirname(name),{recursive:true});
  await fs.writeFile(sentinel,'workspace-wrong-resource-root\n');await fs.writeFile(fakePrompt,'workspace-fake-prompt\n');
  await fs.writeFile(path.join(base,'tools/codex.exe'),'Not an executable: spawn is intercepted by the isolated fixture\n');
  await fs.writeFile(path.join(base,'tools/python.exe'),'Not an executable: spawnSync is intercepted by the isolated fixture\n');
  await fs.writeFile(path.join(base,'codex-home/config.toml'),'# Fixture scope; no actual Codex configuration is read\n');
  const before={sentinel:sha(await fs.readFile(sentinel)),fakePrompt:sha(await fs.readFile(fakePrompt))};
  const environment={...process.env,CODEX_HOME:path.join(base,'codex-home'),BUILDX_CODEX_EXE:path.join(base,'tools/codex.exe'),BUILDX_PYTHON_EXE:path.join(base,'tools/python.exe')};
  for(const name of ['NODE_OPTIONS','BUILDX_MODE','BUILDX_SUPABASE_URL','BUILDX_SUPABASE_PUBLISHABLE_KEY'])delete environment[name];
  const argv=[path.join(root,'test-support/customer-chat-cwd-runner.mjs'),componentRoot,base,evidence,scenario,JSON.stringify(CUSTOMER_MODULES)],started=process.hrtime.bigint();
  const child=spawn(process.execPath,argv,{cwd:base,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const owner={pid:child.pid,closeObserved:false,exitCode:null,signal:null,stdout:'',stderr:'',spawnError:null,terminationRequested:false};ownedChildren.set(child,owner);
  await fs.writeFile(path.join(evidence,'child-start.json'),JSON.stringify({pid:child.pid,argv,cwd:base,ambientEnvironmentRecorded:false},null,2)+'\n');
  const stdoutChunks=[],stderrChunks=[];
  let stdoutBytes=0,stderrBytes=0,overflow=false,passed=false,removed=false,result=null,componentAfter=null;
  child.stdout.on('data',data=>{stdoutBytes+=data.length;if(stdoutBytes<=128*1024)stdoutChunks.push(Buffer.from(data));else overflow=true;});
  child.stderr.on('data',data=>{stderrBytes+=data.length;if(stderrBytes<=64*1024)stderrChunks.push(Buffer.from(data));else overflow=true;});
  child.on('error',error=>{owner.spawnError=error.code??error.name;});
  try{
    await new Promise(resolve=>child.once('close',(code,signal)=>{owner.closeObserved=true;owner.exitCode=code;owner.signal=signal;ownedChildren.delete(child);resolve();}));
    owner.elapsedMs=Number(process.hrtime.bigint()-started)/1e6;
    const rawStdout=Buffer.concat(stdoutChunks),rawStderr=Buffer.concat(stderrChunks);
    await fs.writeFile(path.join(evidence,'child-stdout.json'),rawStdout);await fs.writeFile(path.join(evidence,'child-stderr.txt'),rawStderr);
    owner.stdout=new TextDecoder('utf-8',{fatal:true}).decode(rawStdout);owner.stderr=new TextDecoder('utf-8',{fatal:true}).decode(rawStderr);
    assert.equal(overflow,false);assert.equal(owner.spawnError,null);assert.equal(owner.exitCode,0,owner.stderr);assert.equal(owner.signal,null);assert.equal(owner.closeObserved,true);
    result=JSON.parse(owner.stdout);assert.equal(result.ok,true);assert.equal(result.realNativeProcesses,0);assert.equal(result.externalNetworkCalls,0);
    assert.equal(sha(await fs.readFile(sentinel)),before.sentinel);assert.equal(sha(await fs.readFile(fakePrompt)),before.fakePrompt);
    componentAfter=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-after.json'),JSON.stringify(componentAfter,null,2)+'\n');assert.deepEqual(componentAfter,componentBefore);
    await assert.rejects(fs.stat(path.join(componentRoot,'runtime')),{code:'ENOENT'});passed=true;
  }finally{
    if(passed&&owner.closeObserved){assert.equal(path.dirname(path.resolve(base)),path.resolve(parent));assert.ok(path.basename(base).startsWith('buildx-customer-cwd-'));assert.equal(await fs.realpath(base),original);await fs.rm(base,{recursive:true});await assert.rejects(fs.stat(base),{code:'ENOENT'});removed=true;}
    await fs.writeFile(path.join(evidence,'summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),scenario,passed,child:owner,result,componentRoot,actualExistingComponent:selected!==undefined,productionInputs,componentFileCount:componentBefore.filter(item=>item.kind==='file').length,completeComponentTreeUnchanged:componentAfter?JSON.stringify(componentAfter)===JSON.stringify(componentBefore):null,tempRemoved:removed,tempRetained:removed?null:base,resourceAndFakePromptBytesUnchanged:passed,noEntryRuntimeCreated:passed,actualCodexAuthCloudRevitGUI:false,unmeasured:{processFamilyPeakMemory:null,tokens:null}},null,2)+'\n');
  }
}

test('default customer factory keeps Panel resources at resourceRoot and routes real Core fake-native spawn/thread cwd to the explicit workspace',{timeout:30000},t=>run(t,'routing'));
test('relative, drive-root-relative or empty CODEX_HOME is rejected by the default factory before configuration helper or native spawn',{timeout:30000},t=>run(t,'invalid-code-home'));
