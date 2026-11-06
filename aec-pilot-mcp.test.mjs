import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const project=path.dirname(fileURLToPath(import.meta.url));
const artifacts=path.join(project,'artifacts');
const session='b'.repeat(32);
const document={title:'AEC pilot MCP fixture',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
const baseOperations=['health','get_document_info','list_views','get_element_parameters','get_elements_by_type','get_element_geometry'];
const sheetId='9007199254740993';
const sheet={sheet_number:'A101',sheet_name:'首层平面',is_placeholder:false,viewport_count:1};

function page(items,{offset=0,limit=100}={}){
  return {schema_version:1,items:items.slice(offset,offset+limit),offset,limit,total:items.length,
    has_more:offset+limit<items.length,coverage:{scanned:items.length,complete:true,stop_reason:null}};
}

const pageArgs={offset:0,limit:1};
const warning={failure_definition_id:'01234567-89ab-cdef-0123-456789abcdef',severity:'Warning',
  description:'Model warning fixture',failing_element_ids:['9',sheetId],additional_element_ids:['25']};
const placement={id:'20',type_id:sheetId,name:'Repeated placement',is_loaded:false,
  transform:{origin_feet:[2,-3,4],basis_x:[0,1,0],basis_y:[-1,0,0],basis_z:[0,0,1]}};
const wave2Operations=new Set(['get_warnings','get_rvt_links','get_link_instances']);
const calls=[
  {operation:'list_sheets',args:pageArgs,value:page([{id:sheetId,...sheet},
    {id:'42',sheet_number:'A102',sheet_name:'Placeholder',is_placeholder:true,viewport_count:0}],pageArgs)},
  {operation:'get_sheet_info',args:{sheet_id:sheetId},value:{schema_version:1,sheet_id:sheetId,...sheet,
    viewports:[{viewport_id:'20',view_id:'12',view_name:'首层'}],parameters:[{parameter_id:'-1007401',name:'Sheet Number',
      storage_type:'String',is_read_only:false,has_value:true,data_type:'autodesk.spec.aec:string.text-2.0.0',
      unit_type:null,value_internal:'A101',value_display:'A101'}]}},
  {operation:'list_titleblocks',args:{},value:page([{id:'32',family_name:'A1',type_name:'横向',full_name:'A1 : 横向'}])},
  {operation:'get_categories',args:{},value:page([{id:'-2000011',name:'墙',built_in_category:'OST_Walls'}])},
  {operation:'get_worksets',args:{},value:{...page([{id:'41',name:'Workset1',is_open:true}]),is_workshared:true}},
  {operation:'get_phases',args:{},value:page([{id:'0',name:'既有'},{id:'51',name:'新建'}])},
  {operation:'get_phase_filters',args:{},value:page([{id:'52',name:'Show All'}])},
  {operation:'get_design_options',args:{},value:page([{id:'61',name:'Option A',set_id:'60'}])},
  {operation:'list_shared_parameters',args:{},value:page([{id:'71',name:'Asset ID',
    guid:'01234567-89ab-cdef-0123-456789abcdef',definition_group:null}])},
  {operation:'list_project_parameters',args:{},value:page([{id:'72',name:'Cost Center',parameter_type:'autodesk.spec.aec:string.text-2.0.0'}])},
  {operation:'get_warnings',args:{offset:1,limit:2},value:page([warning,warning,warning],{offset:1,limit:2})},
  {operation:'get_rvt_links',args:{},value:page([{id:sheetId,name:'Coordination.rvt',is_loaded:false,is_nested:true}])},
  {operation:'get_link_instances',args:{},value:page([placement,{...placement,id:'21',transform:null}])},
  {operation:'calculate_material_quantities',args:{category:'Walls',fields:['name']},value:{...page([{material_id:sheetId,name:'Concrete',volume_cubic_feet:12}]),category:'OST_Walls',element_count:2,includes_paint:false}},
  {operation:'check_clashes',args:{category1:'Walls',category2:'Doors'},value:{...page([{element1_id:'21',element2_id:sheetId}]),category1:'OST_Walls',category2:'OST_Doors',tolerance_feet:0.01,method:'expanded_axis_aligned_bounding_box',solid_intersection_tested:false,element_count1:2,element_count2:1,missing_box_count1:1,missing_box_count2:0,pairs_checked:1}},
].map(call=>({...call,name:'revit_'+call.operation}));
const byOperation=new Map(calls.map(call=>[call.operation,call]));
const drawingCalls=[
  {operation:'get_revision_sequences',args:pageArgs,value:page([
    {id:sheetId,name:'修订一',date:'',description:null,sequence:1,issued:false},
    {id:'22',name:'修订二',date:'2026-11-06',description:'签发',sequence:2,issued:true}],pageArgs)},
  {operation:'get_schedule_data',args:{schedule_id:sheetId,row_offset:1,row_limit:1,column_offset:2,column_limit:1},value:{
    schema_version:1,schedule_id:sheetId,schedule_name:'设备明细表',section:'body',first_row:2,first_column:1,
    row_count:6,column_count:150,row_offset:1,row_limit:1,column_offset:2,column_limit:1,has_more:true,has_more_columns:true,
    rows:[{row_index:3,cells:[{column_index:3,text:'水泵'}]}],coverage:{scanned:1,complete:true,stop_reason:null}}}
].map(call=>({...call,name:'revit_'+call.operation}));
const pumpNetwork={operation:'get_pipe_network',name:'revit_get_pipe_network',args:{start_element_id:sheetId,max_hops:3},value:{
  schema_version:1,root_element_id:sheetId,max_hops:3,boundary_reached:true,
  nodes:[{id:sheetId,unique_id:'sample-pump',name:'Water pump',kind:'root',hop:0},
    {id:'31',unique_id:'sample-pipe',name:'Pipe',kind:'pipe',hop:1},
    {id:'32',unique_id:'sample-valve',name:'Valve',kind:'valve',hop:2},
    {id:'33',unique_id:'sample-equipment',name:'Other equipment',kind:'equipment_boundary',hop:3}],
  edges:[{from_element_id:sheetId,from_connector_id:0,to_element_id:'31',to_connector_id:0},
    {from_element_id:'31',from_connector_id:1,to_element_id:'32',to_connector_id:0},
    {from_element_id:'32',from_connector_id:1,to_element_id:'33',to_connector_id:0}]
}};
const groupMembers={operation:'get_group_members',name:'revit_get_group_members',
  args:{group_id:sheetId,offset:1,limit:1,fields:['name','category','type_id']},
  value:{...page([{id:'7',name:'first',category:null,type_id:null},{id:'8',name:null,
    category:{id:'-2000011',name:'墙',built_in_category:'OST_Walls'},type_id:sheetId}],{offset:1,limit:1}),group_id:sheetId}};

// Use the unchanged MCP entry, SDK and real filesystem queue. A controlled peer
// supplies all model data, so these timings describe transport only.
async function fixture(t,{olderHost=false,missingOperations=new Set(),extraCalls=[],corrupt}={}){
  await fs.mkdir(artifacts,{recursive:true});
  const stage=await fs.mkdtemp(path.join(artifacts,'aec-pilot-mcp-'));
  const queue=path.join(stage,'workbench','queue');
  const inbox=path.join(queue,'inbox');
  const processing=path.join(queue,'processing');
  const outbox=path.join(queue,'outbox');
  const requests=new Map(),stderr=[];
  let client,pump,stopped=false;
  t.after(async()=>{
    try{if(client)await client.close();}
    finally{
      stopped=true;
      try{if(pump)await pump;}
      finally{
        const [resolved,artifactRoot]=await Promise.all([fs.realpath(stage),fs.realpath(artifacts)]);
        assert.equal(path.dirname(resolved),artifactRoot);
        assert.ok(path.basename(resolved).startsWith('aec-pilot-mcp-'));
        await fs.rm(resolved,{recursive:true,force:true});
      }
    }
  });

  await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
  for(const directory of ['lib','public','release'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
    recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return entry.isDirectory()||entry.isFile()&&['.mjs','.json'].includes(path.extname(filename));}
  });
  await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));
  await Promise.all([inbox,processing,outbox].map(directory=>fs.mkdir(directory,{recursive:true})));
  const version='0.8.8';
  const descriptors=new Map([...byOperation,...extraCalls.map(call=>[call.operation,call])]);
  const capabilities={atomicReadSnapshot:true,nativeModelQueriesVersion:1,
    nativeModelQueryOperations:olderHost?baseOperations:[...baseOperations,...[...descriptors.keys()].filter(op=>!missingOperations.has(op))]};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version,...capabilities}));
  pump=(async()=>{
    while(!stopped){
      for(const filename of await fs.readdir(inbox)){
        if(!filename.endsWith('.json'))continue;
        const claimed=path.join(processing,filename);
        await fs.rename(path.join(inbox,filename),claimed);
        const started=performance.now();
        const request=JSON.parse(await fs.readFile(claimed,'utf8'));
        const descriptor=descriptors.get(request.operation);
        assert.ok(descriptor,'unexpected operation reached the controlled queue');
        assert.equal(request.atomicRead,true);
        assert.equal(request.targetSession,session);
        assert.equal(filename,request.id+'.json');
        assert.ok(!requests.has(request.id),'duplicate request ID');
        const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,
          snapshot:{hostSession:session,hostVersion:version,document,capabilities:structuredClone(capabilities)},
          value:{operation:request.operation,hostSession:session,document:{title:document.title,path:document.path},
            modifiedByOperation:false,value:structuredClone(descriptor.value)}};
        corrupt?.(result,descriptor);
        const temp=path.join(outbox,filename+'.tmp');
        await fs.writeFile(temp,JSON.stringify({id:request.id,ok:true,result,completedUtc:new Date().toISOString()}));
        requests.set(request.id,{request,peerMs:performance.now()-started});
        await fs.rename(temp,path.join(outbox,filename));
      }
      await delay(4);
    }
  })();
  // Attach a handler immediately. The cleanup hook still propagates a failure.
  pump.catch(()=>{});

  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),'--workspace'],cwd:stage,stderr:'pipe'});
  transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
  client=new Client({name:'buildx-aec-pilot-verification',version:'1.0.0'},{capabilities:{}});
  await client.connect(transport);
  return {client,inbox,requests,stderr};
}

function toolCall(client,descriptor){
  return client.callTool({name:descriptor.name,arguments:descriptor.args},{timeout:7000});
}

async function measuredCall(f,descriptor){
  const start=performance.now();
  const result=await toolCall(f.client,descriptor);
  const roundTripMs=performance.now()-start;
  assert.equal(result.isError,false,JSON.stringify(result));
  const value=result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text),value);
  assert.deepEqual(value.value,descriptor.value,descriptor.name);
  assert.equal(value.operation,descriptor.operation);
  assert.equal(value.hostSession,session);
  assert.equal(value.modifiedByOperation,false);
  assert.equal(value.document.title,document.title);
  assert.equal(value.snapshot.document.title,document.title);
  const accepted=f.requests.get(value.request_id);
  assert.ok(accepted,'returned receipt does not match a published request');
  assert.equal(accepted.request.operation,descriptor.operation);
  for(const [field,argument] of Object.entries(descriptor.args))assert.deepEqual(accepted.request.args[field],argument);
  return {roundTripMs,peerMs:accepted.peerMs};
}

function metrics(samples){
  const ordered=samples.slice().sort((a,b)=>a-b);
  const percentile=fraction=>Number(ordered[Math.ceil(ordered.length*fraction)-1].toFixed(2));
  return {samples:ordered.length,p50:percentile(0.5),p95:percentile(0.95),max:percentile(1)};
}

test('BuildX workspace publishes the AEC pilot and wave 2 read contracts and repeatedly reads them through the MCP queue',async t=>{
  const f=await fixture(t);
  const listed=await f.client.listTools();
  assert.equal(calls.length,15);
  for(const descriptor of calls){
    const matches=listed.tools.filter(tool=>tool.name===descriptor.name);
    assert.equal(matches.length,1,descriptor.name);
    assert.equal(matches[0].annotations.readOnlyHint,true,descriptor.name);
    assert.ok(matches[0].outputSchema,descriptor.name);
    await measuredCall(f,descriptor);
  }
  const sequential=[],parallel=[];
  for(let round=0;round<5;round++){
    for(const descriptor of calls)sequential.push(await measuredCall(f,descriptor));
  }
  for(let wave=0;wave<2;wave++)parallel.push(...await Promise.all(calls.map(descriptor=>measuredCall(f,descriptor))));
  assert.equal(f.requests.size,8*calls.length);
  for(const invalid of [{name:'revit_get_sheet_info',args:{sheet_id:'9223372036854775808'}},
    {name:'revit_list_sheets',args:{limit:201}},{name:'revit_get_warnings',args:{offset:-1}},
    {name:'revit_get_link_instances',args:{include_contents:true}}]){
    const result=await toolCall(f.client,invalid);
    assert.equal(result.isError,true,invalid.name);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'not_started',invalid.name);
  }
  assert.equal(f.requests.size,8*calls.length);
  assert.deepEqual(await fs.readdir(f.inbox),[]);
  assert.deepEqual(f.stderr,[]);
  t.diagnostic(JSON.stringify({scope:'Installed MCP SDK and production stdio/atomic file queue; controlled peer, no Revit execution',
    units:'ms',warmup:calls.length,passed:f.requests.size,failed:0,
    sequentialRoundTrip:metrics(sequential.map(sample=>sample.roundTripMs)),
    concurrentRoundTrip:metrics(parallel.map(sample=>sample.roundTripMs)),
    controlledPeerBeforePublish:metrics([...sequential,...parallel].map(sample=>sample.peerMs))}));
});

test('an installed pre-pilot host refuses all pilot tools before publishing a queue request',async t=>{
  const f=await fixture(t,{olderHost:true});
  await f.client.listTools();
  for(const descriptor of calls){
    const result=await toolCall(f.client,descriptor);
    assert.equal(result.isError,true,descriptor.name);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'not_started',descriptor.name);
  }
  assert.equal(f.requests.size,0);
  assert.deepEqual(await fs.readdir(f.inbox),[]);
});

test('drawing reads retain exact capability and return only the requested page of the original schedule',async t=>{
  const f=await fixture(t,{extraCalls:drawingCalls});
  const listed=await f.client.listTools();
  for(const descriptor of drawingCalls){
    assert.ok(listed.tools.some(tool=>tool.name===descriptor.name&&tool.outputSchema&&tool.annotations.readOnlyHint));
    await measuredCall(f,descriptor);
  }
  const unavailable=await fixture(t,{extraCalls:drawingCalls,missingOperations:new Set(['get_schedule_data'])});
  const blocked=await toolCall(unavailable.client,drawingCalls[1]);
  assert.equal(blocked.isError,true);assert.equal(unavailable.requests.size,0);
  const invalid=await toolCall(f.client,{name:'revit_get_schedule_data',args:{schedule_id:sheetId,column_limit:101}});
  assert.equal(invalid.isError,true);assert.equal(f.requests.size,2);
});

test('an installed first-wave host can still read phases and refuses all three new operations before enqueueing',async t=>{
  const f=await fixture(t,{missingOperations:wave2Operations});
  await measuredCall(f,byOperation.get('get_phases'));
  for(const operation of wave2Operations){
    const result=await toolCall(f.client,byOperation.get(operation));
    assert.equal(result.isError,true,operation);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'not_started',operation);
  }
  assert.equal(f.requests.size,1);
  assert.deepEqual(await fs.readdir(f.inbox),[]);
});

test('the pump network can be queried through the normal workspace MCP read path',async t=>{
  const f=await fixture(t,{extraCalls:[pumpNetwork]});
  const catalog=await f.client.listTools();
  const tool=catalog.tools.find(tool=>tool.name===pumpNetwork.name);
  assert.equal(tool.annotations.readOnlyHint,true);
  await measuredCall(f,pumpNetwork);
  assert.equal(f.requests.size,1);
});

test('group members are published as an atomic paginated read with exact IDs and reject invalid inputs',async t=>{
  const f=await fixture(t,{extraCalls:[groupMembers]});
  const tool=(await f.client.listTools()).tools.find(tool=>tool.name===groupMembers.name);
  assert.ok(tool?.outputSchema);assert.equal(tool.annotations.readOnlyHint,true);
  await measuredCall(f,groupMembers);
  for(const args of [{group_id:'0'},{group_id:'9223372036854775808'},
    {group_id:sheetId,offset:-1},{group_id:sheetId,limit:201},
    {group_id:sheetId,fields:['name','name']},{group_id:sheetId,fields:['invalid']}]){
    const result=await toolCall(f.client,{name:groupMembers.name,args});
    assert.equal(result.isError,true,JSON.stringify(args));
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'not_started');
  }
  assert.equal(f.requests.size,1);assert.deepEqual(await fs.readdir(f.inbox),[]);
  const older=await fixture(t,{extraCalls:[groupMembers],olderHost:true});
  const rejected=await toolCall(older.client,groupMembers);
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.buildxToolOutcome.outcome,'not_started');
  assert.equal(older.requests.size,0);
});

test('group member response with an unrequested property remains unconfirmed',async t=>{
  const call={...groupMembers,args:{group_id:sheetId},value:{...page([{id:'8',name:'unexpected'}]),group_id:sheetId}};
  const f=await fixture(t,{extraCalls:[call]});
  const result=await toolCall(f.client,call);
  assert.equal(result.isError,true);assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
  assert.equal(f.requests.size,1);
});

test('the pump network rejects an inconsistent hop reported by the host and preserves the original receipt',async t=>{
  const f=await fixture(t,{extraCalls:[pumpNetwork],corrupt:result=>{result.value.value.nodes[2].hop=1;}});
  const result=await toolCall(f.client,pumpNetwork);
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
  assert.equal(f.requests.size,1);
});

test('malformed, forged and mismatched pilot successes stay unconfirmed without republishing',async t=>{
  const corruptions={
    list_sheets:result=>{result.value.value.coverage.complete=false;},
    get_sheet_info:result=>{result.value.value.sheet_id='43';},
    get_categories:result=>{result.value.document.path='D:\\forged.rvt';},
    get_worksets:result=>{result.value.hostSession='f'.repeat(32);},
    get_warnings:result=>{result.value.value.items[0].failing_element_ids.reverse();},
    get_rvt_links:result=>{result.value.value.items[0].path='C:\\redacted.rvt';},
    get_link_instances:result=>{result.value.value.items[0].transform.basis_x.pop();},
  };
  const f=await fixture(t,{corrupt:(result,descriptor)=>corruptions[descriptor.operation]?.(result)});
  await f.client.listTools();
  for(const descriptor of calls.filter(call=>Object.hasOwn(corruptions,call.operation))){
    const before=f.requests.size;
    const result=await toolCall(f.client,descriptor);
    assert.equal(result.isError,true,descriptor.name);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed',descriptor.name);
    assert.equal(f.requests.size,before+1,descriptor.name);
  }
});
