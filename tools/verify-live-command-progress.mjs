// One explicitly requested, read-only verification against the local service.
// Never retries a command and never sends an AI turn or changes a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const origin='http://127.0.0.1:41873',root=fileURLToPath(new URL('..',import.meta.url));
const client='progress-check-'+randomUUID(),controller=new AbortController();
const deadline=setTimeout(()=>controller.abort(),70000),start=performance.now(),cpu=process.cpuUsage();
const record={scope:'real local BuildX HTTP/SSE and one read-only Revit document command',observedUtc:new Date().toISOString(),command:'document',stages:[],aiInferenceTokens:0,processFamilyCpuAndPeakMemory:'unmeasured'};
const output=path.join(root,'artifacts','async-live-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
let reader;
try{
  const status=await fetch(origin+'/api/status',{signal:controller.signal}).then(response=>response.json());
  if(status.service!=='revit-local-codex'||status.ready!==true||status.busy||status.commandsReady!==true)throw new Error('Local service is not ready and idle; no command was submitted.');
  const response=await fetch(origin+'/api/events?client='+client,{signal:controller.signal});
  if(!response.ok)throw new Error('Event stream was not accepted; no command was submitted.');
  reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  async function next(){
    while(true){const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const payload=block.split('\n').find(line=>line.startsWith('data: '));if(payload)return JSON.parse(payload.slice(6));continue;}
      const chunk=await reader.read();if(chunk.done)throw new Error('Event stream ended.');buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>2000000)throw new Error('Event stream exceeded verification budget.');}
  }
  let initial;do{initial=await next();}while(typeof initial.session?.conversation?.id!=='string');
  const postStart=performance.now();
  const accepted=await fetch(origin+'/api/command',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Chat':status.csrf},body:JSON.stringify({client,conversationId:initial.session.conversation.id,commandId:'document',parameters:{}}),signal:controller.signal});
  const ack=await accepted.json();record.acceptanceMs=performance.now()-postStart;
  if(accepted.status!==202||ack.ok!==true||typeof ack.executionId!=='string')throw new Error('Read-only command was not accepted; it will not be retried.');
  record.executionId=ack.executionId;process.stdout.write(JSON.stringify({stage:'accepted',acceptanceMs:record.acceptanceMs})+'\n');
  while(true){
    const data=await next(),command=data.command;if(command?.executionId!==ack.executionId)continue;
    const stage=command.progress?.phase;
    if(stage&&record.stages.at(-1)?.phase!==stage){const item={phase:stage,elapsedMs:performance.now()-postStart};record.stages.push(item);process.stdout.write(JSON.stringify(item)+'\n');}
    if(['pending','running','stopping'].includes(command.status))continue;
    record.status=command.status;record.errorCode=command.error?.code??null;record.requestIds=command.result?.requestIds??command.requestIds??[];
    record.elapsedMs=performance.now()-postStart;record.ok=command.status==='completed';
    process.stdout.write(JSON.stringify({status:record.status,elapsedMs:record.elapsedMs,errorCode:record.errorCode,requestCount:record.requestIds.length})+'\n');
    if(!record.ok)process.exitCode=1;break;
  }
}catch(error){record.ok=false;record.error=error.name==='AbortError'?'Read-only verification deadline; no retry was made.':error.message;process.stdout.write(JSON.stringify({ok:false,error:record.error})+'\n');process.exitCode=1;}
finally{
  clearTimeout(deadline);controller.abort();if(reader)try{await reader.cancel();}catch{}
  record.totalElapsedMs=performance.now()-start;record.nodeCpuMicros=process.cpuUsage(cpu);record.nodePeakRssKiB=process.resourceUsage().maxRSS;
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(record,null,2)+'\n');
  process.stdout.write(JSON.stringify({output,ok:record.ok,nodeCpuMicros:record.nodeCpuMicros,nodePeakRssKiB:record.nodePeakRssKiB})+'\n');
}
