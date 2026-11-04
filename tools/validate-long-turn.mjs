// Isolated, wall-clock acceptance: production HTTP/SSE and panel lifecycle,
// synthetic Codex/one synthetic MCP tool, no real Revit or provider inference.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const evidenceDir = path.resolve('D:/code/REA/outputs/buildx-long-turn-20261029');
const client = 'long-turn-test-client';
let fixture;
try {
  fixture = await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,autoReply:false});
  const address = new URL(fixture.origin);
  assert.equal(address.hostname,'127.0.0.1');
  assert.notEqual(address.port,'41873');
  const started = await fixture.post('turn',{client,message:'隔离长回合验证'});
  assert.equal(started.status,202);
  assert.equal(fixture.codex.turns.length,1);
  const turn = fixture.codex.turns[0];
  fixture.codex.notify('item/started',turn,{item:{id:'synthetic-tool',type:'mcpToolCall',tool:'revit_workbench_status',status:'inProgress'}});
  const startedTick=performance.now(), observedUtc=new Date().toISOString();
  // Timer begins after turn/start has been acknowledged. This covers the
  // panel's former 180-second deadline with real elapsed time, not fake timers.
  while(performance.now()-startedTick<183000){
    await new Promise(resolve=>setTimeout(resolve,Math.min(45000,183000-(performance.now()-startedTick))));
    const interim=fixture.app.snapshot(client);
    assert.equal(interim.busy,true,'the synthetic turn stopped before its terminal event');
    assert.equal(fixture.codex.interrupts.length,0,'panel sent an automatic interrupt');
  }
  const observedMs=performance.now()-startedTick;
  fixture.codex.notify('item/completed',turn,{item:{id:'synthetic-tool',type:'mcpToolCall',tool:'revit_workbench_status',status:'completed',result:{content:[{type:'text',text:'synthetic receipt'}]}}});
  fixture.codex.finish(turn,'completed','隔离长回合完成');
  const final=fixture.app.snapshot(client);
  assert.equal(final.busy,false);
  assert.equal(final.session.messages[1]?.status,'completed');
  assert.equal(final.session.messages[1]?.tools[0]?.status,'returned');
  assert.equal(fixture.codex.interrupts.length,0);
  assert.equal(fixture.codex.turns.length,1);
  assert.equal(fixture.workbenchCalls.length,0);
  assert.equal(fixture.authCalls.length,0);
  const evidence={ok:true,observedUtc,observedMs:Math.round(observedMs),terminal:'completed',automaticInterrupts:0,turns:1,toolStatus:'returned',scope:'isolated production HTTP/panel lifecycle with synthetic Codex and synthetic tool; no real Revit, account, or model inference',productionPortUsed:false};
  await mkdir(evidenceDir,{recursive:true});
  const evidencePath=path.join(evidenceDir,'result-'+randomUUID()+'.json');
  await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({...evidence,evidencePath}));
} finally {
  if(fixture)await fixture.close();
}
