import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PROJECT_AGENT_TOOLS,invokeProjectAgentTool} from '../lib/project-agent-bridge.mjs';
import {createProjectKnowledge} from '../lib/project-knowledge.mjs';

const hash='a'.repeat(64), hash2='b'.repeat(64);
function fixture(){
  let active=true,owned=true,files=[{path:'spec.txt',status:'indexed',sha256:hash}],runs=0,after=null;
  const service={refresh:async()=>{runs++;if(after)await after(runs);return {ok:true};},list:()=>({ok:true,value:{projectId:'p',files,coverage:{complete:true},refreshing:false}}),
    search:()=>({ok:true,value:{matches:[{path:'spec.txt',sha256:hash,snippet:'source'}]}}),
    read:()=>({ok:true,value:{lines:['source']}}),table:()=>({ok:true,value:{sum:3}})};
  const context={isCurrent:()=>active,knowledge:{service,isCurrent:()=>owned}};
  return {context,service,stop:()=>{active=false;},unbind:()=>{owned=false;},change:()=>{files=[{path:'spec.txt',status:'indexed',sha256:hash2}];},after:fn=>{after=fn;}};
}
test('only named bounded tools are offered; caller cannot select a directory',async()=>{
  assert.deepEqual(PROJECT_AGENT_TOOLS.map(tool=>tool.name),['buildx_project_search','buildx_project_read','buildx_project_table','buildx_materials_list','buildx_materials_read']);
  assert.ok(Object.isFrozen(PROJECT_AGENT_TOOLS));
  const f=fixture();
  assert.equal((await invokeProjectAgentTool('buildx_project_search',{query:'x',rootPath:'C:/secret'},f.context)).error.code,'INVALID_PROJECT_TOOL_INPUT');
  assert.equal((await invokeProjectAgentTool('buildx_project_bind',{},f.context)).error.code,'INVALID_PROJECT_TOOL_INPUT');
  assert.equal((await invokeProjectAgentTool('buildx_project_search',{query:'x'},f.context)).ok,true);
  for(const name of ['buildx_viewer_refresh','buildx_viewer_status','buildx_viewer_locate'])assert.equal((await invokeProjectAgentTool(name,{},f.context)).error.code,'INVALID_PROJECT_TOOL_INPUT');
});
test('reject historical version and source changed during result production',async()=>{
  const f=fixture();
  assert.equal((await invokeProjectAgentTool('buildx_project_read',{path:'spec.txt',sha256:hash2},f.context)).error.code,'PROJECT_VERSION_UNAVAILABLE');
  f.after(n=>{if(n===3)f.change();});
  assert.equal((await invokeProjectAgentTool('buildx_project_read',{path:'spec.txt',sha256:hash},f.context)).error.code,'PROJECT_SOURCE_CHANGED');
});
test('drop results after turn/account/binding changes, including after async work',async()=>{
  const f=fixture();f.after(()=>f.stop());
  assert.equal((await invokeProjectAgentTool('buildx_project_search',{query:'x'},f.context)).error.code,'PROJECT_CONTEXT_CHANGED');
  const g=fixture();g.service.read=async()=>{g.unbind();return {ok:true,value:{secret:'old'}};};
  const result=await invokeProjectAgentTool('buildx_project_read',{path:'spec.txt',sha256:hash},g.context);
  assert.equal(result.error.code,'PROJECT_CONTEXT_CHANGED');assert.equal(JSON.stringify(result).includes('old'),false);
});
test('unknown source state and arbitrary service errors fail closed',async()=>{
  const f=fixture();f.service.list=()=>({ok:true,value:{files:[],coverage:{complete:false},refreshing:false}});
  assert.equal((await invokeProjectAgentTool('buildx_project_search',{query:'x'},f.context)).error.code,'PROJECT_SOURCE_UNAVAILABLE');
  f.service.refresh=()=>{throw new Error('private credential');};
  assert.equal(JSON.stringify(await invokeProjectAgentTool('buildx_project_search',{query:'x'},f.context)).includes('private credential'),false);
});
test('dynamic response budget counts UTF-8 bytes before returning content',async()=>{
  const f=fixture();f.service.search=()=>({ok:true,value:{text:'字'.repeat(21000)}});
  const result=await invokeProjectAgentTool('buildx_project_search',{query:'x'},f.context);
  assert.equal(result.error.code,'PROJECT_RESULT_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<60*1024);
});
test('real project service search and version replacement remain bound to selected directory',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'buildx-agent-bridge-'));
  try{
    const file=path.join(directory,'design.txt');await writeFile(file,'first design version');
    const created=createProjectKnowledge({projectId:'test',rootPath:directory});assert.equal(created.ok,true);
    const owner={service:created.value,isCurrent:()=>true},context={isCurrent:()=>true,knowledge:owner};
    const search=await invokeProjectAgentTool('buildx_project_search',{query:'design'},context);
    assert.equal(search.ok,true);const old=search.value.matches[0].sha256;
    assert.equal((await invokeProjectAgentTool('buildx_project_read',{path:'design.txt',sha256:old},context)).ok,true);
    await writeFile(file,'replacement design with a different size');
    const previous=await invokeProjectAgentTool('buildx_project_read',{path:'design.txt',sha256:old},context);
    assert.equal(previous.ok,true);assert.equal(previous.value.historical,true);assert.match(JSON.stringify(previous.value),/first design version/);
    const latest=await invokeProjectAgentTool('buildx_project_search',{query:'replacement'},context);
    assert.equal(latest.ok,true);assert.notEqual(latest.value.matches[0].sha256,old);
  }finally{await rm(directory,{recursive:true,force:true});}
});

