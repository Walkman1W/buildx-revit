import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {invokeReadonlyPanelCommand,invokeWorkbench} from './lib/workbench-client.mjs';

// Exercise the production transport and original on-disk queue. This peer
// stands in for ExternalEvent only; no Codex process or Revit document is used.
const directory=fileURLToPath(new URL('./workbench/validation/20261026-readonly-command-contract/',import.meta.url));
const session='a'.repeat(32),document={title:'只读样例',path:'D:\\samples\\A01.rvt',activeViewId:12,activeViewType:'FloorPlan',modified:false};
const element=(id=42)=>({element_id:id,name:'墙-01',class_name:'Wall',category:'墙',category_id:-2000011,type_id:-1,level_id:2,family_name:null,is_type:false});
const status=()=>({hostSession:session,hostVersion:'0.3.0',document:{...document}});
function result(request){
  const base={hostSession:session,document:{title:document.title,path:document.path},operation:request.operation};
  if(request.operation==='status')return status();
  if(request.operation==='get_selection')return {...base,value:{total:1,returned:1,truncated:false,items:[element()]}};
  if(request.operation==='list_levels')return {...base,value:{items:[{element_id:2,name:'一层',elevation_mm:0,project_elevation_mm:1200}]}};
  if(request.operation==='search_elements')return {...base,value:{total:1,offset:request.args.offset,limit:request.args.limit,has_more:false,items:request.args.offset===0?[element()]:[]}};
  throw new Error('Unexpected queue operation: '+request.operation);
}
async function peer(t,respond=()=>undefined,{version='0.3.0',timeout=4000}={}){
  await fs.mkdir(directory,{recursive:true});const root=await fs.mkdtemp(path.join(directory,'queue-'));
  const queue=path.join(root,'queue'),requests=[],errors=[];let closed=false;
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version}));
  const work=(async()=>{
    while(!closed){
      for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
        const source=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(source,'utf8'));
        await fs.rename(source,path.join(queue,'processing',name));requests.push(request);
        let response;
        try{response=await respond(request,requests.length,root);if(response===undefined)response={id:request.id,ok:true,result:result(request)};}
        catch(error){errors.push(error);response={id:request.id,ok:false,error:{code:'FIXTURE_FAILURE',message:error.message}};}
        if(response!==null){const target=path.join(queue,'outbox',name);await fs.writeFile(target+'.tmp',JSON.stringify(response));await fs.rename(target+'.tmp',target);}
      }
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  })();
  t.after(async()=>{closed=true;await work;assert.deepEqual(errors,[]);});
  return {root,requests,options:{root,timeout},async run(command,parameters={}){return invokeReadonlyPanelCommand(command,parameters,{root,timeout});}};
}
function succeeded(value){assert.equal(value.ok,true,JSON.stringify(value));return value.value;}
function unconfirmed(value){assert.equal(value.ok,false,JSON.stringify(value));assert.equal(value.error.code,'COMMAND_READ_UNCONFIRMED');assert.equal(value.error.outcome,'unconfirmed');assert.ok(!Object.hasOwn(value,'value'));return value;}

test('document command uses the real local status contract and actual receipt ids only',async t=>{
  const p=await peer(t),value=succeeded(await p.run('document'));
  assert.equal(value.command,'document');assert.equal(value.tool,'revit_workbench_status');assert.equal(value.hostSession,session);
  assert.equal(value.document.path,document.path);assert.equal(value.document.title,document.title);
  assert.deepEqual(p.requests.map(item=>item.operation),['status','status']);
  assert.deepEqual(value.requestIds,p.requests.map(item=>item.id));
  assert.ok(p.requests.every(item=>Object.keys(item.args).length===0));
  assert.ok(!JSON.stringify(value).includes('revit_get_document_info'));
});

test('selection preserves precise ids, signed metadata and explicit coverage',async t=>{
  const p=await peer(t,request=>{
    if(request.operation!=='get_selection')return;
    const value=result(request);value.value={total:3,returned:2,truncated:true,items:[element(42),element('9223372036854775807')]};
    return {id:request.id,ok:true,result:value};
  });
  const value=succeeded(await p.run('selection'));
  assert.deepEqual(p.requests.map(item=>item.operation),['status','get_selection','status']);
  assert.deepEqual(p.requests[1].args,{expected_document:document.path});
  assert.deepEqual(value.data.items.map(item=>item.element_id),['42','9223372036854775807']);
  assert.equal(String(value.data.items[0].category_id),'-2000011');assert.equal(String(value.data.items[0].type_id),'-1');
  assert.equal(value.data.total,3);assert.equal(value.data.returned,2);assert.equal(value.data.truncated,true);
});

test('level command retains actual millimetre elevations',async t=>{
  const p=await peer(t),value=succeeded(await p.run('levels'));
  assert.equal(value.tool,'revit_list_levels');assert.equal(value.operation,'list_levels');
  assert.equal(value.data.items[0].element_id,'2');assert.equal(value.data.items[0].elevation_mm,0);
  assert.equal(value.data.items[0].project_elevation_mm,1200);
});

test('search maps only the four display categories and uses bounded native arguments',async t=>{
  for(const [category,native] of [['all',''],['walls','OST_Walls'],['pipes','OST_PipeCurves'],['equipment','OST_MechanicalEquipment']]){
    await t.test(category,async t=>{
      const p=await peer(t),value=succeeded(await p.run('search',{keyword:'  return doc.Delete(1);  ',category}));
      assert.equal(value.tool,'revit_search_elements');
      assert.deepEqual(p.requests[1].args,{expected_document:document.path,category:native,name_contains:'return doc.Delete(1);',limit:20,offset:0});
      assert.equal(value.data.total,1);assert.equal(value.data.has_more,false);
      assert.ok(p.requests.every(item=>!['execute_csharp','set_parameters'].includes(item.operation)));
    });
  }
});

test('invalid commands and parameters are rejected before the first queue request',async t=>{
  const p=await peer(t);
  for(const [command,parameters] of [
    ['revit_execute_csharp',{}],['__proto__',{}],['selection',{expected_document:'forged.rvt'}],['document',{code:'return 1;'}],
    ['levels',{mode:'commit'}],['selection',[]],['search',null],['search',{category:'OST_Walls'}],['search',{category:'walls',root:'elsewhere'}],
    ['search',{keyword:'x'.repeat(201)}],['search',{limit:201}],['search',{limit:0}],['search',{limit:1.5}],
    ['search',{offset:-1}],['search',{offset:2147483648}],['search',{keyword:1}],['search',{category:'walls',tool:'revit_set_parameters'}],
  ]){
    const value=await p.run(command,parameters);assert.equal(value.ok,false,JSON.stringify([command,parameters,value]));
    assert.equal(value.error.code,'COMMAND_INPUT_INVALID');assert.equal(value.error.outcome,'not_started');
  }
  assert.equal(p.requests.length,0);
});

test('search supports explicit pages and retains empty pages beyond total',async t=>{
  const p=await peer(t,request=>{
    if(request.operation!=='search_elements')return;
    const value=result(request);value.value={total:201,offset:request.args.offset,limit:request.args.limit,has_more:request.args.offset+request.args.limit<201,items:request.args.offset===200?[element(201)]:[]};
    return {id:request.id,ok:true,result:value};
  });
  const last=succeeded(await p.run('search',{category:'pipes',limit:1,offset:200}));
  assert.equal(last.data.offset,200);assert.equal(last.data.limit,1);assert.equal(last.data.items.length,1);assert.equal(last.data.has_more,false);
  const empty=succeeded(await p.run('search',{category:'pipes',limit:200,offset:2147483647}));
  assert.equal(empty.data.items.length,0);assert.equal(empty.data.has_more,false);
});

test('an unsaved document path stays empty and is never guessed',async t=>{
  const p=await peer(t,request=>{const value=result(request);value.document.path='';return {id:request.id,ok:true,result:value};});
  const value=succeeded(await p.run('selection'));assert.equal(value.document.path,'');assert.equal(p.requests[1].args.expected_document,'');
});

test('no current document publishes no success and does not enqueue a query',async t=>{
  const p=await peer(t,request=>({id:request.id,ok:true,result:{...status(),document:null}}));
  const value=await p.run('selection');assert.equal(value.ok,false);assert.equal(value.error.code,'COMMAND_NO_DOCUMENT');assert.equal(value.error.outcome,'not_started');
  assert.deepEqual(p.requests.map(item=>item.operation),['status']);
});

test('read receipt rejects a different host, document, title or operation',async t=>{
  for(const mutation of [value=>value.hostSession='b'.repeat(32),value=>value.document.path='D:\\other.rvt',value=>value.document.title='其他模型',value=>value.operation='execute_csharp']){
    await t.test(mutation.toString(),async t=>{
      const p=await peer(t,request=>{if(request.operation!=='get_selection')return;const value=result(request);mutation(value);return {id:request.id,ok:true,result:value};});
      unconfirmed(await p.run('selection'));assert.equal(p.requests.filter(item=>item.operation==='get_selection').length,1);
    });
  }
});

test('post-read status rejects document, view or host changes',async t=>{
  for(const mutation of [value=>value.hostSession='b'.repeat(32),value=>value.document.path='D:\\other.rvt',value=>value.document.activeViewId=99]){
    await t.test(mutation.toString(),async t=>{
      const p=await peer(t,(request,count)=>{if(count!==3)return;const value=status();mutation(value);return {id:request.id,ok:true,result:value};});
      unconfirmed(await p.run('selection'));assert.equal(p.requests.length,3);
    });
  }
});

test('a replacement host cannot receive the subsequent query or final status',async t=>{
  for(const command of ['document','selection']){
    await t.test(command,async t=>{
      const p=await peer(t,async(request,count,root)=>{
        if(count!==1)return;
        await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:'b'.repeat(32),pid:process.pid,version:'0.3.0'}));
        return {id:request.id,ok:true,result:status()};
      });
      const value=await p.run(command);assert.equal(value.error.code,command==='document'?'COMMAND_READ_UNCONFIRMED':'COMMAND_NOT_STARTED');assert.match(value.error.message,/not queued/);
      assert.deepEqual(p.requests.map(item=>item.operation),['status']);assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);
    });
  }
});

test('malformed selection coverage, duplicate ids and rounded int64 ids fail closed',async t=>{
  for(const mutation of [value=>value.returned=2,value=>value.truncated=true,value=>{value.items=[element(42),element(42)];value.total=value.returned=2;},value=>value.items[0].element_id=9223372036854775807]){
    await t.test(mutation.toString(),async t=>{
      const p=await peer(t,request=>{if(request.operation!=='get_selection')return;const value=result(request);mutation(value.value);return {id:request.id,ok:true,result:value};});
      unconfirmed(await p.run('selection'));
    });
  }
});

test('malformed level elevations and search paging are not successful results',async t=>{
  for(const [command,mutation] of [
    ['levels',value=>value.items[0].elevation_mm=null],['levels',value=>value.items[0].element_id=0],
    ['search',value=>value.offset=1],['search',value=>value.limit=19],['search',value=>value.has_more=true],
  ]){
    await t.test(command+': '+mutation.toString(),async t=>{
      const p=await peer(t,request=>{if(request.operation==='status')return;const value=result(request);mutation(value.value);return {id:request.id,ok:true,result:value};});
      unconfirmed(await p.run(command,command==='search'?{category:'walls'}:{}));
    });
  }
});

test('production read transport rejects invalid envelope completion and retains request evidence',async t=>{
  for(const envelope of [{ok:'yes'}, {id:'different',ok:true}, {ok:true,result:null}]){
    await t.test(JSON.stringify(envelope),async t=>{
      const p=await peer(t,request=>({id:request.id,ok:true,result:status(),...envelope}));
      const value=unconfirmed(await p.run('document'));
      assert.equal(p.requests.length,1);assert.ok(value.evidence.requestIds.includes(p.requests[0].id));
      assert.ok((await fs.stat(path.join(p.root,'queue','outbox',p.requests[0].id+'.json'))).isFile());
    });
  }
});

test('known host failures retain the actual request id without retrying',async t=>{
  const p=await peer(t,request=>({id:request.id,ok:false,error:{code:'DocumentChanged',message:'Query status again; no model operation was run.'},completedUtc:new Date().toISOString()}));
  const value=await p.run('levels');assert.equal(value.error.code,'COMMAND_QUERY_FAILED');assert.equal(value.error.outcome,'failed');assert.equal(value.error.nativeFailure.phase,'unknown');assert.match(value.error.message,/DocumentChanged/);
  assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);assert.equal(p.requests.length,1);
});

test('read transport bounds bytes and UTF-16 serializer size before accepting a result',async t=>{
  for(const payload of ['x'.repeat(3*1024*1024),'x'.repeat(1024*1024)]){
    await t.test(String(payload.length),async t=>{
      const p=await peer(t,request=>({id:request.id,ok:true,result:{...status(),extra:payload}}));
      const value=unconfirmed(await p.run('document'));assert.match(value.error.message,/budget/);
      assert.equal(p.requests.length,1);assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);
    });
  }
});

test('timeout is unconfirmed and preserves the owned queued request without automatic replay',async t=>{
  const timeout=10_000,p=await peer(t,()=>null,{timeout}),now=Date.now;
  // A claimed request may have executed. Expiring before the peer moves the
  // original into processing would test the pre-publication path instead.
  t.mock.method(Date,'now',()=>now()+(p.requests.length?timeout+1:0));
  const value=unconfirmed(await p.run('document'));
  assert.match(value.error.message,/outcome unknown/);assert.equal(p.requests.length,1);
  assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);
  assert.ok((await fs.stat(path.join(p.root,'queue','processing',p.requests[0].id+'.json'))).isFile());
  assert.equal((await fs.readdir(path.join(p.root,'queue','outbox'))).length,0);
});

test('publication failure retains exact request paths without modifying foreign inbox data',async()=>{
  await fs.mkdir(directory,{recursive:true});
  const root=await fs.mkdtemp(path.join(directory,'publication-')),queue=path.join(root,'queue');
  await fs.mkdir(queue);await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.3.0'}));
  await fs.writeFile(path.join(queue,'inbox'),'existing foreign file');
  const value=await invokeReadonlyPanelCommand('document',{}, {root,timeout:40});assert.equal(value.error.code,'COMMAND_NOT_STARTED');assert.equal(value.error.outcome,'not_started');
  assert.equal(value.evidence.requestIds.length,0);const proof=value.evidence.unpublishedRequest,id=proof.requestId;
  assert.equal(proof.requestPath,path.join(queue,'inbox',id+'.json'));
  assert.equal(proof.tempPath,path.join(queue,'inbox',id+'.tmp'));
  assert.equal(proof.responsePath,path.join(queue,'outbox',id+'.json'));
  assert.equal(await fs.readFile(path.join(queue,'inbox'),'utf8'),'existing foreign file');
});

test('cancel after the temporary request was written never publishes it or invents a native receipt',async t=>{
  const p=await peer(t),writeFile=fs.writeFile.bind(fs);let cancelled=false,temporaryPath=null;
  t.mock.method(fs,'writeFile',async(filename,...args)=>{
    const result=await writeFile(filename,...args);
    if(typeof filename==='string'&&path.dirname(filename)===path.join(p.root,'queue','inbox')&&filename.endsWith('.tmp')){temporaryPath=filename;cancelled=true;}
    return result;
  });
  const value=await invokeReadonlyPanelCommand('selection',{}, {...p.options,shouldContinue:()=>!cancelled});
  assert.equal(value.ok,false);assert.equal(value.error.code,'COMMAND_INTERRUPTED');assert.equal(value.error.outcome,'not_started');
  assert.deepEqual(value.evidence.requestIds,[]);assert.equal(p.requests.length,0);
  const proof=value.evidence.unpublishedRequest;assert.ok(proof);assert.equal(proof.tempPath,temporaryPath);
  assert.equal(proof.requestPath,path.join(p.root,'queue','inbox',proof.requestId+'.json'));
  assert.equal(proof.responsePath,path.join(p.root,'queue','outbox',proof.requestId+'.json'));
  const bytes=await fs.readFile(proof.tempPath,'utf8'),request=JSON.parse(bytes);
  assert.equal(request.id,proof.requestId);assert.equal(request.operation,'status');assert.equal(request.targetSession,session);
  assert.deepEqual(await fs.readdir(path.join(p.root,'queue','inbox')),[proof.requestId+'.tmp']);
  assert.deepEqual(await fs.readdir(path.join(p.root,'queue','processing')),[]);assert.deepEqual(await fs.readdir(path.join(p.root,'queue','outbox')),[]);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(p.requests.length,0);assert.equal(await fs.readFile(proof.tempPath,'utf8'),bytes);
});

test('old hosts reject newer native reads before enqueueing those reads',async t=>{
  const p=await peer(t,()=>undefined,{version:'0.2.0'}),value=await p.run('levels');assert.equal(value.error.code,'COMMAND_NOT_STARTED');assert.equal(value.error.outcome,'not_started');
  assert.match(value.error.message,/未入队/);assert.deepEqual(p.requests.map(item=>item.operation),['status']);
});

test('existing raw native-read API still returns the original receipt and supports unsaved paths',async t=>{
  const p=await peer(t),value=await invokeWorkbench('revit_get_selection',{expected_document:''},p.options);
  assert.equal(value.operation,'get_selection');assert.equal(value.request_id,p.requests[0].id);
  assert.deepEqual(p.requests[0].args,{expected_document:''});
});

test('typed host rejection preserves proven request outcomes without parsing error words',async t=>{
  for(const [name,code,execution,expected] of [
    ['expired','WORKBENCH_REQUEST_EXPIRED',{started:false,phase:'validation',reason:'expired'},'COMMAND_REQUEST_EXPIRED'],
    ['validation','InvalidOperationException',{started:false,phase:'validation',reason:null},'COMMAND_NOT_STARTED'],
    ['dispatch','ReadFailed',{started:true,phase:'dispatch',reason:null},'COMMAND_QUERY_FAILED'],
    ['legacy-expiry-words','InvalidOperationException',undefined,'COMMAND_QUERY_FAILED']
  ])await t.test(name,async t=>{
    const p=await peer(t,request=>({id:request.id,ok:false,...execution?{hostSession:session,execution}:{},error:{code,message:'Request expired before execution; no operation was run.'},completedUtc:new Date().toISOString()}));
    const value=await p.run('levels');assert.equal(value.error.code,expected);assert.equal(value.error.nativeFailure.code,code);assert.equal(value.error.nativeFailure.phase,execution?.phase??'unknown');assert.equal(value.error.nativeFailure.requestId,p.requests[0].id);assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);assert.equal(p.requests.length,1);assert.equal(value.value,undefined);
  });
});

test('malformed failure packets and contradictory execution facts remain unconfirmed',async t=>{
  for(const mutation of [
    response=>delete response.completedUtc,response=>response.completedUtc='not-a-date',response=>response.completedUtc='1',response=>response.completedUtc='2026-02-31T00:00:00Z',response=>response.error.code='',
    response=>response.hostSession='b'.repeat(32),response=>response.execution.started=true,response=>response.execution.reason='guessed',
    response=>response.error.code='ReadFailed',response=>delete response.execution,response=>response.execution.extra='not part of contract'
  ])await t.test(mutation.toString(),async t=>{
    const p=await peer(t,request=>{const response={id:request.id,ok:false,hostSession:session,error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'expired'},execution:{started:false,phase:'validation',reason:'expired'},completedUtc:new Date().toISOString()};mutation(response);return response;});
    unconfirmed(await p.run('levels'));assert.equal(p.requests.length,1);
  });
});

test('postflight rejection keeps the overall read unconfirmed and retains exact native failure facts',async t=>{
  const p=await peer(t,(request,count)=>count===3?{id:request.id,ok:false,hostSession:session,error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'late status rejected'},execution:{started:false,phase:'validation',reason:'expired'},completedUtc:new Date().toISOString()}:undefined);
  const value=unconfirmed(await p.run('selection'));assert.equal(value.error.stage,'postflight');assert.equal(value.error.nativeFailure.outcome,'expired');assert.equal(value.error.nativeFailure.started,false);assert.deepEqual(value.evidence.requestIds,p.requests.map(request=>request.id));assert.equal(p.requests.length,3);
});

test('document status already read is not described as unexecuted when stopped before final verification',async t=>{
  const p=await peer(t);const value=unconfirmed(await invokeReadonlyPanelCommand('document',{}, {...p.options,shouldContinue:()=>p.requests.length===0}));assert.equal(value.error.stage,'postflight');assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);assert.equal(p.requests.length,1);
});

test('partial tmp write is known unpublished while an ambiguous rename remains unknown',async t=>{
  await t.test('partial tmp',async t=>{
    const p=await peer(t),original=fs.writeFile.bind(fs);t.mock.method(fs,'writeFile',async(file,...args)=>{await original(file,...args);if(path.dirname(file)===path.join(p.root,'queue','inbox')&&file.endsWith('.tmp'))throw new Error('controlled failed write acknowledgement');});
    const value=await p.run('document');assert.equal(value.error.code,'COMMAND_NOT_STARTED');assert.equal(value.error.outcome,'not_started');assert.equal(p.requests.length,0);assert.deepEqual(value.evidence.requestIds,[]);assert.ok((await fs.stat(value.evidence.unpublishedRequest.tempPath)).isFile());
  });
  await t.test('rename completed before error',async t=>{
    const p=await peer(t),original=fs.rename.bind(fs);t.mock.method(fs,'rename',async(source,target)=>{await original(source,target);if(path.dirname(source)===path.join(p.root,'queue','inbox')&&source.endsWith('.tmp'))throw new Error('controlled unknown rename acknowledgement');});
    const value=unconfirmed(await p.run('document'));assert.equal(value.evidence.unconfirmedRequest.phase,'publication');await new Promise(resolve=>setTimeout(resolve,35));assert.equal(p.requests.length,1);assert.deepEqual(value.evidence.requestIds,[p.requests[0].id]);
  });
});
