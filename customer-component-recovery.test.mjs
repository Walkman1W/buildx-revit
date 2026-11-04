import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {runCustomerChatFixture,snapshotCustomerComponent} from './test-support/customer-chat-fixture.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),configured=process.env.BUILDX_TEST_CUSTOMER_COMPONENT;

test('actual customer component exposes a cookie-scoped interruption notice through reconnect, acknowledgement and account change without replay',{timeout:30000,skip:configured===undefined?'Select an existing component with BUILDX_TEST_CUSTOMER_COMPONENT':false},async()=>{
  assert.equal(typeof configured,'string');assert.ok(configured);assert.equal(path.isAbsolute(configured),true);const componentRoot=path.resolve(configured);
  const evidence=path.join(root,'workbench','validation','20261025-customer-interruption','notice-'+new Date().toISOString().replace(/[:.]/g,'')+'-'+randomUUID().slice(0,8));await fs.mkdir(evidence,{recursive:true});
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-customer-recovery-')),real=await fs.realpath(temporary);let before=null,after=null,execution=null,passed=false,removed=false,snapshotError=null;
  try{
    before=await snapshotCustomerComponent(componentRoot);assert.equal(before.filter(item=>item.kind==='file').length,24);await fs.writeFile(path.join(evidence,'component-before.json'),JSON.stringify(before,null,2)+'\n');
    execution=await runCustomerChatFixture({componentRoot,harnessRoot:path.join(temporary,'harness'),evidenceRoot:path.join(evidence,'fixture'),scenario:'recovery'});
    after=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-after.json'),JSON.stringify(after,null,2)+'\n');assert.deepEqual(after,before);assert.equal(execution.record.closeObserved,true);passed=true;
  }finally{
    if(before&&after===null)try{after=await snapshotCustomerComponent(componentRoot);await fs.writeFile(path.join(evidence,'component-after.json'),JSON.stringify(after,null,2)+'\n');}catch(error){snapshotError=error.code??error.name;}
    if(passed&&execution?.record.closeObserved){assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('buildx-customer-recovery-'));assert.equal(await fs.realpath(temporary),real);await fs.rm(temporary,{recursive:true});await assert.rejects(fs.stat(temporary),{code:'ENOENT'});removed=true;}
    await fs.writeFile(path.join(evidence,'recovery-summary.json'),JSON.stringify({recordedAt:new Date().toISOString(),passed,componentRoot,execution,componentFileCount:before?.filter(item=>item.kind==='file').length??null,completeTreeUnchanged:before&&after?JSON.stringify(before)===JSON.stringify(after):null,snapshotError,tempRemoved:removed,tempRetained:removed?null:temporary,realCodexCloudModelRevitUI:false,measurement:{tokens:null,cpu:null,peakProcessFamilyMemory:null}},null,2)+'\n');
  }
});
