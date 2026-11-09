import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {createManagedInferenceTurns} from './lib/managed-inference-turns.mjs';
import {createManagedInferenceGrants} from './lib/managed-inference-grants.mjs';
import {createManagedInferenceGrantRoute} from './lib/managed-inference-grant-route.mjs';
import {createServerApiGateway} from './lib/server-api-gateway.mjs';
import {openManagedInferenceLedger} from './lib/managed-inference-ledger.mjs';

const model = 'fixture-model';
const account = Object.freeze({verified:true,accountId:'account-one',sessionId:'session-one',expiresAt:5000});
const second = Object.freeze({...account,accountId:'account-two',sessionId:'session-two'});
const otherDevice = Object.freeze({...account,sessionId:'session-three'});
const identities = new Map([['one',account],['two',second],['three',otherDevice]]);
const identityFixture = (overrides={}) => Object.freeze({
  authenticate:({accessToken})=>identities.get(accessToken),
  verifySession:({sessionId})=>[...identities.values()].find(x=>x.sessionId===sessionId),
  ...overrides
});

test('the cloud owner binds a grant and usage entry to a server-issued turn', async t => {
  const now = ()=>1000;
  const turns = createManagedInferenceTurns({identityOwner:identityFixture(),now});
  const grants = createManagedInferenceGrants({model,now,resolveTurn:turns.resolveTurn});
  const route = createManagedInferenceGrantRoute({identityOwner:turns.identityOwner,grantOwner:grants});
  const ledger = openManagedInferenceLedger({filename:':memory:',now,reserveCredits:()=>20,creditsForUsage:usage=>usage.totalTokens});
  ledger.grantTrial({accountId:account.accountId,expiresAt:5000,credits:100});
  let dispatched = 0;
  const gateway = createServerApiGateway({
    upstreamBaseUrl:'https://provider.example/v1',apiKey:'fixture-upstream-key',authorizationOwner:grants.authorizationOwner,
    accountingOwner:ledger.accountingOwner,fetchImpl:async()=>{
      dispatched++;
      return Response.json({id:'response-one',status:'completed',usage:{input_tokens:2,output_tokens:3,total_tokens:5}});
    }
  });
  const server = http.createServer((req,res)=>void (req.url==='/v1/managed/grants'?route.handle(req,res):gateway.handle(req,res)));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async ()=>{
    route.close();gateway.close();grants.close();turns.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    ledger.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const {turnId} = await turns.open({accessToken:'one'});
  async function requestGrant(accessToken, requestedTurn = turnId) {
    const result = await fetch(base+'/v1/managed/grants',{
      method:'POST',headers:{authorization:'Bearer '+accessToken,'content-type':'application/json'},
      body:JSON.stringify({turnId:requestedTurn})
    });
    return {status:result.status,body:await result.json()};
  }
  assert.equal((await requestGrant('two')).status,403);
  assert.equal((await requestGrant('three')).status,403);
  assert.equal((await requestGrant('one','fabricated-turn')).status,403);
  const result = await requestGrant('one');
  assert.equal(result.status,200);
  const response = await fetch(base+'/v1/responses',{
    method:'POST',headers:{authorization:'Bearer '+result.body.token,'content-type':'application/json','x-buildx-turn-id':turnId},
    body:JSON.stringify({model})
  });
  assert.equal(response.status,200);
  assert.equal((await response.json()).usage.total_tokens,5);
  for(let retry=0;ledger.balance(account.accountId).charged===0&&retry<20;retry++){
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.deepEqual(ledger.requestsForTurn(account.accountId,turnId).map(entry=>[entry.state,entry.charged]),[['settled',5]]);
  assert.equal(dispatched,1);
  assert.equal(await turns.finish({accessToken:'one',turnId}),true);
  assert.equal((await requestGrant('one')).status,403);
});

test('capacity is bounded and expired or completed turns release their slot',async t=>{
  let time = 1000;
  const turns = createManagedInferenceTurns({identityOwner:identityFixture(),now:()=>time,ttlMs:100,maxActive:1});
  t.after(turns.close);
  const initial = await turns.open({accessToken:'one'});
  assert.equal(initial.expiresAt,1100);
  assert.equal(await turns.open({accessToken:'one'}),null);
  assert.equal(await turns.open({accessToken:'two'}),null);
  assert.equal(await turns.finish({accessToken:'three',turnId:initial.turnId}),false);
  assert.equal(await turns.finish({accessToken:'one',turnId:initial.turnId}),true);
  const next = await turns.open({accessToken:'two'});
  assert.ok(next);
  time=next.expiresAt;
  assert.equal(await turns.resolveTurn({sessionId:second.sessionId,turnId:next.turnId}),null);
  assert.ok(await turns.open({accessToken:'one'}));
});

test('finishing a turn discards a late successful session verification',async t=>{
  let resume;
  const pending = new Promise(resolve=>{resume=resolve;});
  const turns = createManagedInferenceTurns({identityOwner:identityFixture({verifySession:()=>pending}),now:()=>1000});
  t.after(()=>{resume(account);turns.close();});
  const {turnId} = await turns.open({accessToken:'one'});
  const resolution = turns.resolveTurn({sessionId:account.sessionId,turnId});
  assert.equal(await turns.finish({accessToken:'one',turnId}),true);
  resume(account);
  assert.equal(await resolution,null);
});
