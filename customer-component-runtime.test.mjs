import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {stageCustomerChatSources,runCustomerChatFixture,snapshotCustomerComponent} from './test-support/customer-chat-fixture.mjs';
import {CUSTOMER_CHAT_COMPONENT_DEFINITION as definition} from './lib/customer-component-definitions.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('built customer component alone runs the shared chat/entry workflows while its complete declared tree remains byte-identical',{timeout:45000},async()=>{
  const evidence=path.join(root,'workbench','validation','20261025-customer-component','runtime-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));await fs.mkdir(evidence,{recursive:true});
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-customer-component-')),real=await fs.realpath(temporary),configured=process.env.BUILDX_TEST_CUSTOMER_COMPONENT;
  let componentRoot=null,build=null,before=null,after=null,passed=false,removed=false,snapshotError=null;const runs=[],sourceInputs=[];
  try{
    if(configured!==undefined){assert.equal(typeof configured,'string');assert.ok(configured);assert.equal(path.isAbsolute(configured),true);componentRoot=path.resolve(configured);}
    else{
      const {buildCustomerChatPackage}=await import('./lib/customer-chat-package.mjs');
      const sourceRoot=path.join(temporary,'source');sourceInputs.push(...await stageCustomerChatSources({sourceRoot:root,componentRoot:sourceRoot,entry:true}));
      for(const name of ['customer-chat.README.zh-CN.md','release/customer-chat-component.json']){const bytes=await fs.readFile(path.join(root,...name.split('/')));await fs.mkdir(path.dirname(path.join(sourceRoot,...name.split('/'))),{recursive:true});await fs.writeFile(path.join(sourceRoot,...name.split('/')),bytes,{flag:'wx'});sourceInputs.push({path:name,sha256:hash(bytes),byteLength:bytes.byteLength});}
      componentRoot=path.join(sourceRoot,'artifacts','customer-chat','runtime-fixture');build=await buildCustomerChatPackage({root:sourceRoot,output:componentRoot});assert.equal(build.ok,true,build.error?.message);
    }
    before=await snapshotCustomerComponent(componentRoot);assert.equal(before.filter(item=>item.kind==='file').length,definition.exactPaths.length+Object.keys(definition.generatedFiles).length+1);
    for(const name of ['package.json','BUILD-MANIFEST.json','customer-chat.README.zh-CN.md'])assert.ok(before.some(item=>item.kind==='file'&&item.path===name));
    assert.equal(before.some(item=>item.path==='runtime'||item.path.startsWith('runtime/')),false);
    await fs.writeFile(path.join(evidence,'component-before.json'),JSON.stringify(before,null,2)+'\n');
    for(const [label,entry] of [['workflow',false],['missing-config',true]])runs.push(await runCustomerChatFixture({componentRoot,harnessRoot:path.join(temporary,label+'-harness'),evidenceRoot:path.join(evidence,label),entry}));
    after=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-after.json'),JSON.stringify(after,null,2)+'\n');assert.deepEqual(after,before);assert.ok(runs.every(run=>run.record.closeObserved));passed=true;
  }finally{
    if(before&&after===null){try{after=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-after.json'),JSON.stringify(after,null,2)+'\n');}catch(error){snapshotError=error.code??error.name;}}
    if(passed&&runs.length===2&&runs.every(run=>run.record.closeObserved)){
      assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('buildx-customer-component-'));assert.equal(await fs.realpath(temporary),real);
      await fs.rm(temporary,{recursive:true});await assert.rejects(fs.stat(temporary),{code:'ENOENT'});removed=true;
    }
    await fs.writeFile(path.join(evidence,'runtime-summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),passed,externalComponent:configured!==undefined,componentRoot,build,sourceInputs,runs,componentFileCount:before?.filter(item=>item.kind==='file').length??null,completeTreeUnchanged:before&&after?JSON.stringify(before)===JSON.stringify(after):null,snapshotError,tempRemoved:removed,tempRetained:removed?null:temporary,actualCodexOrCloudOrRevitOrUI:false,measurement:{tokens:null,cpu:null,peakProcessFamilyMemory:null}},null,2)+'\n');
  }
});
