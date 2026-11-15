import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {NATIVE_MODEL_QUERY_NAMES,NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,MODEL_PREPARATION_QUERY_NAME,MODEL_PREPARATION_OPERATION,ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL,PROJECT_BINDING_PREVIEW_NAME,PROJECT_BINDING_PREVIEW_OPERATION} from '../lib/native-model-queries.mjs';

// Exercise the unchanged production stdio entry and transport with the installed
// MCP SDK. Only the queue's Revit peer and business DTOs are controlled here;
// this is not evidence of a loaded plugin or real-model API execution.
const project=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const artifacts=path.join(project,'artifacts');
const session='b'.repeat(32);
const document={title:'MCP native query fixture',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
const elementId='9007199254740993';
const level={id:'31',name:'L1'};
const measurement={value:1000,unit:'mm'};
const calls=[
  {name:'revit_health',args:{},value:{schema_version:1,status:'ready',document_open:true}},
  {name:'revit_get_document_info',args:{},value:{schema_version:1,title:document.title,path:'',is_family_document:false,is_read_only:false,is_modified:false,active_view:{id:'12',name:'3D',view_type:'ThreeD',is_template:false}}},
  {name:'revit_list_views',args:{offset:0,limit:2},value:{schema_version:1,items:[{id:'12',name:'3D',view_type:'ThreeD',is_template:false},{id:'13',name:'L1',view_type:'FloorPlan',is_template:false}],offset:0,limit:2,total:2,has_more:false,coverage:{scanned:2,complete:true,stop_reason:null}}},
  {name:'revit_get_element_parameters',args:{element_id:elementId},value:{schema_version:1,element_id:elementId,element_name:'Wall',parameters:[{parameter_id:'-1001001',name:'Length',storage_type:'Double',is_read_only:false,has_value:true,data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:3.280839895,value_display:'1000 mm'}]}},
  {name:'revit_get_elements_by_type',args:{category:'Walls',type_id:'12',level_id:'31',fields:['name','category','type_id','level','length'],limit:2},value:{schema_version:1,items:[{id:elementId,name:'Wall',category:{id:'-2000011',name:'Walls',built_in_category:'OST_Walls'},type_id:'12',level,length:measurement}],offset:0,limit:2,total:1,has_more:false,coverage:{scanned:3,complete:true,stop_reason:null}}},
  {name:'revit_get_element_geometry',args:{element_id:elementId},value:{schema_version:1,element_id:elementId,representation:'summary_no_mesh',coordinate_system:'revit_internal',location:{kind:'point',point_mm:{x:0,y:0,z:0}},bounding_box:{min_mm:{x:0,y:0,z:0},max_mm:{x:1000,y:200,z:3000}},level,length:measurement,area:null,volume:null,unavailable:{location:null,bounding_box:null,level:null,length:null,area:'not_applicable',volume:'not_applicable'}}}
];
const preparation={name:MODEL_PREPARATION_QUERY_NAME,args:{expected_document:''},value:{
  schema_version:1,document:calls[1].value,selection_ids:[elementId],
  levels:[{element_id:'31',name:'L1',elevation_mm:-100,project_elevation_mm:0}]
}};

const previewDocument={...document,path:'D:\\samples\\synthetic.rvt'};
const preview={name:PROJECT_BINDING_PREVIEW_NAME,args:{expected_document:previewDocument.path,definition_guid:'d6c25563-54cb-43e7-8003-e7cf8df36916',definition_id:'45',data_type:'text',category_ids:['-2000011']},value:{schema_version:1,definition_guid:'d6c25563-54cb-43e7-8003-e7cf8df36916',definition_id:'45',data_type:'text',definition_name:'Test',document_title:previewDocument.title,document_path:previewDocument.path,binding_before:'unbound',proposed_binding:'instance',category_ids:['-2000011'],instance_count:1,instances:[{element_id:'9007199254740993',category_id:'-2000011',unique_id:'synthetic'}],offset:0,limit:50,snapshot_id:'a'.repeat(64),has_more:false,coverage:'complete_current_document_instances',future_instances_affected:true,authorization:'not_granted',host_session_bound:false,human_decision:false,binding_attempted:false,external_file_accessed:false}};

async function fixture(t,{corrupt,hostPatch={},noDocument=false,includePreparation=false,includePreview=false}={}){
  await fs.mkdir(artifacts,{recursive:true});
  const stage=await fs.mkdtemp(path.join(artifacts,'native-six-mcp-'));
  const queue=path.join(stage,'workbench','queue');
  const clients=[],requests=[],errors=[];
  let stopped=false,pump;
  t.after(async()=>{
    for(const client of clients)await client.close();
    stopped=true;if(pump)await pump;
    assert.deepEqual(errors,[],'controlled queue peer failed');
    const resolved=path.resolve(stage);
    assert.equal(path.dirname(resolved),path.resolve(artifacts));
    assert.ok(path.basename(resolved).startsWith('native-six-mcp-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  // Keep relative production module paths intact without placing a fake host in
  // the real project's workbench or copying user state, binaries or old queues.
  await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
  for(const directory of ['lib','public','release'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
    recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return entry.isDirectory()||entry.isFile()&&['.mjs','.json'].includes(path.extname(filename));}
  });
  await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));
  for(const directory of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,directory),{recursive:true});
  const operations=Object.values(NATIVE_MODEL_QUERY_OPERATION_BY_TOOL);
  if(includePreparation)operations.push(MODEL_PREPARATION_OPERATION);
  if(includePreview)operations.push(PROJECT_BINDING_PREVIEW_OPERATION);
  const identity={sessionId:session,pid:process.pid,version:'0.8.1',atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:operations,...includePreview?{projectBindingPreviewVersion:1}:{},...hostPatch};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(identity));
  pump=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);
      await fs.rename(path.join(queue,'inbox',filename),processing);
      const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);
      const descriptor=[...calls,...(includePreparation?[preparation]:[]),...(includePreview?[preview]:[])].find(item=>ALL_NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[item.name]===request.operation);
      assert.ok(descriptor,'unexpected operation reached the controlled queue');
      const current=noDocument?null:includePreview?previewDocument:document;
      const body=noDocument?{schema_version:1,status:'no_document',document_open:false}:structuredClone(descriptor.value);
      const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,
        snapshot:{hostSession:session,hostVersion:identity.version,document:current,capabilities:{atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:operations,...includePreview?{projectBindingPreviewVersion:1}:{}}},
        value:{operation:request.operation,hostSession:session,document:current===null?null:{title:current.title,path:current.path},modifiedByOperation:false,value:body}};
      corrupt?.(result,descriptor);
      const temporary=path.join(queue,'outbox',filename+'.tmp');
      await fs.writeFile(temporary,JSON.stringify({id:request.id,ok:true,result,completedUtc:new Date().toISOString()}));
      await fs.rename(temporary,path.join(queue,'outbox',filename));
    }
    await new Promise(resolve=>setTimeout(resolve,4));
  }})().catch(error=>errors.push(String(error)));
  const connect=async mode=>{
    const stderr=[];
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),...mode],cwd:stage,stderr:'pipe'});
    transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
    const client=new Client({name:'buildx-native-six-verification',version:'1.0.0'},{capabilities:{}});clients.push(client);
    await client.connect(transport);
    return {client,stderr};
  };
  const entry=await fs.readFile(path.join(stage,'workbench-mcp.mjs'));
  t.diagnostic('production entry sha256='+createHash('sha256').update(entry).digest('hex')+'; installed MCP client 2.3.1; controlled queue peer');
  return {connect,requests,queue};
}

test('installed MCP client validates all six production workspace outputs and preserves exact values',async t=>{
  const f=await fixture(t),{client,stderr}=await f.connect(['--workspace']);
  const listed=await client.listTools();
  for(const name of NATIVE_MODEL_QUERY_NAMES){
    const matches=listed.tools.filter(tool=>tool.name===name);
    assert.equal(matches.length,1,name);assert.ok(matches[0].outputSchema,name);
    assert.equal(matches[0].annotations.readOnlyHint,true,name);
  }
  for(const descriptor of calls)await t.test(descriptor.name,async()=>{
    // listTools populated the SDK cache; callTool now performs outputSchema
    // validation rather than merely accepting a syntactically valid JSON frame.
    const result=await client.callTool({name:descriptor.name,arguments:descriptor.args},{timeout:7000});
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    assert.deepEqual(result.structuredContent.value,descriptor.value);
    assert.equal(result.structuredContent.operation,NATIVE_MODEL_QUERY_OPERATION_BY_TOOL[descriptor.name]);
    assert.equal(result.structuredContent.modifiedByOperation,false);
    assert.equal(result.structuredContent.hostSession,session);
    assert.equal(result.structuredContent.snapshot.document.title,document.title);
    assert.equal(result.structuredContent.request_id,f.requests.at(-1).id);
    assert.equal(f.requests.at(-1).atomicRead,true);
  });
  assert.equal(f.requests.length,6);assert.deepEqual(stderr,[]);
});

test('model preparation uses one named workspace MCP request and fails closed on old capability or drift',async t=>{
  const ready=await fixture(t,{includePreparation:true});
  const {client}=await ready.connect(['--workspace']);
  const listed=await client.listTools();
  const tool=listed.tools.find(item=>item.name===MODEL_PREPARATION_QUERY_NAME);
  assert.equal(tool.annotations.readOnlyHint,true);assert.ok(tool.outputSchema);
  const args={name:MODEL_PREPARATION_QUERY_NAME,arguments:preparation.args};
  const result=await client.callTool(args,{timeout:7000});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.deepEqual(result.structuredContent.value,preparation.value);
  assert.equal(result.structuredContent.request_id,ready.requests[0].id);
  assert.equal(ready.requests[0].atomicRead,true);assert.equal(ready.requests.length,1);
  const legacy=(await ready.connect([])).client;
  assert.ok(!(await legacy.listTools()).tools.some(item=>item.name===MODEL_PREPARATION_QUERY_NAME));

  const old=await fixture(t), oldClient=(await old.connect(['--workspace'])).client;
  assert.equal((await oldClient.callTool(args,{timeout:7000})).structuredContent.buildxToolOutcome.outcome,'not_started');
  assert.equal(old.requests.length,0);
  for(const corrupt of [
    value=>{value.value.value.document.active_view.id='13';},
    value=>{value.value.value.document.title='Other document';},
    value=>{value.value.value.selection_ids=['9223372036854775808'];},
  ]){
    const drift=await fixture(t,{includePreparation:true,corrupt}), driftClient=(await drift.connect(['--workspace'])).client;
    const failed=await driftClient.callTool(args,{timeout:7000});
    assert.equal(failed.isError,true);
    assert.equal(failed.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
    assert.equal(drift.requests.length,1);
  }
});

test('each malformed native success is returned as unconfirmed through MCP without a second request',async t=>{
  const corruptions={
    revit_health:result=>{result.value.value.document_open=false;},
    revit_get_document_info:result=>{result.value.value.title='Different document';},
    revit_list_views:result=>{result.value.value.coverage.complete=false;},
    revit_get_element_parameters:result=>{result.value.value.element_id='41';},
    revit_get_elements_by_type:result=>{result.value.value.items[0].type_id='13';},
    revit_get_element_geometry:result=>{result.value.value.length.unit='ft';}
  };
  const f=await fixture(t,{corrupt:(result,descriptor)=>corruptions[descriptor.name](result)});
  const {client}=await f.connect(['--workspace']);await client.listTools();
  for(const descriptor of calls){
    const before=f.requests.length;
    const result=await client.callTool({name:descriptor.name,arguments:descriptor.args},{timeout:7000});
    assert.equal(result.isError,true,descriptor.name);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'unconfirmed',descriptor.name);
    assert.equal(f.requests.length,before+1,descriptor.name);
  }
});

test('production MCP entry refuses all six native operations on an old host before queue publication',async t=>{
  const f=await fixture(t,{hostPatch:{version:'0.8.0'}}),{client}=await f.connect(['--workspace']);
  await client.listTools();
  for(const descriptor of calls){
    const result=await client.callTool({name:descriptor.name,arguments:descriptor.args},{timeout:7000});
    assert.equal(result.isError,true,descriptor.name);
    assert.equal(result.structuredContent.buildxToolOutcome.outcome,'not_started',descriptor.name);
  }
  assert.equal(f.requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.queue,'inbox')),[]);
});

test('production native health supports no active document and keeps explicit document binding fail-closed',async t=>{
  const f=await fixture(t,{noDocument:true}),{client}=await f.connect(['--workspace']);
  await client.listTools();
  const result=await client.callTool({name:'revit_health',arguments:{}},{timeout:7000});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.structuredContent.document,null);
  assert.equal(result.structuredContent.snapshot.document,null);
  assert.deepEqual(result.structuredContent.value,{schema_version:1,status:'no_document',document_open:false});
  const selected=await client.callTool({name:'revit_health',arguments:{expected_document:''}},{timeout:7000});
  assert.equal(selected.isError,true);
  assert.equal(selected.structuredContent.buildxToolOutcome.outcome,'unconfirmed');
  assert.equal(f.requests.length,2);
});

test('project binding preview is a named read over the installed MCP transport',async t=>{
 const f=await fixture(t,{includePreview:true}),{client}=await f.connect(['--workspace']);
 const listed=await client.listTools();assert.equal(listed.tools.find(x=>x.name===PROJECT_BINDING_PREVIEW_NAME)?.annotations.readOnlyHint,true);
 const result=await client.callTool({name:preview.name,arguments:preview.args},{timeout:7000});
 assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(result.structuredContent.value,preview.value);assert.equal(f.requests.length,1);assert.equal(f.requests[0].atomicRead,true);
});
