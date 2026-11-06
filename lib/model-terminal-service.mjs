import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const maxStreamBytes=8192;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const plain=value=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=(code,message)=>Object.assign(new Error(message),{terminalCode:code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const activeStatus=new Set(['starting','running','stop_requested']);

export const MODEL_TERMINAL_TOOL=Object.freeze({
  type:'function',
  name:'buildx_terminal_run',
  description:'Run an explicitly requested PowerShell or Python script in a new isolated local working directory. Requires the user to enable Terminal in this conversation with Full access and Automatic apply. Files produced here do not roll back with Revit. Use the named Revit tools for all model operations. Never repeat a request with an unconfirmed result.',
  inputSchema:Object.freeze({type:'object',properties:Object.freeze({
    interpreter:Object.freeze({type:'string',enum:Object.freeze(['powershell','python'])}),
    script:Object.freeze({type:'string',minLength:1,maxLength:16000}),
    timeout_ms:Object.freeze({type:'integer',minimum:1000,maximum:120000})}),
    required:Object.freeze(['interpreter','script']),additionalProperties:false})
});

function argumentsOf(value){
  if(!plain(value)||Reflect.ownKeys(value).some(key=>!['interpreter','script','timeout_ms'].includes(key)||
     !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))||!['powershell','python'].includes(value.interpreter)||
     typeof value.script!=='string'||!value.script.trim()||value.script.includes('\0')||value.script.length>16000||
     Buffer.byteLength(value.script)>32000||value.timeout_ms!==undefined&&
     (!Number.isSafeInteger(value.timeout_ms)||value.timeout_ms<1000||value.timeout_ms>120000)){
    throw fail('TERMINAL_ARGUMENTS_INVALID','终端只接受 PowerShell 或 Python、脚本正文和可选的执行时限。');
  }
  return {interpreter:value.interpreter,script:value.script,timeoutMs:value.timeout_ms??30000};
}

async function ordinary(file,kind){
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||!(kind==='directory'?stat.isDirectory():stat.isFile()))throw Error('Unexpected terminal path type');
  const real=await fs.realpath(file);
  if(process.platform==='win32'?real.toLowerCase()!==path.resolve(file).toLowerCase():real!==path.resolve(file))throw Error('Unexpected terminal path identity');
  return real;
}

async function directory(parent,name){
  const target=path.join(parent,name);
  try{await fs.mkdir(target);}catch(e){if(e.code!=='EEXIST')throw e;}
  return ordinary(target,'directory');
}

function makeStream(){
  return {decoder:new StringDecoder('utf8'),text:'',bytes:0,truncated:false};
}

const powershellWrapper=`param([Parameter(Mandatory=$true)][string]$ScriptFile)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$global:LASTEXITCODE = 0
try {
    New-PSDrive -Name BuildX -PSProvider FileSystem -Root $PSScriptRoot -ErrorAction Stop | Out-Null
    Set-Location -LiteralPath 'BuildX:\\' -ErrorAction Stop
    & $ScriptFile
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.ToString())
    exit 1
}
`;

export function createModelTerminalService({dataRoot,workRoot,helperPath,pythonExecutable,powershellExecutable,spawnHelper=spawn}={}){
  if(!path.isAbsolute(dataRoot??'')||!path.isAbsolute(workRoot??''))throw new TypeError('Terminal requires trusted receipt and work roots');
  const helperReady=process.platform==='win32'&&path.isAbsolute(helperPath??'');
  const root=path.resolve(dataRoot),runtimes={powershell:powershellExecutable,python:pythonExecutable};
  const jobs=new Map(),running=new Map(),starting=new Set();
  const restored=new Map();
  let closing=false;

  function scopeKey(scope){
    if(!plain(scope)||typeof scope.account!=='string'||!scope.account||scope.account.length>640||!uuid.test(scope.conversationId??''))
      throw fail('TERMINAL_SCOPE_INVALID','当前对话身份未核实。');
    return hash(JSON.stringify([scope.account,scope.conversationId]));
  }
  const publicRecord=({callKey: _callKey,...record})=>structuredClone(record);
  const view=job=>publicRecord(job.record);
  const notify=job=>{try{job.onUpdate?.(view(job));}catch{}};
  function publish(job){
    if(job.publishTimer)return;
    job.publishTimer=setTimeout(()=>{
      job.publishTimer=null;notify(job);
      if(Date.now()-job.lastCheckpoint>650){job.lastCheckpoint=Date.now();void persist(job).catch(()=>{});}
    },120);
    job.publishTimer.unref?.();
  }
  async function storage(key){
    await ordinary(root,'directory');
    const terminal=await directory(root,'terminal');
    const records=await directory(terminal,'receipts');
    const parent=await ordinary(path.dirname(workRoot),'directory');
    const work=await directory(parent,path.basename(workRoot));
    return {receipts:await directory(records,key),work};
  }
  function persist(job){
    const data=JSON.stringify(job.record)+'\n';
    job.disk=job.disk.catch(()=>{}).then(async()=>{
      await ordinary(path.dirname(job.file),'directory');
      const temp=path.join(path.dirname(job.file),`.${job.record.requestId}-${randomUUID()}.tmp`);
      await fs.writeFile(temp,data,{flag:'wx'});
      await fs.rename(temp,job.file);
    });
    return job.disk;
  }
  async function readStored(key,requestId){
    if(!uuid.test(requestId??''))return null;
    const file=path.join(root,'terminal','receipts',key,requestId+'.json');
    try{
      await ordinary(file,'file');
      if((await fs.stat(file)).size>155000)return null;
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      if(!plain(data)||data.requestId!==requestId||!['powershell','python'].includes(data.interpreter))return null;
      if(activeStatus.has(data.status)||data.status==='unconfirmed'){
        const result=await readProof(path.join(path.dirname(file),requestId+'.result.json'));
        if(result.exitConfirmed)return {...data,...result,finishedAt:data.finishedAt??null,
          message:'已核对原进程树终态。服务中断前未保存的输出无法恢复。'};
        return {...data,status:'unconfirmed',exitConfirmed:false,exitCode:null,
          message:'服务重新连接后无法证明原进程树已经退出。保留原请求，请勿重跑。'};
      }
      return data;
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function availability(){
    if(!helperReady)return {available:false,reason:'当前环境没有经过核实的 Windows 隔离执行器。'};
    try{await ordinary(helperPath,'file');}catch{return {available:false,reason:'缺少 BuildX Windows 隔离执行器。'};}
    return {available:true};
  }

  function append(job,name,chunk){
    const stream=job[name];
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    const keep=Math.min(buffer.length,Math.max(0,maxStreamBytes-stream.bytes));
    if(keep){stream.text+=stream.decoder.write(buffer.subarray(0,keep));stream.bytes+=keep;}
    const justTruncated=keep<buffer.length&&!stream.truncated;
    if(justTruncated)stream.truncated=true;
    if(!keep&&!justTruncated)return;
    job.record[name]=stream.text;
    job.record[name+'Truncated']=stream.truncated;
    publish(job);
  }
  function requestStop(job,reason){
    if(!activeStatus.has(job.record.status)||job.record.stopReason)return false;
    job.record.status='stop_requested';job.record.stopReason=reason;job.record.stopRequestedAt=new Date().toISOString();
    void persist(job).catch(()=>{});notify(job);
    if(job.child?.stdin&&!job.child.stdin.destroyed)job.child.stdin.write('stop\n',()=>{});
    return true;
  }
  function resultOf(proof){
    const verified=proof?.schemaVersion===1&&proof.protocol==='buildx-terminal-win32/1'&&proof.exitConfirmed===true;
    const contained=proof?.containment?.appContainer===true&&proof.containment.zeroNetworkCapabilities===true&&
      proof.containment.jobObject===true&&proof.containment.activeProcesses===0;
    if(verified&&proof.started===false&&proof.exitCode===null)
      return {status:'not_started',exitCode:null,exitConfirmed:true,interpreterStarted:false,
        message:proof.code==='cancelled_before_start'?'已确认在解释器启动前停止。':'隔离环境或解释器未能启动。',
        runnerCode:typeof proof.code==='string'?proof.code.slice(0,80):null,nativeCode:Number.isInteger(proof.nativeCode)?proof.nativeCode:null};
    if(!verified||proof.started!==true||!contained||!Number.isInteger(proof.exitCode))
      return {status:'unconfirmed',exitCode:null,exitConfirmed:false,message:'隔离执行器没有返回可验证的整棵进程树退出回执。'};
    const reason=proof.stopReason==='timeout'?'timed_out':['cancelled','output_disconnected'].includes(proof.stopReason)?proof.stopReason:null;
    const outcome=reason==='timed_out'?'timed_out':reason?'cancelled':proof.exitCode===0?'completed':'failed';
    return {status:'exited',outcome,exitCode:proof.exitCode,exitConfirmed:true,interpreterStarted:true,...reason?{stopReason:reason}:{},
      containment:'windows-appcontainer-job',outputComplete:proof.outputComplete===true,
      ...proof.outputComplete!==true?{message:'进程树已退出，执行器报告部分输出未完整送达。'}:{}};
  }
  async function readProof(file){
    try{
      await ordinary(file,'file');
      if((await fs.stat(file)).size>16384)throw Error('Terminal proof exceeded budget');
      return resultOf(JSON.parse(await fs.readFile(file,'utf8')));
    }catch{return resultOf(null);}
  }

  async function execute(job,interpreter,isCurrent){
    try{
      if(job.record.stopReason||closing||!isCurrent())return {status:'not_started',exitCode:null,exitConfirmed:true};
      const scriptFile=path.join(job.record.cwd,job.record.interpreter==='powershell'?'script.ps1':'script.py');
      const isPowerShell=job.record.interpreter==='powershell';
      await fs.writeFile(scriptFile,(isPowerShell?'\ufeff':'')+job.record.script,{flag:'wx'});
      let argv;
      if(isPowerShell){
        const wrapper=path.join(job.record.cwd,'run-script.ps1');
        await fs.writeFile(wrapper,'\ufeff'+powershellWrapper,{flag:'wx'});
        argv=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,scriptFile];
      }else argv=['-I','-u','-X','utf8',scriptFile];
      if(job.record.stopReason||closing||!isCurrent())return {status:'not_started',exitCode:null,exitConfirmed:true};
      const child=spawnHelper(helperPath,[job.record.cwd,String(job.record.timeoutMs),job.proof,interpreter,...argv],{
        cwd:path.dirname(helperPath),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']
      });
      job.child=child;
      child.stdin.on('error',()=>{});
      child.stdout.on('data',chunk=>append(job,'stdout',chunk));
      child.stderr.on('data',chunk=>append(job,'stderr',chunk));
      let launchFailed=false;
      child.on('error',()=>{launchFailed=true;});
      child.once('spawn',()=>{
        if(!job.record.stopReason){job.record.status='running';job.record.runnerStartedAt=new Date().toISOString();void persist(job).catch(()=>{});notify(job);}
        else child.stdin.write('stop\n',()=>{});
      });
      const invalidated=setInterval(()=>{if(closing||!isCurrent())requestStop(job,'scope_changed');},300);
      invalidated.unref?.();
      try{await new Promise(resolve=>child.once('close',resolve));}finally{clearInterval(invalidated);}
      if(launchFailed&&child.pid===undefined)return {status:'not_started',exitCode:null,exitConfirmed:true,message:'Windows 隔离执行器未启动。'};
      const result=await readProof(job.proof);
      if(job.record.stopReason==='timed_out'&&result.outcome==='cancelled')return {...result,outcome:'timed_out',stopReason:'timed_out'};
      return result;
    }catch{
      return job.child?resultOf(null):{status:'not_started',exitCode:null,exitConfirmed:true,message:'终端工作目录或解释器无法核实。'};
    }
  }

  async function start({scope,args,isCurrent,onUpdate,callId}={}){
    const key=scopeKey(scope),input=argumentsOf(args);
    if(closing||typeof isCurrent!=='function'||!isCurrent())throw fail('TERMINAL_DENIED','当前对话未授权终端。');
    if(typeof callId!=='string'||!callId||callId.length>300)throw fail('TERMINAL_ARGUMENTS_INVALID','缺少原工具调用身份。');
    if(starting.has(key)||running.size||starting.size)throw fail('TERMINAL_BUSY','已有终端请求在运行或等待退出。');
    starting.add(key);
    try{
      const capability=await availability();if(!capability.available)throw fail('TERMINAL_UNAVAILABLE',capability.reason);
      const interpreter=runtimes[input.interpreter];
      try{if(!path.isAbsolute(interpreter??''))throw Error();await ordinary(interpreter,'file');}
      catch{throw fail('TERMINAL_INTERPRETER_MISSING','找不到已配置的 '+(input.interpreter==='python'?'Python':'PowerShell')+'，未执行。');}
      const disk=await storage(key);
      const callKey=hash(callId);
      const records=(await fs.readdir(disk.receipts)).filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json'));
      if(records.length>=512)throw fail('TERMINAL_RECEIPT_LIMIT','本对话终端回执已达上限，已有记录已保留。');
      for(const name of records){
        const prior=await readStored(key,name.slice(0,-5));
        if(prior?.callKey===callKey)throw fail('TERMINAL_DUPLICATE','原工具请求已存在，请核对原回执。');
        if(prior?.status==='unconfirmed'||!prior)throw fail('TERMINAL_UNCONFIRMED','此对话有未核实的终端回执，请先核对原请求。');
      }
      if(closing||!isCurrent())throw fail('TERMINAL_DENIED','访问范围或执行方式已变化，终端未启动。');
      const requestId=randomUUID(),cwd=await directory(disk.work,requestId);
      const job={key,file:path.join(disk.receipts,requestId+'.json'),proof:path.join(disk.receipts,requestId+'.result.json'),
        disk:Promise.resolve(),stdout:makeStream(),stderr:makeStream(),onUpdate,child:null,lastCheckpoint:Date.now(),
        record:{requestId,callKey,...input,cwd,status:'starting',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,
          exitCode:null,exitConfirmed:false,requestedAt:new Date().toISOString()}};
      await persist(job);
      jobs.set(key,job);running.set(key,job);notify(job);
      let watchdog,unconfirmedTimer;
      const bounded=new Promise(resolve=>{
        watchdog=setTimeout(()=>{
          requestStop(job,'timed_out');
          unconfirmedTimer=setTimeout(()=>{
            Object.assign(job.record,resultOf(null));void persist(job).catch(()=>{});notify(job);resolve(view(job));
          },10000);
        // The Windows helper applies the exact script deadline after resume.
        // Allow time for AppContainer setup and staging an installed Python.
        },input.timeoutMs+30000);
      });
      job.settled=execute(job,interpreter,isCurrent).then(async result=>{
        clearTimeout(watchdog);clearTimeout(unconfirmedTimer);
        for(const key of ['stdout','stderr'])if(!job[key].truncated)job.record[key]+=job[key].decoder.end();
        clearTimeout(job.publishTimer);
        Object.assign(job.record,result,{finishedAt:new Date().toISOString()});
        try{await persist(job);}catch{Object.assign(job.record,{status:'unconfirmed',exitConfirmed:false,exitCode:null,message:'终端回执保存未确认。'});}
        running.delete(job.key);notify(job);return view(job);
      });
      job.done=Promise.race([job.settled,bounded]);
      return {requestId,done:job.done};
    }finally{starting.delete(key);}
  }
  function latest(scope){const key=scopeKey(scope),job=jobs.get(key);return job?view(job):restored.get(key)??null;}
  async function restoreLatest(scope){
    const key=scopeKey(scope);
    if(jobs.has(key)||restored.has(key))return latest(scope);
    const dir=path.join(root,'terminal','receipts',key);
    try{
      await ordinary(dir,'directory');
      const names=(await fs.readdir(dir)).filter(name=>name.endsWith('.json')&&uuid.test(name.slice(0,-5))).slice(0,513);
      if(names.length>512)throw Error('Terminal receipt budget exceeded');
      let recent=null;
      for(const name of names){const item=await readStored(key,name.slice(0,-5));if(item&&(!recent||item.requestedAt>recent.requestedAt))recent=item;}
      if(!jobs.has(key)&&recent){if(restored.size>=64)restored.delete(restored.keys().next().value);restored.set(key,publicRecord(recent));}
      return latest(scope);
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function inspect(scope,requestId){
    const key=scopeKey(scope),job=jobs.get(key);
    if(job?.record.requestId===requestId)return view(job);
    const record=await readStored(key,requestId);
    if(!record)return null;
    const result=publicRecord(record);
    if(restored.get(key)?.requestId===requestId)restored.set(key,result);
    return result;
  }
  function stop(scope,requestId){
    const job=running.get(scopeKey(scope));
    if(!job||job.record.requestId!==requestId)return null;
    requestStop(job,'cancelled');return view(job);
  }
  async function close(){
    closing=true;
    const active=[...running.values()];
    for(const job of active)requestStop(job,'service_closing');
    const timeout=Symbol();let timer;
    try{
      const result=await Promise.race([Promise.all(active.map(job=>job.settled)),new Promise(resolve=>{timer=setTimeout(()=>resolve(timeout),12000);})]);
      return {closed:starting.size===0&&result!==timeout&&result.every(job=>job.exitConfirmed===true)};
    }finally{clearTimeout(timer);}
  }
  return Object.freeze({availability,start,latest,restoreLatest,inspect,stop,close});
}
