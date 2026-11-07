import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

export const WRITE_TOOL='revit_set_parameter_value',WRITE_OPERATION='set_parameter_value';
export const SOURCE_DOCUMENT=Object.freeze({session:'c'.repeat(32),title:'Parameter write fixture',path:'D:\\controlled\\parameter-write.rvt'});
export const writeState=(patch={})=>({storage_type:'Double',has_value:true,value_internal:1,data_type:'autodesk.spec.aec:length-2.0.0',...patch});
export const writeChange=(patch={})=>({element_id:'9007199254740993',parameter_id:'-123',value:2,value_unit:'internal',expected_state:writeState(),...patch});
export const writeArguments=(patch={})=>({expected_document:SOURCE_DOCUMENT.path,changes:[writeChange()],...patch});
export function writeValue(args){
  const change=args.changes[0],before=structuredClone(change.expected_state);
  return {schema_version:1,target_kind:'instance',before,result:{updated_count:1,changes:[{
    element_id:BigInt(change.element_id).toString(),parameter_id:BigInt(change.parameter_id).toString(),storage_type:before.storage_type,
    data_type:before.data_type,changed:before.value_internal!==change.value,before_internal:before.value_internal,after_internal:change.value,
  }]}};
}
export function writeEnvelope(request,{value=writeValue(request.args),failure}={}){
  const stamp=new Date().toISOString(),mode=request.args.mode??'rollback';
  return {id:request.id,...failure?{hostSession:SOURCE_DOCUMENT.session}:{},ok:!failure,completedUtc:stamp,
    timing:{schemaVersion:1,requestId:request.id,hostSession:SOURCE_DOCUMENT.session,schedulerCorrelation:'unmatched',executeEnteredUtc:stamp,claimedUtc:stamp,responsePreparedUtc:stamp,
      observedUtc:null,raiseReturnedUtc:null,dispatchStartedUtc:stamp,dispatchFinishedUtc:stamp,observedToExecuteMs:null,dispatchMs:0,validationMs:0,hostWorkMs:0,raiseResult:null},
    ...failure?{error:failure.error,execution:failure.execution}:{result:{operation:WRITE_OPERATION,mode,committed:mode==='commit',document:SOURCE_DOCUMENT.title,value,note:'Controlled queue peer; no model is accessed.'}},
  };
}

// No live host, account, configuration or models enter this tree. Only the
// production Node modules and the isolated queue peer cross the real boundary.
export async function singleParameterWriteFixture(t,{hostPatch={},respond=true,corrupt,onRequest,failure,produce=writeValue,respondEnvelope,operations=[WRITE_OPERATION]}={}){
  const temporary=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(temporary,'buildx-single-parameter-write-'));
  const identity=await fs.lstat(base,{bigint:true}),nonce=randomUUID(),stage=path.join(base,'program'),root=path.join(stage,'workbench'),queue=path.join(root,'queue');
  const owners=new Set(),clients=[],requests=[],errors=[];let stopped=false,pump,prepared=false;
  await fs.writeFile(path.join(base,'owner.json'),JSON.stringify({nonce}),{flag:'wx'});
  t.after(async()=>{
    for(const client of clients)await client.close();stopped=true;if(pump)await pump;
    for(const owner of owners)if(typeof owner?.close==='function')await owner.close();
    assert.deepEqual(errors,[],'controlled write queue peer failed');
    const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});
    assert.ok(path.isAbsolute(target));assert.equal(path.dirname(target),temporary);assert.match(path.basename(target),/^buildx-single-parameter-write-/);
    assert.ok(current.isDirectory()&&!current.isSymbolicLink());assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[identity.dev,identity.ino,identity.birthtimeNs]);
    assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());assert.equal(JSON.parse(await fs.readFile(path.join(target,'owner.json'),'utf8')).nonce,nonce);
    await fs.rm(target,{recursive:true,force:false});
  });
  for(const child of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,child),{recursive:true});
  const host={sessionId:SOURCE_DOCUMENT.session,pid:process.pid,version:'0.8.5',nativeParameterWritesVersion:1,nativeParameterWriteOperations:[WRITE_OPERATION],...hostPatch};
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify(host));
  const publish=async request=>{
    const envelope=respondEnvelope?await respondEnvelope(request):writeEnvelope(request,{value:await produce(request.args),failure});if(corrupt)corrupt(envelope,request);
    const target=path.join(queue,'outbox',request.id+'.json'),partial=target+'.tmp';await fs.writeFile(partial,JSON.stringify(envelope));await fs.rename(partial,target);
  };
  pump=(async()=>{while(!stopped){
    for(const filename of (await fs.readdir(path.join(queue,'inbox'))).filter(file=>file.endsWith('.json'))){
      const processing=path.join(queue,'processing',filename);await fs.rename(path.join(queue,'inbox',filename),processing);
      const request=JSON.parse(await fs.readFile(processing,'utf8'));requests.push(request);assert.ok(operations.includes(request.operation),'no fallback write or script may be queued');
      if(onRequest)await onRequest(request);if(respond)await publish(request);
    }
    await new Promise(resolve=>setTimeout(resolve,3));
  }})().catch(error=>errors.push(String(error)));
  const remember=owner=>{if(owner)owners.add(owner);return owner;};
  const options=(extra={})=>({root,timeout:3000,expectedHostSession:SOURCE_DOCUMENT.session,sourceDocument:SOURCE_DOCUMENT,retainReceiptOwner:true,shouldContinue:()=>true,...extra});
  const connect=async(flags=[])=>{
    if(!prepared){
      const project=fileURLToPath(new URL('../',import.meta.url));
      await fs.copyFile(path.join(project,'workbench-mcp.mjs'),path.join(stage,'workbench-mcp.mjs'));
      for(const directory of ['lib','public','release','manifests'])await fs.cp(path.join(project,directory),path.join(stage,directory),{
        recursive:true,filter:async filename=>{const entry=await fs.lstat(filename);return !entry.isSymbolicLink()&&(entry.isDirectory()||entry.isFile()&&['.mjs','.js','.json'].includes(path.extname(filename)));},
      });
      await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({private:true,type:'module'}));prepared=true;
    }
    const stderr=[],transport=new StdioClientTransport({command:process.execPath,args:[path.join(stage,'workbench-mcp.mjs'),...flags],cwd:stage,stderr:'pipe'});
    transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
    const client=new Client({name:'buildx-native-single-parameter-write-test',version:'1.0.0'},{capabilities:{}});clients.push(client);await client.connect(transport);
    return {client,stderr};
  };
  return {root,queue,requests,publish,remember,options,connect};
}
