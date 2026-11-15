import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('failed access initialization reports its reason and an explicit SSE reconnect retries once',async t=>{
  const first=deferred(),second=deferred();let attempts=0,snapshot=null;
  const recovered=Object.freeze({id:'recovered-policy',revision:0,accountScope:'model:research-local',mode:'read-only',roots:[]});
  const accessServices=Object.freeze({
    tools:Object.freeze([]),view:()=>snapshot,
    async activate(){
      attempts++;
      if(attempts===1){await first.promise;return {ok:false,error:{code:'ACCESS_POLICY_UNAVAILABLE',message:'Controlled temporary initialization failure'}};}
      await second.promise;snapshot=recovered;return {ok:true,value:snapshot};
    },
    current:()=>snapshot!==null,control:()=>snapshot,
    authorize:async()=>({ok:false}),select:async()=>({ok:false}),invoke:async()=>({ok:false}),
    deactivate:async()=>({closed:true}),close:async()=>({closed:true})
  });
  const fixture=await createModelWorkspaceFixture({profile:'model-workspace',required:false,accessServices});
  t.after(async()=>{first.resolve();second.resolve();await fixture.close();});

  const initial=fixture.app.snapshot('model-test-client').session.accessPolicy;
  assert.equal(initial.loading,true);await settle();assert.equal(attempts,1);
  first.resolve();await settle();await settle();
  for(let i=0;i<2;i++){
    const failure=fixture.app.snapshot('model-test-client').session.accessPolicy;
    assert.equal(failure.available,false);
    assert.match(failure.reason,/Controlled temporary initialization failure/);
    assert.notEqual(failure.loading,true);
  }
  assert.equal(attempts,1,'failure broadcasts and ordinary snapshots must not create a retry loop');

  const events=await fixture.events();assert.equal(events.response.status,200);
  await events.next();assert.equal(attempts,2,'an explicit new SSE connection retries initialization');
  second.resolve();
  let current;
  for(let i=0;i<6;i++){
    const event=await events.next();current=event.data.session?.accessPolicy;
    if(current?.id===recovered.id)break;
  }
  assert.equal(current?.available,true);assert.equal(current?.id,recovered.id);
  assert.equal(current?.mode,'read-only');assert.notEqual(current?.loading,true);
  assert.equal(fixture.app.snapshot('model-test-client').session.accessPolicy.id,recovered.id);
  assert.equal(attempts,2);events.abort();
});
