import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedInferenceRelay, managedRelayLaunchInfo} from './lib/managed-inference-relay.mjs';
import {createManagedCodexProvider} from './lib/managed-codex-provider.mjs';
import {MANAGED_WORKBENCH_DYNAMIC_TOOL} from './lib/managed-workbench-reads.mjs';
import os from 'node:os';
import path from 'node:path';

test('production gateway remains closed until configured',async()=>{await assert.rejects(createManagedInferenceRelay({getCloudAuthorization:()=> 'fixture'}),{code:'MANAGED_GATEWAY_UNCONFIGURED'});});
test('loopback relay enforces token and forwards trusted auth and turn with stream',async()=>{
 let captured; const relay=await createManagedInferenceRelay({getCloudAuthorization:()=>({token:'cloud-fixture',turnId:'turn-1'}),testOnly:{url:'http://127.0.0.1:1234/v1/responses',fetch:async(url,options)=>{captured={url,options}; return new Response('data: done\n\n',{headers:{'content-type':'text/event-stream'}});}}});
 try {let r=await fetch(relay.baseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401);
 r=await fetch(relay.baseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+managedRelayLaunchInfo(relay).localToken,'x-buildx-turn-id':'untrusted'},body:'{}'});assert.equal(await r.text(),'data: done\n\n');assert.equal(captured.options.headers.authorization,'Bearer cloud-fixture');assert.equal(captured.options.headers['x-buildx-turn-id'],'turn-1');assert.equal(captured.options.redirect,'error');} finally {await relay.close();}
});
test('provider sets isolated home and keeps secret out of argv',async()=>{
 const relay=await createManagedInferenceRelay({getCloudAuthorization:()=> 'fixture',testOnly:{url:'http://127.0.0.1:1234/v1/responses',fetch:async()=>new Response('')}});
 const secret=managedRelayLaunchInfo(relay).localToken; const provider=createManagedCodexProvider({relay,model:'fixture',codexHome:path.resolve('isolated')});let call;
 assert.ok(!JSON.stringify(relay).includes(secret));
 assert.ok(Object.isFrozen(provider.describe())); assert.ok(Object.isFrozen(provider.describe().identity)); assert.equal(provider.describe().status,'unverified');
 provider.start({spawn:(...args)=>(call=args,{}),executable:path.resolve('codex.exe'),cwd:process.cwd(),baseArgs:['app-server'],env:{CODEX_HOME:'old',OPENAI_API_KEY:'old',CLOUD_SECRET:'private',PATH:'x'}});
 assert.ok(!JSON.stringify(call[1]).includes(secret));assert.equal(call[2].env.CODEX_HOME,path.resolve('isolated'));assert.equal(call[2].env.OPENAI_API_KEY,undefined);assert.equal(call[2].env.CLOUD_SECRET,undefined);assert.ok(Object.values(call[2].env).includes(secret));assert.throws(()=>provider.start({})); await relay.close();
 assert.throws(()=>createManagedCodexProvider({relay:{baseUrl:'http://127.0.0.1:1234/v1',localToken:secret},model:'fixture',codexHome:path.resolve('isolated')}));
 assert.throws(()=>managedRelayLaunchInfo(relay));
});

test('a grant without its bound turn is rejected before reaching the gateway',async t=>{
 let calls=0;
 const relay=await createManagedInferenceRelay({
   getCloudAuthorization:()=>({token:'fixture'}),
   testOnly:{url:'http://127.0.0.1:1234/v1/responses',fetch:async()=>{calls++;return new Response('');}}
 });
 t.after(relay.close);
 const response=await fetch(relay.baseUrl+'/responses',{
   method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+managedRelayLaunchInfo(relay).localToken},body:'{}'
 });
 await response.text();
 assert.equal(response.status,403);
 assert.equal(calls,0);
});

async function pilotRelayFixture(t){
  const spec=MANAGED_WORKBENCH_DYNAMIC_TOOL;
  const approved={type:'function',name:spec.name,description:spec.description,parameters:spec.inputSchema,strict:false};
  const pilotWorkspace=path.resolve(os.tmpdir(),'fixture-private-connection','workspace');
  let grants=0;
  const upstream=[];
  const relay=await createManagedInferenceRelay({
    workbenchPilot:true,pilotWorkspace,
    getCloudAuthorization(){grants++;return {token:'pilot-fixture',turnId:'pilot-turn-1'};},
    testOnly:{
      url:'http://127.0.0.1:1234/v1/responses',
      async fetch(_url,options){
        upstream.push(JSON.parse(Buffer.from(options.body)));
        return new Response('data: pilot\n\n',{headers:{'content-type':'text/event-stream'}});
      }
    }
  });
  t.after(relay.close);
  const headers={'content-type':'application/json',authorization:'Bearer '+managedRelayLaunchInfo(relay).localToken};
  const post=body=>fetch(relay.baseUrl+'/responses',{method:'POST',headers,body:JSON.stringify(body)});
  return {approved,pilotWorkspace,post,upstream,get grants(){return grants;}};
}

test('workbench pilot relays only the approved read spec and rejects other tools before requesting a grant',async t=>{
  const fixture=await pilotRelayFixture(t);
  const {approved,post,upstream}=fixture;
  const prompt={type:'function',name:'request_user_input',description:'Ask the user a question',
    parameters:{type:'object',properties:{questions:{type:'array',items:{type:'object'}}},required:['questions'],additionalProperties:false},
    strict:false};
  const body={model:'fixture-model',input:[{role:'user',content:[{type:'input_text',text:'核对选择，保留原文 "tools"'}]}],
    tools:[approved,prompt],tool_choice:'auto',stream:true};
  const accepted=await post(body);
  assert.equal(accepted.status,200);
  assert.equal(await accepted.text(),'data: pilot\n\n');
  assert.deepEqual(upstream,[{...body,tools:[approved]}]);
  assert.equal(fixture.grants,1);

  const unknown={...approved,name:'unexpected_write'};
  const forged={...approved,parameters:{...approved.parameters,additionalProperties:true}};
  for(const [label,change] of [
    ['forged schema',{tools:[forged,prompt]}],
    ['unknown function',{tools:[unknown,prompt]}],
    ['extra function',{tools:[approved,prompt,unknown]}],
    ['duplicate approved function',{tools:[approved,approved,prompt]}],
    ['unsupported built-in',{tools:[approved,{type:'web_search_preview'}]}],
    ['forced built-in prompt choice',{tool_choice:{type:'function',name:prompt.name}}]
  ]){
    const rejected=await post({...body,...change});
    await rejected.text();
    assert.equal(rejected.status,400,label);
    assert.equal(fixture.grants,1,label);
    assert.equal(upstream.length,1,label);
  }
});

test('workbench pilot projects only its generated workspace context and blocks unhandled private path locations',async t=>{
  const fixture=await pilotRelayFixture(t);
  const {approved,pilotWorkspace,post,upstream}=fixture;
  const context=workspace=>[
    '<environment_context>',
    `  <cwd>${workspace}</cwd>`,
    '  <shell>bash</shell>',
    '  <current_date>2026-11-09</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    `  <filesystem><workspace_roots><root>${workspace}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>`,
    '</environment_context>'
  ].join('\n');
  const message=(role,text)=>({type:'message',role,content:[{type:'input_text',text}]});
  const developer=message('developer','Read the selected elements.');
  const nativeCatalog=message('developer',[
    '<skills_instructions>','## Skills','### Skill roots',
    `- r0 = ${path.join(path.dirname(pilotWorkspace),'home','skills','.system')}`,
    '### Available skills','- fixture skill','</skills_instructions>'
  ].join('\n'));
  const generated=message('user',context(pilotWorkspace));
  const user=message('user','请保持原文，比较后续选择。');
  const unrelated=message('user',context(path.resolve(os.tmpdir(),'fixture-unrelated-workspace')));
  const combinedDeveloper={...developer,content:[...developer.content,...nativeCatalog.content]};
  const body={model:'fixture-model',input:[combinedDeveloper,generated,user,unrelated],
    tools:[approved],tool_choice:'auto',stream:true};
  const accepted=await post(body);
  assert.equal(accepted.status,200);
  await accepted.text();
  assert.deepEqual(upstream,[{...body,input:[developer,message('user',context('[BuildX managed workspace]')),user,unrelated]}]);
  assert.equal(fixture.grants,1);

  const followOn={...body,previous_response_id:'fixture-response-1',input:[user,unrelated]};
  const continued=await post(followOn);
  assert.equal(continued.status,200);
  await continued.text();
  assert.deepEqual(upstream[1],followOn);
  assert.equal(fixture.grants,2);

  const privateLocations=[
    ['no following user message',[developer,generated]],
    ['generated context after ordinary user text',[developer,user,generated]],
    ['malformed generated context',[developer,message('user',context(pilotWorkspace)+'\nextra'),user]],
    ['private path in ordinary user text',[developer,generated,message('user','保持这段文本：'+pilotWorkspace)]],
    ['private path in developer instructions',[message('developer',path.join(path.dirname(pilotWorkspace),'home')),generated,user]],
    ['private path in tool output',[developer,generated,user,{type:'function_call_output',call_id:'fixture',output:pilotWorkspace}]]
  ];
  if(process.platform==='win32'){
    privateLocations.push(
      ['alternate Windows case',[developer,generated,message('user',pilotWorkspace.toUpperCase())]],
      ['alternate Windows separators',[developer,generated,message('user',pilotWorkspace.replaceAll('\\','/'))]]
    );
  }
  for(const [label,input] of privateLocations){
    const rejected=await post({...body,input});
    await rejected.text();
    assert.equal(rejected.status,400,label);
    assert.equal(fixture.grants,2,label);
    assert.equal(upstream.length,2,label);
  }
});

test('workbench pilot requires a private absolute workspace directory',async()=>{
  for(const pilotWorkspace of [undefined,'relative-fixture-workspace',path.parse(path.resolve(os.tmpdir())).root]){
    await assert.rejects(async()=>{
      const relay=await createManagedInferenceRelay({
        workbenchPilot:true,pilotWorkspace,getCloudAuthorization:()=>assert.fail('must reject before asking for authorization'),
        testOnly:{url:'http://127.0.0.1:1234/v1/responses',fetch:()=>assert.fail('must reject before forwarding')}
      });
      await relay.close();
    },/Invalid managed pilot workspace/);
  }
});
