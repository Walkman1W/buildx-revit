import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createModelTerminalService} from '../lib/model-terminal-service.mjs';

const [directory,helperPath,pythonExecutable,powershellExecutable]=process.argv.slice(2);
if(process.platform!=='win32'||process.argv.length!==6||![directory,helperPath,pythonExecutable,powershellExecutable].every(file=>path.isAbsolute(file??'')))
  throw Error('Use four absolute arguments: existing candidate evidence directory, helper exe, installed Python exe and installed PowerShell exe.');

const dataRoot=await fs.mkdtemp(path.join(directory,'终端 实机 '));
const workRoot=await fs.mkdtemp(path.join(os.tmpdir(),'BuildX 终端 工作 '));
const scope={account:'terminal-test',conversationId:randomUUID()};
const options={dataRoot,workRoot,helperPath,pythonExecutable,powershellExecutable};
const service=createModelTerminalService(options);
const outcomes=[];
const launch=(interpreter,script,opts={})=>service.start({scope,callId:opts.callId??randomUUID(),
  args:{interpreter,script,timeout_ms:opts.timeout??20000},isCurrent:()=>true,onUpdate:opts.onUpdate});
const waitFor=async predicate=>{
  const end=Date.now()+25000;
  while(!predicate()){
    if(Date.now()>end)throw Error('Timed out while observing the original terminal request');
    await new Promise(resolve=>setTimeout(resolve,35));
  }
};
function exited(receipt,outcome){
  assert.equal(receipt.status,'exited',JSON.stringify(receipt));
  assert.equal(receipt.outcome,outcome,JSON.stringify(receipt));
  assert.equal(receipt.exitConfirmed,true);
  assert.equal(receipt.interpreterStarted,true);
  assert.equal(receipt.containment,'windows-appcontainer-job');
  assert.equal(receipt.outputComplete,true);
  outcomes.push({requestId:receipt.requestId,interpreter:receipt.interpreter,outcome,exitCode:receipt.exitCode});
}

const listener=net.createServer();
let accepted=0;
listener.on('connection',socket=>{accepted++;socket.destroy();});
await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));
try{
  assert.equal((await service.availability()).available,true);
  const external=path.join(dataRoot,'不能读取 外部.txt');
  const protectedWrite=path.join(dataRoot,'不能写入 外部.txt');
  await fs.writeFile(external,'isolated fixture');
  const ps=await launch('powershell',`$ErrorActionPreference = 'Stop'
if ((Get-Location).ProviderPath.TrimEnd('\\') -ne $PSScriptRoot) { throw 'unexpected cwd' }
$name = '泵房 数据.csv'
Set-Content -LiteralPath $name -Value @('设备,数量','水泵,2','阀门,3') -Encoding UTF8
$sum = (Import-Csv -LiteralPath $name | Measure-Object -Property 数量 -Sum).Sum
[Console]::WriteLine("合计：$sum")
[Console]::Error.WriteLine('检查：中文错误流')
exit 7`);
  const psResult=await ps.done;
  exited(psResult,'failed');assert.equal(psResult.exitCode,7);
  assert.match(psResult.stdout,/合计：5/);assert.match(psResult.stderr,/检查：中文错误流/);
  assert.match(await fs.readFile(path.join(psResult.cwd,'泵房 数据.csv'),'utf8'),/阀门,3/);

  const py=await launch('python',`import csv, os, pathlib, socket, sys, time
assert os.getcwd() == os.path.dirname(__file__)
with open('水泵 统计.csv', 'w', encoding='utf-8', newline='') as target:
    csv.writer(target).writerows([['设备', '数量'], ['水泵', 2], ['阀门', 3]])
with open('水泵 统计.csv', encoding='utf-8', newline='') as target:
    assert sum(int(row['数量']) for row in csv.DictReader(target)) == 5
for target, mode in [(r'${external}', 'r'), (r'${protectedWrite}', 'w')]:
    try:
        pathlib.Path(target).open(mode).close()
    except PermissionError:
        pass
    else:
        raise AssertionError('outside file access')
try:
    socket.create_connection(('127.0.0.1', ${listener.address().port}), 0.3).close()
except OSError:
    pass
else:
    raise AssertionError('loopback access')
print('第一段：合计 5')
time.sleep(1.3)
sys.stderr.write('诊断：中文\u005cn')
print('第二段：结束')`);
  await waitFor(()=>{const job=service.latest(scope);return job?.requestId===py.requestId&&(job.stdout.includes('第一段')||job.exitConfirmed);});
  assert.match(service.latest(scope).stdout,/第一段/,JSON.stringify(service.latest(scope)));
  assert.equal(service.latest(scope).exitConfirmed,false);
  assert.equal(service.latest(scope).stdout.includes('第二段'),false);
  const pyResult=await py.done;
  exited(pyResult,'completed');assert.match(pyResult.stdout,/第二段/);assert.match(pyResult.stderr,/诊断：中文/);
  assert.match(await fs.readFile(path.join(pyResult.cwd,'水泵 统计.csv'),'utf8'),/阀门,3/);
  await assert.rejects(fs.stat(protectedWrite),{code:'ENOENT'});assert.equal(accepted,0);

  const callId=randomUUID();
  const large=await launch('python',`import sys
print('管' * 11000)
sys.stderr.write('阀' * 11000)`,{callId});
  const capped=await large.done;
  exited(capped,'completed');assert.equal(capped.stdoutTruncated,true);assert.equal(capped.stderrTruncated,true);
  for(const value of [capped.stdout,capped.stderr]){
    assert.ok(Buffer.byteLength(value)>8000&&Buffer.byteLength(value)<=8192);assert.doesNotMatch(value,/\ufffd/);
  }
  await assert.rejects(launch('python','print(0)',{callId}),{terminalCode:'TERMINAL_DUPLICATE'});

  const descendant=`import subprocess, sys, time
with open('child.log', 'w+b') as child_io:
    subprocess.Popen([sys.executable, '-I', '-c', "import pathlib, time; time.sleep(5); pathlib.Path('迟到 子进程.txt').write_text('alive')"], stdin=child_io, stdout=child_io, stderr=child_io, creationflags=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP)
print('已创建子进程')
time.sleep(12)`;
  const timed=await launch('python',descendant,{timeout:2300});
  const timeoutReceipt=await timed.done;
  exited(timeoutReceipt,'timed_out');assert.match(timeoutReceipt.stdout,/已创建子进程/);

  const cancelled=await launch('python',descendant);
  await waitFor(()=>{const job=service.latest(scope);return job?.requestId===cancelled.requestId&&(job.stdout.includes('已创建子进程')||job.exitConfirmed);});
  assert.match(service.latest(scope).stdout,/已创建子进程/,JSON.stringify(service.latest(scope)));
  const stopping=service.stop(scope,cancelled.requestId);
  assert.equal(stopping.status,'stop_requested');assert.equal(stopping.exitConfirmed,false);
  const cancelReceipt=await cancelled.done;
  exited(cancelReceipt,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,5300));
  for(const receipt of [timeoutReceipt,cancelReceipt])await assert.rejects(fs.stat(path.join(receipt.cwd,'迟到 子进程.txt')),{code:'ENOENT'});

  const reopened=createModelTerminalService(options);
  assert.equal((await reopened.restoreLatest(scope)).requestId,cancelReceipt.requestId);
  assert.equal((await reopened.inspect(scope,py.requestId)).exitCode,0);
  assert.equal(await reopened.inspect({...scope,conversationId:randomUUID()},py.requestId),null);
  const scopeKey=createHash('sha256').update(JSON.stringify([scope.account,scope.conversationId])).digest('hex');
  const receiptFile=path.join(dataRoot,'terminal','receipts',scopeKey,cancelReceipt.requestId+'.json');
  const archived=JSON.parse(await fs.readFile(receiptFile,'utf8'));
  // Simulate interrupted Node receipt persistence. The independent native proof is real.
  await fs.writeFile(receiptFile,JSON.stringify({...archived,status:'running',exitConfirmed:false,exitCode:null}));
  assert.equal((await reopened.inspect(scope,cancelReceipt.requestId)).outcome,'cancelled');
  await fs.rename(receiptFile.replace(/\.json$/,'.result.json'),receiptFile+'.fixture-held-proof');
  assert.equal((await reopened.inspect(scope,cancelReceipt.requestId)).status,'unconfirmed');
  await assert.rejects(reopened.start({scope,callId:randomUUID(),args:{interpreter:'python',script:'print(0)'},isCurrent:()=>true}),{terminalCode:'TERMINAL_UNCONFIRMED'});
  await fs.rename(receiptFile+'.fixture-held-proof',receiptFile.replace(/\.json$/,'.result.json'));
  await fs.writeFile(receiptFile,JSON.stringify(archived));
  const absent=createModelTerminalService({...options,pythonExecutable:path.join(dataRoot,'missing-python.exe')});
  await assert.rejects(absent.start({scope,callId:randomUUID(),args:{interpreter:'python',script:'print(0)'},isCurrent:()=>true}),{terminalCode:'TERMINAL_INTERPRETER_MISSING'});

  console.log(JSON.stringify({dataRoot,workRoot,realWindowsExecution:outcomes,verified:[
    'PowerShell and Python CSV/Chinese working path and streams','incremental output','nonzero exit',
    'per-stream UTF-8 truncation','external file and loopback denied','timeout and cancel detached descendants',
    'scoped original receipts','missing interpreter fails closed'],simulated:['Node persistence interrupted: independent native proof present/missing']},null,2));
}finally{
  await service.close();
  await new Promise(resolve=>listener.close(resolve));
}
