import fs from 'node:fs';
import {promises as io} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {readGeneratedFileDiagnostic} from './generated-file-diagnostic.mjs';

const createOperation='create_pump_family_artifact',openOperation='open_pump_family_artifact';
const requestIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sessionPattern=/^[a-f0-9]{32}$/;
const maxWireBytes=128*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value),'utf8');
const notStarted=(code)=>({ok:false,outcome:'not_started',code});
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));

function canonicalDirectory(directory){
  const info=fs.lstatSync(directory);
  const actual=fs.realpathSync.native(directory);
  const same=process.platform==='win32'?actual.toLowerCase()===directory.toLowerCase():actual===directory;
  if(!same||!info.isDirectory()||info.isSymbolicLink())throw new Error('Unverified local Revit queue directory');
}

function readWire(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
    if(!opened.isFile()||!named.isFile()||named.isSymbolicLink()||opened.ino!==named.ino||opened.dev!==named.dev||opened.size<1n||opened.size>BigInt(maxWireBytes))throw new Error('Invalid queue file');
    const buffer=Buffer.alloc(Number(opened.size)+1),length=fs.readSync(fd,buffer,0,buffer.length,0);
    const end=fs.fstatSync(fd,{bigint:true});
    if(length!==Number(opened.size)||end.size!==opened.size||end.mtimeNs!==opened.mtimeNs)throw new Error('Queue file changed');
    const bytes=buffer.subarray(0,length);
    return {bytes,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
  }finally{fs.closeSync(fd);}
}

export function createGeneratedFileTransport({workbenchRoot,timeoutMs=120000,pollMs=350,isHostAlive=pid=>{process.kill(pid,0);return true;}}){
  if(!path.isAbsolute(workbenchRoot)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000||!Number.isSafeInteger(pollMs)||pollMs<1)throw new TypeError('Invalid artifact transport options');
  const queue=path.join(workbenchRoot,'queue');
  const inbox=path.join(queue,'inbox'),processing=path.join(queue,'processing'),outbox=path.join(queue,'outbox'),permits=path.join(queue,'pump-approvals');
  async function requestCancellation(requestId,sessionId){
    const directory=path.join(queue,'cancel');
    const temp=path.join(directory,requestId+'.'+randomUUID()+'.tmp');
    let staged=false;
    try{
      canonicalDirectory(queue);
      try{await io.mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
      canonicalDirectory(directory);
      await io.writeFile(temp,json({schema_version:1,request_id:requestId,target_session:sessionId}),{flag:'wx'});
      staged=true;
      await io.link(temp,path.join(directory,requestId+'.json'));
    }catch{/* An unavailable cancellation does not resolve the original result. */}
    finally{if(staged)await io.unlink(temp).catch(()=>{});}
  }
  function inspectHost(){
    try{
      canonicalDirectory(queue);
      const {value}=readWire(path.join(queue,'host.json'));
      if(!plain(value)||!sessionPattern.test(value.sessionId)||!Number.isSafeInteger(value.pid)||value.pid<1||!Number.isFinite(Date.parse(value.startedUtc))||value.pumpFamilyArtifactVersion!==1||!isHostAlive(value.pid))return null;
      return Object.freeze({sessionId:value.sessionId,pid:value.pid,startedUtc:value.startedUtc});
    }catch{return null;}
  }

  function observeOperation(operation,{requestId,parameters,shouldContinue=()=>true}){
    if(!requestIdPattern.test(requestId)||!shouldContinue())return null;
    try{
      canonicalDirectory(queue);canonicalDirectory(processing);canonicalDirectory(outbox);
      const name=requestId+'.json';
      const {value:request,bytes}=readWire(path.join(processing,name));
      if(!plain(request)||request.id!==requestId||request.operation!==operation||!sessionPattern.test(request.targetSession)||!plain(request.args)||Object.keys(request.args).length!==Object.keys(parameters).length||Object.keys(parameters).some(key=>request.args[key]!==parameters[key]))return null;
      const {value:receipt}=readWire(path.join(outbox,name));
      if(!plain(receipt)||receipt.id!==requestId)return null;
      if(receipt.ok===false&&receipt.hostSession===request.targetSession&&receipt.execution?.started===false)return notStarted(receipt.error?.code??'PUMP_NOT_STARTED');
      canonicalDirectory(permits);
      const {value:permit}=readWire(path.join(permits,requestId+'.used'));
      if(permit?.schema_version!==1||permit.request_id!==requestId||permit.target_session!==request.targetSession||permit.request_sha256!==digest(bytes))return null;
      if(receipt.ok!==true||receipt.result?.hostSession!==request.targetSession||receipt.result.operation!==operation)return null;
      const value=receipt.result.value;
      if(value?.success===false&&['not_started','failed','unknown'].includes(value.outcome)){
        const diagnostic=readGeneratedFileDiagnostic(value.diagnostic);
        return {ok:false,outcome:value.outcome,artifactCreated:value.outcome==='unknown'?null:false,code:value.code,...(diagnostic?{diagnostic}:{})};
      }
      return value?.success===true?{ok:true,value}:null;
    }catch{return null;}
  }

  async function invokeOperation(operation,{requestId,parameters,host,shouldContinue}){
    const stillCurrent=()=>{const observed=inspectHost();return shouldContinue()&&host&&observed?.sessionId===host.sessionId&&observed.pid===host.pid&&observed.startedUtc===host.startedUtc;};
    if(!requestIdPattern.test(requestId)||!stillCurrent())return notStarted('PUMP_HOST_CHANGED');
    const deadline=Date.now()+timeoutMs;
    const payload=json({id:requestId,targetSession:host.sessionId,operation,args:parameters,createdUtc:new Date().toISOString(),expiresUtc:new Date(deadline).toISOString()});
    const permit=json({schema_version:1,request_id:requestId,target_session:host.sessionId,request_sha256:digest(payload)});
    const temp=path.join(inbox,requestId+'.tmp');
    let publishing=false;
    try{
      canonicalDirectory(inbox);canonicalDirectory(processing);canonicalDirectory(outbox);
      try{await io.mkdir(permits);}catch(error){if(error.code!=='EEXIST')throw error;}
      canonicalDirectory(permits);
      await io.writeFile(path.join(permits,requestId+'.json'),permit,{flag:'wx'});
      await io.writeFile(temp,payload,{flag:'wx'});
      if(!stillCurrent()||Date.now()>=deadline)return notStarted('PUMP_APPROVAL_NO_LONGER_CURRENT');
      publishing=true;
      await io.link(temp,path.join(inbox,requestId+'.json'));
      // The temp is a non-consumable evidence name. Cleanup cannot determine whether the linked request ran.
      await io.unlink(temp).catch(()=>{});
    }catch{if(!publishing)return notStarted('PUMP_QUEUE_UNAVAILABLE');return null;}
    while(shouldContinue()&&Date.now()<deadline){
      const receipt=observeOperation(operation,{requestId,parameters,shouldContinue});
      if(receipt)return receipt;
      if(!stillCurrent())break;
      await delay(pollMs);
    }
    if(!shouldContinue())await requestCancellation(requestId,host.sessionId);
    return observeOperation(operation,{requestId,parameters,shouldContinue});
  }
  const invoke=options=>invokeOperation(createOperation,options);
  const observe=options=>observeOperation(createOperation,options);
  const open=({file,shouldContinue})=>invokeOperation(openOperation,{requestId:randomUUID(),host:inspectHost(),shouldContinue,
    parameters:{file_name:file.fileName,sha256:file.sha256,bytes:file.bytes}});
  return Object.freeze({inspectHost,invoke,observe,open});
}
