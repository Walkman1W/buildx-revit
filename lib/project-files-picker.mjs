import {spawn as spawnChild} from 'node:child_process';
import path from 'node:path';

const fail=(code,message)=>({ok:false,error:{code,message}});
// Fixed script: no user-provided value is interpolated into PowerShell. The
// child returns only the path chosen in its own dialog; it never opens the path.
const scripts=Object.freeze({
  file:`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
try { $result = $dialog.ShowDialog(); $selected = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName } else { $null }; [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{path=$selected})) } finally { $dialog.Dispose() }`,
  directory:`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.ShowNewFolderButton = $false
try { $result = $dialog.ShowDialog(); $selected = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { $null }; [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{path=$selected})) } finally { $dialog.Dispose() }`
});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

/** Owns at most one dialog process. This owner never assumes kill means exit:
 * a child remains owned and blocks further dialogs until its close event. */
export function createProjectFilesPicker({spawn=spawnChild,platform=process.platform,
  systemRoot=process.env.SystemRoot,timeoutMs=300000,cleanupTimeoutMs=5000}={}){
  if(typeof spawn!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1)throw new TypeError('Invalid picker dependencies');
  let active=null,closing=false;
  const executable=typeof systemRoot==='string'&&path.win32.isAbsolute(systemRoot)?path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):null;
  function requestStop(owner,reason){
    if(!owner.stopReason){owner.stopReason=reason;owner.resolveStop();}
    if(owner.exited||owner.closed)return;
    try{owner.child.kill();}catch{/* retain until close can be confirmed */}
  }
  async function awaitClose(owner){
    let timer;try{return await Promise.race([owner.closedPromise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),cleanupTimeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  async function pick({kind,signal}={}){
    if(!Object.hasOwn(scripts,kind)||signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))return fail('PICKER_INPUT_INVALID','文件选择请求无效。');
    if(platform!=='win32'||!executable)return fail('PICKER_UNAVAILABLE','当前环境不能打开本机选择器。');
    if(closing||active)return fail('PICKER_BUSY','另一个文件选择窗口尚未关闭。');
    if(signal?.aborted)return fail('PICKER_CANCELLED','文件选择已取消。');
    const encoded=Buffer.from(scripts[kind],'utf16le').toString('base64');
    let child;
    try{child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',encoded],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});}
    catch{return fail('PICKER_START_FAILED','无法打开文件选择器。');}
    const owner={child,closed:false,exited:false,stopReason:null,bytes:0,chunks:[],error:false};
    active=owner;
    owner.closedPromise=new Promise(resolve=>{owner.resolveClosed=resolve;});
    owner.stopPromise=new Promise(resolve=>{owner.resolveStop=resolve;});
    const abort=()=>requestStop(owner,'PICKER_CANCELLED');
    signal?.addEventListener('abort',abort,{once:true});
    let timer=setTimeout(()=>requestStop(owner,'PICKER_TIMEOUT'),timeoutMs);
    child.stdout?.on('data',chunk=>{
      if(owner.stopReason)return;
      const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);owner.bytes+=data.length;
      if(owner.bytes>131072){requestStop(owner,'PICKER_OUTPUT_INVALID');return;}
      owner.chunks.push(data);
    });
    child.stdout?.on('error',()=>{owner.error=true;requestStop(owner,'PICKER_FAILED');});
    // Never expose stderr; it may contain private local paths.
    child.stderr?.on('data',()=>{});
    child.stderr?.on('error',()=>{owner.error=true;requestStop(owner,'PICKER_FAILED');});
    child.on('error',()=>{owner.error=true;requestStop(owner,'PICKER_FAILED');});
    child.on('exit',()=>{owner.exited=true;});
    child.on('close',(code,signalName)=>{
      owner.exited=true;owner.closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(active===owner)active=null;
      owner.resolveClosed({code,signalName});
    });
    // Cancellation may happen between the initial check and listener setup.
    if(signal?.aborted)abort();
    await Promise.race([owner.closedPromise,owner.stopPromise]);
    if(owner.stopReason){
      if(!await awaitClose(owner))return fail('PICKER_CLEANUP_PENDING','文件选择窗口尚未确认关闭，请稍后重试清理。');
      return fail(owner.stopReason,'文件选择已取消或未完成。');
    }
    const closed=await owner.closedPromise;
    if(owner.error||closed.code!==0||closed.signalName)return fail('PICKER_FAILED','文件选择器未能完成。');
    try{
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(owner.chunks)));
      if(!plain(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'path')||value.path!==null&&(typeof value.path!=='string'||value.path.length>32767||value.path.includes('\0')||!path.win32.isAbsolute(value.path)))throw new Error();
      return {ok:true,value:{path:value.path}};
    }catch{return fail('PICKER_OUTPUT_INVALID','文件选择器返回的地址无效。');}
  }
  async function close(){
    closing=true;const owner=active;
    if(!owner)return {closed:true};
    requestStop(owner,'PICKER_CANCELLED');
    return {closed:await awaitClose(owner)};
  }
  return Object.freeze({pick,close});
}
