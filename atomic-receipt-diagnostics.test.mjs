import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {invokeAtomicWorkbenchRead,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {loadNativeReadProducer,nativeProducerAvailable} from './test-support/native-read-producer.mjs';
import {capturedAtomicReadFixtures} from './test-support/captured-atomic-read-fixtures.mjs';

const ids=capturedAtomicReadFixtures.map(fixture=>fixture.sourceReceiptId);
const readFixture=async id=>structuredClone(capturedAtomicReadFixtures.find(fixture=>fixture.sourceReceiptId===id));
async function queuePeer(t,fixture,{mutate,producer}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-receipt-diagnostics-')),queue=path.join(root,'queue');
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const session=fixture.receipt.result.hostSession;
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.4',atomicReadSnapshot:true}));
  let stopped=false;const requests=[],errors=[];
  const loop=(async()=>{while(!stopped){
    for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const requestPath=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(requestPath,'utf8'));
      await fs.rename(requestPath,path.join(queue,'processing',name));requests.push(request);
      assert.equal(request.operation,fixture.request.operation);
      const receipt=structuredClone(fixture.receipt);
      // Only transport correlation changes within this sanitized captured shape.
      // The legacy producer's absent modification field stays absent.
      receipt.id=request.id;
      if(producer)receipt.result.value=await producer({operation:request.operation,session,document:receipt.result.snapshot.document,args:request.args,value:receipt.result.value.value});
      if(mutate)mutate(receipt);
      const temporary=path.join(queue,'outbox',name+'.tmp');
      await fs.writeFile(temporary,JSON.stringify(receipt));
      await fs.rename(temporary,path.join(queue,'outbox',name));
    }
    await new Promise(resolve=>setTimeout(resolve,4));
  }})().catch(error=>errors.push(error));
  t.after(async()=>{stopped=true;await loop;assert.deepEqual(errors,[]);const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('buildx-receipt-diagnostics-'));await fs.rm(resolved,{recursive:true,force:true});});
  return {root,requests,invoke:()=>invokeAtomicWorkbenchRead('revit_'+fixture.request.operation,fixture.request.args,{root,timeout:4000})};
}
const rejected=async(peer,pattern)=>{
  await assert.rejects(peer.invoke(),error=>{const evidence=workbenchFailureEvidence(error);assert.equal(evidence.outcome,'unconfirmed');assert.equal(evidence.requestIds.length,1);assert.match(error.message,pattern);return true;});
  assert.equal(peer.requests.length,1,'A rejected existing receipt must never replay');
};

test('three captured legacy successful receipt shapes diagnose the missing contract field without replay',async t=>{
  for(const id of ids)await t.test(id,async t=>{
    const fixture=await readFixture(id);
    assert.equal(fixture.receipt.ok,true);
    assert.equal(Object.hasOwn(fixture.receipt.result.value,'modifiedByOperation'),false);
    t.diagnostic(JSON.stringify({sourceReceipt:id,sourceReceiptSha256:fixture.receiptHash,operation:fixture.request.operation,projection:fixture.projection}));
    const peer=await queuePeer(t,fixture);
    await rejected(peer,/Atomic query receipt missing modifiedByOperation:false/);
  });
});

test('explicit changed, null and invalid modification facts remain unconfirmed',async t=>{
  const fixture=await readFixture(ids[0]);
  for(const [marker,label] of [[true,'true'],[null,'null'],['false','invalid']])await t.test(label,async t=>{
    const peer=await queuePeer(t,fixture,{mutate:receipt=>{receipt.result.value.modifiedByOperation=marker;}});
    await rejected(peer,new RegExp('Atomic query receipt modifiedByOperation:'+label+'; expected false'));
  });
});

test('inner query operation and document mismatches retain distinct rejection reasons',async t=>{
  const fixture=await readFixture(ids[0]);
  await t.test('operation mismatch',async t=>{
    const peer=await queuePeer(t,fixture,{mutate:receipt=>{receipt.result.value.modifiedByOperation=false;receipt.result.value.operation='get_selection';}});
    await rejected(peer,/Atomic query operation mismatch/);
  });
  await t.test('document mismatch',async t=>{
    const peer=await queuePeer(t,fixture,{mutate:receipt=>{receipt.result.value.modifiedByOperation=false;receipt.result.value.document.path='D:\\different.rvt';}});
    await rejected(peer,/Atomic query and document snapshot do not match/);
  });
});

test('the unchanged real native producer passes with false while the existing document is dirty',{skip:!nativeProducerAvailable},async t=>{
  const producer=await loadNativeReadProducer(t),fixture=await readFixture(ids[0]);
  assert.equal(fixture.receipt.result.snapshot.document.modified,true);
  const peer=await queuePeer(t,fixture,{producer});
  const result=await peer.invoke();
  assert.equal(result.modifiedByOperation,false);assert.equal(result.snapshot.document.modified,true);
  assert.equal(peer.requests.length,1);
  t.diagnostic(JSON.stringify(producer.sourceEvidence));
});
