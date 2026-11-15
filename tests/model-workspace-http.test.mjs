import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';

async function setup(t,options){const fixture=await createModelWorkspaceFixture(options);t.after(()=>fixture.close());return fixture;}
async function login(f){const result=await f.post('account/sign-in',{email:'demo@example.invalid',password:'fixture-password'});assert.equal(result.status,200);return result.cookie;}
async function until(stream,predicate){while(true){const item=await stream.next();if(predicate(item))return item;}}

test('only the model composition serves and injects its two layout resources',async t=>{
  for(const profile of ['model','source-development','customer-chat'])await t.test(profile,async t=>{
    const f=await setup(t,{profile}),response=await fetch(f.origin+'/'),html=await response.text();
    assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
    assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/);
    assert.equal((html.match(/<form\b/g)||[]).length,1);assert.equal((html.match(/id="transcript"/g)||[]).length,1);
    for(const resource of ['model-workspace.mjs','model-workspace.css']){
      assert.equal(html.includes('/'+resource),profile==='model');
      const asset=await fetch(f.origin+'/'+resource);assert.equal(asset.status,profile==='model'?200:404);
      if(profile==='model')assert.match(asset.headers.get('content-type'),resource.endsWith('.css')?/text\/css/:/text\/javascript/);
    }
    const parameterOptions=await fetch(f.origin+'/command-parameter-options.mjs');
    assert.equal(parameterOptions.status,profile==='model'?200:404);
    if(profile==='model')assert.match(await parameterOptions.text(),/export function validateCommandParameterOptions/);
    for(const resource of ['register.html','register.css']){
      const asset=await fetch(f.origin+'/'+resource);assert.equal(asset.status,profile==='model'?200:404);
      if(profile==='model'){
        assert.match(asset.headers.get('content-type'),resource.endsWith('.css')?/text\/css/:/text\/html/);
        const body=await asset.text();
        if(resource.endsWith('.html')){
          assert.match(body,/注册服务正在接入，暂未开放注册/);
          assert.equal((body.match(/<input\b[^>]*\bdisabled/g)||[]).length,3);
          assert.doesNotMatch(body,/<script\b/);
        }
      }
    }
    assert.equal((await fetch(f.origin+'/test-support/model-workspace-preview.mjs')).status,404);
    assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);
  });
});

test('real model HTTP retains Host/Origin/CSRF, login and explicit Codex confirmation gates',async t=>{
  const f=await setup(t);
  assert.equal((await f.post('turn',{message:'blocked'})).status,401);
  assert.equal((await f.events()).response.status,401);
  assert.equal((await f.post('turn',{message:'blocked'},undefined,{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await f.post('turn',{message:'blocked'},undefined,{'X-Local-Chat':'forged'})).status,403);
  const foreign=await new Promise((resolve,reject)=>{const request=http.get(f.origin+'/api/status',{headers:{Host:'foreign.invalid'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);});
  assert.equal(foreign,403);
  const cookie=await login(f);assert.equal((await f.status(cookie)).ready,false);
  assert.equal((await f.post('turn',{message:'still blocked'},cookie)).status,403);
  const inspected=await f.post('codex-account/inspect',{},cookie);assert.equal(inspected.status,200);
  assert.equal((await f.status(cookie)).ready,false);
  assert.equal((await f.post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie)).status,200);
  assert.equal((await f.status(cookie)).ready,true);assert.equal(f.codex.turns.length,0);assert.equal(f.workbenchCalls.length,0);
});

test('dialogue read requests retain the original turn/SSE owner and exact interruption receipts',async t=>{
  const f=await setup(t),cookie=await login(f);assert.equal((await f.confirm(cookie)).status,200);
  const stream=await f.events(cookie);assert.equal((await stream.next()).event,'snapshot');
  const request=await f.post('turn',{message:'请只读列出当前模型的标高。不要修改模型。'},cookie);
  assert.equal(request.status,202);assert.equal(f.app.snapshot('model-test-client').busy,true);
  assert.equal(f.app.snapshot('model-test-client').session.messages.at(-1).status,'streaming');
  assert.equal((await f.post('turn',{client:'other-client',message:'并发请求'},cookie)).status,409);
  assert.equal((await f.post('interrupt',{client:'other-client'},cookie)).status,202);assert.equal(f.codex.interrupts.length,0);
  assert.equal((await f.post('interrupt',{},cookie)).status,202);assert.equal(f.codex.interrupts.length,1);
  assert.equal(f.app.snapshot('model-test-client').busy,true);
  f.codex.finish(0,'interrupted','');
  const terminal=await until(stream,item=>item.event==='done');assert.equal(terminal.data.status,'interrupted');
  assert.equal(f.app.snapshot('model-test-client').busy,false);
  await f.post('turn',{message:'新的只读请求'},cookie);const current=f.codex.turns[1];
  f.codex.notify('item/agentMessage/delta',f.codex.turns[0],{itemId:'late',delta:'旧轮次污染'});
  f.codex.finish(current,'completed','新的真实服务回执');
  const view=f.app.snapshot('model-test-client');assert.equal(view.busy,false);
  assert.equal(view.session.messages.at(-1).text,'新的真实服务回执');assert.doesNotMatch(JSON.stringify(view),/旧轮次污染/);
  assert.equal(f.codex.threads,1);assert.equal(f.workbenchCalls.length,0);
});

test('selection context is recaptured only for the new turn and never rewrites an earlier request',async t=>{
  const f=await setup(t,{required:false});
  await f.post('turn',{message:'第一轮只读查询',context:{includeDocument:false,includeSelection:true}});
  const first=f.codex.turns[0].text;
  assert.match(first,/"elementIds":\["42","84"\]/);
  assert.deepEqual(f.workbenchCalls.map(call=>call.name),['revit_workbench_status','revit_get_selection','revit_workbench_status']);
  assert.deepEqual(f.workbenchCalls[1].args,{expected_document:'D:\\isolated-samples\\project.rvt'});
  f.codex.finish(0);f.setDocument({title:'另一个模型.rvt',path:'D:\\isolated-samples\\other.rvt',activeViewId:24},[108]);
  await f.post('turn',{message:'第二轮只读查询',context:{includeDocument:false,includeSelection:true}});
  assert.equal(f.codex.turns[0].text,first);assert.match(f.codex.turns[1].text,/"elementIds":\["108"\]/);
  assert.doesNotMatch(f.codex.turns[1].text,/"42"|"84"/);f.codex.finish(1);
  await f.post('turn',{message:'第三轮普通对话'});
  assert.equal(f.codex.turns[2].text,'第三轮普通对话');assert.equal(f.workbenchCalls.length,6);
  assert.equal(f.app.snapshot('model-test-client').session.messages[0].text,'第一轮只读查询');
});
