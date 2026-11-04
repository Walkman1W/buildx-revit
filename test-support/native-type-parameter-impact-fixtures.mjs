import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

export const IMPACT_TOOL='revit_get_type_parameter_impact',IMPACT_OPERATION='get_type_parameter_impact';
export const IMPACT_TYPE_ID='9223372036854775806',IMPACT_PARAMETER_ID='-123',IMPACT_SESSION='d'.repeat(32);
export const impactArguments=(patch={})=>({type_id:IMPACT_TYPE_ID,parameter_id:IMPACT_PARAMETER_ID,...patch});
export const impactParameter=(patch={})=>({parameter_id:IMPACT_PARAMETER_ID,name:'类型宽度',storage_type:'Double',is_read_only:false,has_value:true,
  data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:2,value_display:'609.6 mm',...patch});
export const impactValue=(patch={})=>({schema_version:1,type_id:IMPACT_TYPE_ID,type_name:'类型影响中文',parameter:impactParameter(),
  instance_ids:['2','10','9007199254740993'],instance_count:3,
  coverage:{complete:true,scope:'current_document_direct_type_references',scanned_elements:4,indirect_effects:'not_assessed'},write_authorization:'not_granted',...patch});

export async function typeParameterImpactFixture(t,{hostPatch={},respond=true,corrupt,onRequest,produce=()=>impactValue(),failure}={}){
  const temporary=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(temporary,'buildx-type-parameter-impact-'));
  const identity=await fs.lstat(base,{bigint:true}),stage=path.join(base,'program'),root=path.join(stage,'workbench'),queue=path.join(root,'queue');
  const clients=[],owners=new Set(),requests=[],errors=[];let stopped=false,pump,prepared=false;
  t.after(async()=>{
    for(const client of clients)await client.close();stopped=true;if(pump)await pump;for(const owner of owners)await owner.close();
    assert.deepEqual(errors,[],'controlled impact queue peer failed');
    const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});
    assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),temporary);assert.match(path.basename(target),/^buildx-type-parameter-impact-/);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);
    assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());await fs.rm(target,{recursive:true,force:false});
  });
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const capabilities=()=>({atomicReadSnapshot:true,nativeParameterQueriesVersion:1,nativeParameterQueryOperations:[IMPACT_OPERATION]});
  const host={sessionId:IMPACT_SESSION,pid:process.pid,version:'0.8.6',...capabilities(),...hostPatch};
  const document={title:'Controlled type impact preview',path:'',activeViewId:12,activeViewType:'ThreeD',modified:false};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
  const publish=async request=>{
    let envelope;
    if(failure)envelope={id:request.id,hostSession:IMPACT_SESSION,ok:false,...failure,completedUtc:new Date().toISOString()};
    else{
      const result={operation:request.operation,hostSession:IMPACT_SESSION,atomicReadSnapshot:true,
        snapshot:{hostSession:IMPACT_SESSION,hostVersion:host.version,document,capabilities:capabilities()},
        value:{operation:request.operation,hostSession:IMPACT_SESSION,document:{title:document.title,path:document.path},modifiedByOperation:false,value:await produce(request)}};
      corrupt?.(result,request);envelope={id:request.id,ok:true,result,completedUtc:new Date().toISOString()};
    }
    const target=path.join(queue,'outbox',request.id+'.json'),partial=target+'.tmp';await fs.writeFile(partial,JSON.stringify(envelope));await fs.rename(partial,target);
  };
  pump=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(file=>file.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);await fs.rename(path.join(queue,'inbox',filename),processing);
      const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);assert.equal(request.operation,IMPACT_OPERATION,'a preview must not enqueue a write or alternate lookup');
      if(onRequest)await onRequest(request);if(respond)await publish(request);
    }
    await new Promise(resolve=>setTimeout(resolve,3));
  }})().catch(error=>errors.push(String(error)));
  const connect=async()=>{
    if(!prepared){
      const project=fileURLToPath(new URL('../',import.meta.url));await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
      for(const directory of ['lib','public','release','manifests'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
        recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile()&&['.mjs','.js','.json'].includes(path.extname(filename)));},
      });
      await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));prepared=true;
    }
    const stderr=[],transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),'--workspace'],cwd:stage,stderr:'pipe'});
    transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
    const client=new Client({name:'buildx-type-parameter-impact-test',version:'1.0.0'},{capabilities:{}});clients.push(client);await client.connect(transport);
    return {client,stderr};
  };
  return {root,queue,requests,publish,connect,remember:owner=>{if(owner)owners.add(owner);return owner;}};
}
