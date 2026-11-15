import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {stageCustomerChatSources,runCustomerChatFixture,snapshotCustomerComponent} from '../test-support/customer-chat-fixture.mjs';

const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
async function isolation(label,{entry=false}={}){
  const evidence=path.join(root,'workbench','validation','20261025-customer-chat',label+'-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));await fs.mkdir(evidence,{recursive:true});
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-customer-chat-')),real=await fs.realpath(temporary),componentRoot=path.join(temporary,'component');let execution=null,passed=false,removed=false,productionInputs=[];
  try{
    productionInputs=await stageCustomerChatSources({sourceRoot:root,componentRoot,entry});
    const before=await snapshotCustomerComponent(componentRoot);
    execution=await runCustomerChatFixture({componentRoot,harnessRoot:path.join(temporary,'harness'),evidenceRoot:evidence,entry});
    const after=await snapshotCustomerComponent(componentRoot);assert.deepEqual(after,before);passed=true;
  }finally{
    if(passed&&execution?.record.closeObserved){
      assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('buildx-customer-chat-'));assert.equal(await fs.realpath(temporary),real);
      await fs.rm(temporary,{recursive:true});await assert.rejects(fs.stat(temporary),{code:'ENOENT'});removed=true;
    }
    await fs.writeFile(path.join(evidence,'isolation-summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),label,passed,productionInputs,child:execution?.record??null,tempRemoved:removed,tempRetained:removed?null:temporary,actualCodexOrCloudOrRevitOrUI:false,componentUnchanged:passed,measurement:{tokens:null,cpu:null,peakProcessFamilyMemory:null}},null,2)+'\n');
  }
}

test('declared isolated customer modules complete authenticated and explicitly confirmed HTTP/SSE chat with fake native JSON RPC',{timeout:25000},()=>isolation('isolation-workflow'));
test('declared isolated customer-entry modules fail missing configuration before runtime creation or real process spawn',{timeout:25000},()=>isolation('isolation-missing-config',{entry:true}));
