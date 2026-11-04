import {spawn as spawnChild} from 'node:child_process';
import path from 'node:path';

const fail=(code,message)=>({ok:false,error:{code,message}});
// The target is data on stdin, never part of a command or PowerShell source.
// The helper starts the user's default association; it does not own that app.
const script=`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = [string]$data.path
$info.UseShellExecute = $true
[void][System.Diagnostics.Process]::Start($info)`;

export function createProjectFilesOpener({spawn=spawnChild,platform=process.platform,systemRoot=process.env.SystemRoot,timeoutMs=15000,cleanupTimeoutMs=5000}={}){
  if(typeof spawn!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1)throw new TypeError('Invalid opener dependencies');
  const executable=typeof systemRoot==='string'&&path.win32.isAbsolute(systemRoot)?path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):null;
  let active=null,closing=false;
  function stop(owner,reason){if(!owner.stopReason){owner.stopReason=reason;owner.resolveStop();}if(!owner.closed&&!owner.exited)try{owner.child.kill();}catch{/* retain original child until close */}}
  async function awaitClose(owner){let timer;try{return await Promise.race([owner.closedPromise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),cleanupTimeoutMs);})]);}finally{clearTimeout(timer);}}
  async function open({path:target,kind}={}){
    if(typeof target!=='string'||target.length>32767||target.includes('\0')||!path.win32.isAbsolute(target)||!['file','directory'].includes(kind))return fail('OPEN_INPUT_INVALID','文件地址无效。');
    if(platform!=='win32'||!executable)return fail('OPEN_UNAVAILABLE','当前环境无法使用 Windows 应用打开。');
    if(closing||active)return fail('OPEN_BUSY','上一次打开请求尚未结束，请稍后重试。');
    let child;try{child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','ignore','pipe']});}catch{return fail('OPEN_FAILED','未能启动 Windows 默认应用。');}
    const owner={child,closed:false,exited:false,failed:false,stopReason:null};active=owner;
    owner.closedPromise=new Promise(resolve=>{owner.resolveClosed=resolve;});owner.stopPromise=new Promise(resolve=>{owner.resolveStop=resolve;});
    const timer=setTimeout(()=>stop(owner,'OPEN_TIMEOUT'),timeoutMs);
    child.on('error',()=>{owner.failed=true;stop(owner,'OPEN_FAILED');});
    child.on('exit',()=>{owner.exited=true;});
    child.on('close',(code,signal)=>{owner.closed=true;owner.exited=true;clearTimeout(timer);if(active===owner)active=null;owner.resolveClosed({code,signal});});
    child.stderr?.on('data',()=>{});child.stderr?.on('error',()=>{owner.failed=true;stop(owner,'OPEN_FAILED');});
    child.stdin?.on('error',()=>{owner.failed=true;stop(owner,'OPEN_FAILED');});
    try{child.stdin.end(JSON.stringify({path:target}),'utf8');}catch{owner.failed=true;stop(owner,'OPEN_FAILED');}
    await Promise.race([owner.closedPromise,owner.stopPromise]);
    if(owner.stopReason){if(!await awaitClose(owner))return fail('OPEN_CLEANUP_PENDING','打开请求可能已发送，请先检查 Windows 窗口；辅助进程尚未确认结束。');return fail(owner.stopReason,'打开请求结果未确认，请先检查 Windows 窗口。');}
    const result=await owner.closedPromise;
    if(owner.failed||result.code!==0||result.signal)return fail('OPEN_FAILED','打开请求结果未确认，请先检查 Windows 窗口。');
    return {ok:true,value:{accepted:true}};
  }
  async function close(){closing=true;const owner=active;if(!owner)return {closed:true};stop(owner,'OPEN_CANCELLED');return {closed:await awaitClose(owner)};}
  return Object.freeze({open,close});
}
