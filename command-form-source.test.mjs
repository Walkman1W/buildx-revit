import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelToolDispatcher} from './lib/model-tool-dispatch.mjs';
import {invokeReadonlyPanelCommand} from './lib/workbench-client.mjs';
import {createModelWorkspaceFixture} from './test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';

const source={session:'f'.repeat(32),title:'参数示例',path:'D:\\samples\\parameters.rvt'};
const identity={hostSession:source.session,document:{title:source.title,path:source.path}};
const parameters={mode:'rollback',changes:[{element_id:42,parameter_id:-1001203,value:'新备注'}]};

test('parameter form source constrains the fresh write target without changing tool arguments',async()=>{
  const reads=[],writes=[];
  const dispatcher=createModelToolDispatcher({
    invokeAtomicRead:async(name,args)=>{reads.push({name,args});return identity;},
    invokeWorkbench:async(name,args,options)=>{writes.push({name,args,options});return {...identity,value:{updated_count:1}};},
  });
  const result=await dispatcher.invokeCommand('revit_set_parameters',parameters,{confirmed:true,sourceDocument:source});
  assert.equal(result.ok,true);
  assert.deepEqual(reads,[{name:'revit_workbench_status',args:{}}]);
  assert.equal(writes.length,1);assert.equal(writes[0].name,'revit_set_parameters');
  assert.deepEqual(writes[0].args,{...parameters,expected_document:source.path});
  assert.equal(writes[0].options.expectedHostSession,source.session);
  assert.equal(Object.hasOwn(writes[0].args,'sourceDocument'),false);
});

test('changed document, title or host rejects a stale form before the write owner is called',async()=>{
  for(const changed of [
    {...identity,document:{...identity.document,path:'D:\\samples\\other.rvt'}},
    {...identity,document:{...identity.document,title:'另一个模型'}},
    {...identity,hostSession:'e'.repeat(32)},
  ]){
    let writes=0;
    const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>changed,invokeWorkbench:async()=>{writes++;throw new Error('stale form must not write');}});
    const result=await dispatcher.invokeCommand('revit_set_parameters',parameters,{confirmed:true,sourceDocument:source});
    assert.equal(result.ok,false);assert.equal(result.error.code,'COMMAND_INPUT_INVALID');assert.equal(result.error.outcome,'not_started');
    assert.equal(writes,0);
  }
});

test('source is a restriction, not confirmation or an override for a caller-selected document',async()=>{
  let writes=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>identity,invokeWorkbench:async()=>{writes++;return identity;}});
  const unconfirmed=await dispatcher.invokeCommand('revit_set_parameters',parameters,{sourceDocument:source});
  assert.equal(unconfirmed.error.code,'COMMAND_CONFIRMATION_REQUIRED');
  await assert.rejects(dispatcher.invokeTool('revit_set_parameters',{...parameters,expected_document:'D:\\other.rvt'},{sourceDocument:source}),/不一致/);
  const misplaced=await dispatcher.invokeCommand('revit_set_parameters',{...parameters,sourceDocument:source},{confirmed:true});
  assert.equal(misplaced.error.code,'COMMAND_INPUT_INVALID');assert.equal(writes,0);
});

test('parameter discovery binds source path and host and verifies the returned identity',async()=>{
  let current=identity;const calls=[];
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async(name,args,options)=>{
    calls.push({name,args,options});return {...current,value:{element_id:42,parameters:[]}};
  }});
  const discover=()=>dispatcher.invokeCommand('revit_describe_parameters',{element_id:42},{sourceDocument:source});
  assert.equal((await discover()).ok,true);
  assert.equal(calls[0].name,'revit_describe_parameters');
  assert.deepEqual(calls[0].args,{element_id:42,expected_document:source.path});
  assert.equal(calls[0].options.expectedHostSession,source.session);
  current={...identity,document:{...identity.document,path:'D:\\other.rvt'}};
  assert.equal((await discover()).error.outcome,'unconfirmed');
  current={...identity,hostSession:'e'.repeat(32)};
  assert.equal((await discover()).error.code,'COMMAND_READ_UNCONFIRMED');
});

test('a received parameter-query identity mismatch keeps its request evidence and recovery owner',async()=>{
  const requestId='11111111-1111-4111-8111-111111111111';
  const owner=Object.freeze({inspect:async()=>({ok:true}),close:async()=>({ok:true,value:{closed:true}})});
  const returned={...identity,document:{...identity.document,path:'D:\\other.rvt'},request_id:requestId,value:{element_id:42,parameters:[]}};
  Object.defineProperty(returned,'receiptOwner',{value:owner});
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>returned});
  const result=await dispatcher.invokeCommand('revit_describe_parameters',{element_id:42},{sourceDocument:source});
  assert.equal(result.ok,false);assert.equal(result.error.code,'COMMAND_READ_UNCONFIRMED');assert.equal(result.error.outcome,'unconfirmed');
  assert.deepEqual(result.evidence.requestIds,[requestId]);assert.equal(result.receiptOwner,owner);
  assert.equal(result.evidence.producerResult.document.path,'D:\\other.rvt');
});

test('legacy callers without source keep their argument and document-binding behavior',async()=>{
  const calls=[];
  const dispatcher=createModelToolDispatcher({
    invokeAtomicRead:async(name,args,options)=>{calls.push({name,args,options});return {...identity,value:{parameters:[]}};},
    invokeWorkbench:async(name,args)=>{calls.push({name,args});return identity;},
  });
  assert.equal((await dispatcher.invokeCommand('revit_describe_parameters',{element_id:42})).ok,true);
  assert.deepEqual(calls[0].args,{element_id:42});assert.equal(calls[0].options.expectedHostSession,undefined);
  assert.equal((await dispatcher.invokeCommand('revit_set_parameters',parameters,{confirmed:true})).ok,true);
  assert.deepEqual(calls.at(-1).args,{...parameters,expected_document:source.path});
});

test('dispatcher rejects malformed source before any query or write',async()=>{
  let calls=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>{calls++;return identity;},invokeWorkbench:async()=>{calls++;return identity;}});
  for(const sourceDocument of [null,[],{}, {...source,session:''},{...source,title:1},{...source,path:null},{...source,extra:true}]){
    const result=await dispatcher.invokeCommand('revit_set_parameters',parameters,{confirmed:true,sourceDocument});
    assert.equal(result.error.code,'COMMAND_INPUT_INVALID');assert.equal(result.error.outcome,'not_started');
  }
  assert.equal(calls,0);
});

async function terminal(f,executionId){
  const end=Date.now()+5000;
  while(Date.now()<end){
    const command=f.app.snapshot('model-test-client').command;
    if(command?.executionId===executionId&&!['running','stopping'].includes(command.status))return command;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Command form source HTTP fixture deadline');
}

test('HTTP validates source fields, preserves confirmation and passes source separately to the command owner',async t=>{
  const calls=[];
  const f=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,invokeReadonlyCommand:async(commandId,args,options)=>{
    calls.push({commandId,args,options});return {ok:true,value:{command:commandId,...identity,data:{items:[]}}};
  }});t.after(()=>f.close());
  const stream=await f.events(),conversationId=(await stream.next()).data.session.conversation.id;
  const request={conversationId,commandId:'revit_set_parameters',parameters,confirmed:true};
  for(const sourceDocument of [null,[],{}, {...source,session:''},{...source,title:2},{...source,path:null},{session:source.session,title:source.title},{...source,extra:true}]){
    assert.equal((await f.post('command',{...request,sourceDocument})).status,400);
  }
  assert.equal((await f.post('command',{...request,parameters:{...parameters,sourceDocument:source}})).status,400);
  assert.equal((await f.post('command',{...request,confirmed:false,sourceDocument:source})).status,403);
  assert.equal(calls.length,0);
  const accepted=await f.post('command',{...request,sourceDocument:source});assert.equal(accepted.status,202);
  assert.equal((await terminal(f,accepted.body.executionId)).status,'completed');
  assert.deepEqual(calls[0].args,parameters);assert.deepEqual(calls[0].options.sourceDocument,source);
  assert.equal(calls[0].options.confirmed,true);assert.equal(typeof calls[0].options.shouldContinue,'function');
  const legacy=await f.post('command',request);assert.equal(legacy.status,202);
  await terminal(f,legacy.body.executionId);assert.equal(Object.hasOwn(calls[1].options,'sourceDocument'),false);
  assert.equal(f.codex.turns.length,0);
});

// Public read workflow over the actual filesystem queue and response parser.
// This peer owns a fresh temporary directory and never connects to Revit.
async function nativeReadHost(t,{atomic}){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-form-source-')),queue=path.join(root,'queue');
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:source.session,pid:process.pid,version:atomic?'0.6.4':'0.6.1',...atomic?{atomicReadSnapshot:true}:{}}));
  const requests=[],dispatched=[];
  const document={...identity.document,activeViewId:9,activeViewType:'FloorPlan',allowedSample:false,modified:false};
  const status=()=>({...identity,document:{...document},capabilities:{atomicReadSnapshot:atomic}});
  const element={element_id:42,name:'墙',class_name:'Wall',category:'墙',category_id:-2000011,type_id:-1,level_id:2,family_name:null,is_type:false};
  let stop=false;
  const loop=(async()=>{
    while(!stop){
      for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
        const from=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(from,'utf8'));
        await fs.rename(from,path.join(queue,'processing',name));requests.push(request);
        let response;
        if(request.operation!=='status'&&request.args.expected_document!==document.path){
          response={id:request.id,ok:false,hostSession:source.session,error:{code:'DocumentChanged',message:'Caller-selected document is no longer active.'},execution:{started:false,phase:'validation',reason:null},completedUtc:new Date().toISOString()};
        }else{
          dispatched.push(request.operation);
          const value=request.operation==='status'?status():{operation:request.operation,...identity,modifiedByOperation:false,value:request.operation==='get_selection'?{total:1,returned:1,truncated:false,items:[element]}:{items:[{element_id:2,name:'一层',elevation_mm:0,project_elevation_mm:0}]}};
          response={id:request.id,ok:true,result:request.atomicRead?{operation:request.operation,hostSession:source.session,atomicReadSnapshot:true,snapshot:status(),value}:value};
        }
        const output=path.join(queue,'outbox',request.id+'.json');await fs.writeFile(output+'.tmp',JSON.stringify(response));await fs.rename(output+'.tmp',output);
      }
      await new Promise(resolve=>setTimeout(resolve,5));
    }
  })();
  t.after(async()=>{
    stop=true;await loop;
    if(path.dirname(path.resolve(root))!==parent||!path.basename(root).startsWith('buildx-form-source-'))throw new Error('Unexpected owned test directory');
    await fs.rm(root,{recursive:true,force:true});
  });
  const run=(command,sourceDocument)=>invokeReadonlyPanelCommand(command,{}, {root,timeout:1200,...sourceDocument===undefined?{}:{sourceDocument}});
  return {requests,dispatched,run};
}

test('the actual atomic and legacy alias owners enforce source before publishing IDs',async t=>{
  for(const atomic of [true,false])await t.test(atomic?'atomic':'legacy',async t=>{
    const host=await nativeReadHost(t,{atomic});
    for(const command of ['selection','levels']){
      const before=host.requests.length,result=await host.run(command,source);
      assert.equal(result.ok,true,JSON.stringify(result));assert.equal(typeof result.value.data.items[0].element_id,'string');
      const business=host.requests.slice(before).find(request=>request.operation===(command==='selection'?'get_selection':'list_levels'));
      assert.equal(business.args.expected_document,source.path);assert.equal(business.targetSession,source.session);assert.equal(Boolean(business.atomicRead),atomic);
      const count=host.requests.length,dispatched=host.dispatched.length;
      const mismatch=await host.run(command,{...source,path:'D:\\other.rvt'});
      assert.equal(mismatch.ok,false);assert.equal(mismatch.error.outcome,'not_started');
      assert.equal(host.dispatched.slice(dispatched).some(operation=>operation!=='status'),false);
      assert.deepEqual(mismatch.evidence.requestIds,host.requests.slice(count).map(request=>request.id));
      const sourceHostChanged=host.requests.length;
      assert.equal((await host.run(command,{...source,session:'e'.repeat(32)})).error.outcome,'not_started');
      assert.equal(host.requests.length,sourceHostChanged);
    }
  });
});

test('post-read source mismatches remain unknown with their actual queue evidence',async t=>{
  for(const atomic of [true,false])await t.test(atomic?'atomic':'legacy',async t=>{
    const host=await nativeReadHost(t,{atomic}),changedTitle={...source,title:'旧模型标题'};
    const result=await host.run('document',changedTitle);
    assert.equal(result.ok,false);assert.equal(result.error.code,'COMMAND_READ_UNCONFIRMED');assert.equal(result.error.outcome,'unconfirmed');
    assert.deepEqual(host.requests.map(request=>request.operation),['status']);
    assert.deepEqual(result.evidence.requestIds,host.requests.map(request=>request.id));
    const before=host.requests.length,selection=await host.run('selection',changedTitle);
    assert.equal(selection.error.outcome,atomic?'unconfirmed':'not_started');
    assert.deepEqual(selection.evidence.requestIds,host.requests.slice(before).map(request=>request.id));
    assert.equal(host.requests.slice(before).some(request=>request.operation==='get_selection'),atomic);
  });
});
