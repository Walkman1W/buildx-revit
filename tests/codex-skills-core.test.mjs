import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CodexClient} from '../lib/codex-client.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

// Protocol and account ownership are simulated; no real Codex or skills run.
function fixture(profile=MODEL_WORKSPACE_SESSION_PROFILE,skillCatalogMode='research'){
  const root=path.resolve('skill-workspace-fixture'),calls=[],child=new EventEmitter();
  const client=new CodexClient(root,{profile},{skillCatalogMode});
  const connection={child,generation:1,phase:'ready',closed:false,fault:null,delays:new Set()};
  client._generation=1;client._connection=connection;client.child=child;
  client.initialized=true;client.authReady=true;client.toolsReady=true;
  client._accountStatus='verified';client._accountObservation={connectionGeneration:1,accountRevision:0};
  const skillPath=path.resolve('private-skill-fixture','SKILL.md');
  let response={data:[{cwd:root,errors:[],skills:[{name:'sample',description:'Example skill',enabled:true,path:skillPath,scope:'user'},
    {name:'disabled',description:'Not available',enabled:false,path:path.resolve('disabled','SKILL.md'),scope:'user'}]}]};
  client.request=async(method,params)=>{calls.push({method,params});if(method==='skills/list')return typeof response==='function'?response():response;return {turn:{id:'ok'}};};
  return {client,connection,calls,skillPath,root,setResponse:value=>{response=value;}};
}

test('explicit selected skill uses the discovered path while the displayed catalog never returns it',async()=>{
  const f=fixture(),list=await f.client.listSkills();
  assert.equal(list.length,1);assert.equal(list[0].name,'sample');assert.ok(!JSON.stringify(list).includes(f.skillPath));
  assert.deepEqual(f.calls[0],{method:'skills/list',params:{cwds:[f.root],forceReload:true}});
  f.client.assertSkillSelection([list[0].id]);
  await f.client.turn('thread','hello',[],undefined,undefined,[list[0].id]);
  assert.deepEqual(f.calls.at(-1),{method:'turn/start',params:{threadId:'thread',input:[{type:'text',text:'hello'},{type:'skill',name:'sample',path:f.skillPath}]}});
});

test('unknown, duplicate and raw-path selections are rejected before a turn is sent',async()=>{
  const f=fixture(),[entry]=await f.client.listSkills(),before=f.calls.length;
  for(const ids of [[f.skillPath],[entry.id,entry.id],['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],Array(9).fill(entry.id)]){
    assert.throws(()=>f.client.assertSkillSelection(ids),{code:'CODEX_SKILL_SELECTION_INVALID',notSent:true});
    await assert.rejects(f.client.turn('thread','hello',[],undefined,undefined,ids),{code:'CODEX_SKILL_SELECTION_INVALID',notSent:true});
  }
  assert.equal(f.calls.length,before);
  await f.client.turn('thread','hello');assert.equal(f.calls.at(-1).params.input.length,1);
});

test('new refresh invalidates prior IDs immediately; late refresh cannot replace newer catalog',async()=>{
  const f=fixture(),[old]=await f.client.listSkills();let release;
  f.setResponse(()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.client.listSkills();
  assert.throws(()=>f.client.assertSkillSelection([old.id]),{notSent:true});
  f.setResponse({data:[{cwd:f.root,errors:[],skills:[{name:'new',description:'new',enabled:true,path:path.resolve('new','SKILL.md'),scope:'repo'}]}]});
  const [current]=await f.client.listSkills();
  release({data:[{cwd:f.root,errors:[],skills:[]}]});await assert.rejects(pending,{code:'CODEX_SKILLS_UNAVAILABLE'});
  f.client.assertSkillSelection([current.id]);
});

test('skills/changed and account change revoke selected IDs and notify the panel',async()=>{
  for(const method of ['skills/changed','account/updated']){
    const f=fixture(),[item]=await f.client.listSkills();let events=0;
    f.client.on('skills-changed',()=>events++);f.client.dispatch({method,params:{}},f.connection);
    assert.equal(events,1);assert.throws(()=>f.client.assertSkillSelection([item.id]),{notSent:true});
  }
});

test('an account change while discovery is pending cannot publish a new catalog',async()=>{
  const f=fixture();let release;
  f.setResponse(()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.client.listSkills();
  f.client.dispatch({method:'account/updated',params:{}},f.connection);
  release({data:[{cwd:f.root,errors:[],skills:[]}]});
  await assert.rejects(pending,{code:'CODEX_ACCOUNT_REVISION_CHANGED'});
  assert.equal(f.client._skillsCatalog,null);
});

test('failed or ambiguous observations are unavailable, not an empty catalog or a private error',async()=>{
  const f=fixture();
  for(const response of [null,{data:[]},{data:[{cwd:f.root,errors:[{path:f.skillPath,message:'private'}],skills:[]}]},
    {data:[{cwd:f.root,errors:[],skills:[{name:'same',description:'x',enabled:true,path:f.skillPath,scope:'user'},
      {name:'same',description:'y',enabled:true,path:path.resolve('other','SKILL.md'),scope:'user'}]}]},
    {data:[{cwd:f.root,errors:[],skills:[{name:'bad',description:'x',enabled:true,path:'relative',scope:'user'}]}]}]){
    f.setResponse(response);await assert.rejects(f.client.listSkills(),error=>error.code==='CODEX_SKILLS_UNAVAILABLE'&&!error.message.includes(f.skillPath));
  }
  f.setResponse({data:[{cwd:f.root,errors:[],skills:[]}]});assert.deepEqual(await f.client.listSkills(),[]);
});

test('only the BuildX model workspace exposes skill discovery',async()=>{
  const f=fixture('model-readonly');await assert.rejects(f.client.listSkills(),{code:'CODEX_SKILLS_UNAVAILABLE'});
  assert.equal(f.calls.length,0);f.client.assertSkillSelection([]);
});

test('customer discovery does not expose or authorize personal skills and does not infer dependency readiness',async()=>{
  const f=fixture(MODEL_WORKSPACE_SESSION_PROFILE,'customer');
  const productPath=path.join(f.root,'.agents','skills','buildx-project-research','SKILL.md');
  f.setResponse({data:[{cwd:f.root,errors:[],skills:[
    {name:'private',description:'private details',enabled:true,path:f.skillPath,scope:'user'},
    {name:'buildx-project-research',description:'untrusted',enabled:true,path:productPath,scope:'repo'},
  ]}]});
  const [product]=await f.client.listSkills();
  assert.equal(product.title,'资料库问答');assert.equal(product.availability,'unknown');assert.equal(product.selectable,false);
  assert.deepEqual(product.dependencies.map(dependency=>dependency.name),['buildx_materials_list','buildx_materials_read']);
  assert.ok(product.dependencies.every(dep=>dep.status==='unknown'));
  assert.doesNotMatch(JSON.stringify(product),/private|untrusted|SKILL\.md/);
  assert.equal(f.client._skillsCatalog.skills.size,0);
  const before=f.calls.length;
  await assert.rejects(f.client.turn('thread','hello',[],undefined,undefined,['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),{code:'CODEX_SKILL_SELECTION_INVALID',notSent:true});
  assert.equal(f.calls.length,before);
});
