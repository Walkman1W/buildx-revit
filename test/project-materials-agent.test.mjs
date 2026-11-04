import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeProjectAgentTool,PROJECT_AGENT_TOOLS} from '../lib/project-agent-bridge.mjs';

test('library text paging binds subsequent reads to the same content and stays within output budget',async()=>{
  let text='\u0001'.repeat(15000),current=true;
  const service={readFile:async()=>({ok:true,value:{name:'fixture.txt',path:'fixture.txt',text}})};
  const context={isCurrent:()=>current,materials:{service,isCurrent:()=>current}};
  const first=await invokeProjectAgentTool('buildx_materials_read',{rootId:'root',path:'fixture.txt'},context);
  assert.equal(first.ok,true);assert.equal(first.value.nextOffset,8000);assert.ok(Buffer.byteLength(JSON.stringify(first))<60*1024);
  const second=await invokeProjectAgentTool('buildx_materials_read',{rootId:'root',path:'fixture.txt',offset:first.value.nextOffset,sha256:first.value.sha256},context);assert.equal(second.ok,true);
  text+='changed';const changed=await invokeProjectAgentTool('buildx_materials_read',{rootId:'root',path:'fixture.txt',offset:first.value.nextOffset,sha256:first.value.sha256},context);assert.equal(changed.error.code,'PROJECT_SOURCE_CHANGED');
  current=false;assert.equal((await invokeProjectAgentTool('buildx_materials_read',{rootId:'root',path:'fixture.txt'},context)).ok,false);
});

test('library image previews do not leak into text-only tool replies and directory cursors are forwarded',async()=>{
  let parameters;const service={readFile:async()=>({ok:true,value:{kind:'image',data:'private-image-bytes'}}),listChildren:async args=>{parameters=args;return {ok:true,value:{entries:[],nextCursor:null}};}};
  const context={isCurrent:()=>true,materials:{service,isCurrent:()=>true}};
  const image=await invokeProjectAgentTool('buildx_materials_read',{rootId:'root',path:'photo.png'},context);assert.equal(image.ok,false);assert.equal(JSON.stringify(image).includes('private-image-bytes'),false);
  assert.equal((await invokeProjectAgentTool('buildx_materials_list',{rootId:'root',path:'sub',cursor:'cursor'},context)).ok,true);assert.deepEqual(parameters,{rootId:'root',path:'sub',cursor:'cursor'});
  assert.equal(PROJECT_AGENT_TOOLS.some(item=>item.name.startsWith('buildx_viewer_')),false);
});
