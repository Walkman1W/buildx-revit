import {spawn as defaultSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';

// Fixed script: payload, proof and account-specific entropy are passed only on
// stdin. The chosen files are never opened or executed by this helper.
const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  $request=([Console]::In.ReadToEnd() | ConvertFrom-Json)
  $entropy=[Convert]::FromBase64String($request.entropy)
  $payload=[Convert]::FromBase64String($request.payload)
  if ($request.operation -eq 'seal') {
    $protected=[Security.Cryptography.ProtectedData]::Protect($payload,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ok=$true;proof=[Convert]::ToBase64String($protected)}))
  } elseif ($request.operation -eq 'verify') {
    $proof=[Convert]::FromBase64String($request.proof)
    $unprotected=[Security.Cryptography.ProtectedData]::Unprotect($proof,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $different=$unprotected.Length -bxor $payload.Length
    $length=[Math]::Max($unprotected.Length,$payload.Length)
    for($i=0;$i -lt $length;$i++){ $a=0;$b=0;if($i -lt $unprotected.Length){$a=$unprotected[$i]};if($i -lt $payload.Length){$b=$payload[$i]};$different=$different -bor ($a -bxor $b) }
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ok=$true;valid=($different -eq 0)}))
  } else { throw 'operation' }
} catch { [Console]::Out.Write('{"ok":false}') }`;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const fail=(code,message)=>({ok:false,error:{code,message}});
const scopeValid=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!value.includes('\0');
const payloadValid=value=>Buffer.isBuffer(value)&&value.length>0&&value.length<=65536;
const proofValid=value=>typeof value==='string'&&value.length>0&&value.length<=131072&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

/** DPAPI authenticates exact bytes to the current Windows account and scope.
 * It does not protect from same-account processes or record rollback/removal.
 * This candidate does not itself supply persistence or an ownership lock. */
export function createProjectFilesAuth({spawn=defaultSpawn,platform=process.platform,systemRoot=process.env.SystemRoot,timeoutMs=10000,cleanupTimeoutMs=3000}={}){
  if(typeof spawn!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1)throw new TypeError('Invalid DPAPI owner dependencies');
  const executable=typeof systemRoot==='string'&&path.win32.isAbsolute(systemRoot)?path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):null;
  let active=null,closing=false;
  const encodedScript=Buffer.from(script,'utf16le').toString('base64');
  function stop(owner,reason){
    if(!owner.reason){owner.reason=reason;owner.resolveStop();}
    if(!owner.closed&&!owner.exited){try{owner.child.kill();}catch{/* Retain until close proves termination. */}}
  }
  async function waitClose(owner){let timer;try{return await Promise.race([owner.closePromise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),cleanupTimeoutMs);})]);}finally{clearTimeout(timer);}}
  async function execute(operation,{scope,payload,proof}={}){
    if(!scopeValid(scope)||!payloadValid(payload)||operation==='verify'&&!proofValid(proof))return fail('AUTH_INPUT_INVALID','资料地址认证输入无效。');
    if(platform!=='win32'||!executable)return fail('AUTH_UNAVAILABLE','当前环境不支持本机资料地址认证。');
    if(active||closing)return fail('AUTH_BUSY','资料地址认证尚未结束。');
    // Snapshot inputs before spawning; callers cannot mutate the authorized bytes.
    const bytes=Buffer.from(payload),entropy=createHash('sha256').update('BuildX project files auth v1\0','utf8').update(scope,'utf8').digest();
    const input=Buffer.from(JSON.stringify({operation,entropy:entropy.toString('base64'),payload:bytes.toString('base64'),...(operation==='verify'?{proof}:{})}),'utf8');
    let child;try{child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedScript],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});}
    catch{return fail('AUTH_START_FAILED','资料地址认证无法启动。');}
    const owner={child,closed:false,exited:false,reason:null,error:false,chunks:[],length:0};active=owner;
    owner.closePromise=new Promise(resolve=>{owner.resolveClose=resolve;});owner.stopPromise=new Promise(resolve=>{owner.resolveStop=resolve;});
    const timer=setTimeout(()=>stop(owner,'AUTH_TIMEOUT'),timeoutMs);
    child.stdout?.on('data',chunk=>{if(owner.reason)return;const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);owner.length+=data.length;if(owner.length>131072){stop(owner,'AUTH_OUTPUT_INVALID');return;}owner.chunks.push(data);});
    child.stdout?.on('error',()=>{owner.error=true;stop(owner,'AUTH_FAILED');});
    child.stderr?.on('data',()=>{});child.stderr?.on('error',()=>{owner.error=true;stop(owner,'AUTH_FAILED');});
    child.stdin?.on('error',()=>{owner.error=true;stop(owner,'AUTH_FAILED');});
    child.on('error',()=>{owner.error=true;});child.on('exit',()=>{owner.exited=true;});
    child.on('close',(code,signal)=>{owner.closed=true;owner.exited=true;clearTimeout(timer);if(active===owner)active=null;owner.resolveClose({code,signal});});
    try{child.stdin.end(input);}catch{owner.error=true;stop(owner,'AUTH_FAILED');}
    await Promise.race([owner.closePromise,owner.stopPromise]);
    if(owner.reason){if(!await waitClose(owner))return fail('AUTH_CLEANUP_PENDING','认证进程尚未确认关闭。');return fail(owner.reason,'资料地址认证未完成。');}
    const done=await owner.closePromise;if(owner.error||done.code!==0||done.signal)return fail('AUTH_FAILED','资料地址认证未完成。');
    try{
      const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(owner.chunks)));
      if(!plain(result)||result.ok!==true)throw new Error();
      if(operation==='seal'&&Object.keys(result).sort().join(',')==='ok,proof'&&proofValid(result.proof))return {ok:true,value:{proof:result.proof}};
      if(operation==='verify'&&Object.keys(result).sort().join(',')==='ok,valid'&&typeof result.valid==='boolean')return {ok:true,value:{valid:result.valid}};
      throw new Error();
    }catch{return fail('AUTH_FAILED','资料地址认证未完成或无法核实。');}
  }
  async function close(){closing=true;const owner=active;if(!owner)return {closed:true};stop(owner,'AUTH_CANCELLED');return {closed:await waitClose(owner)};}
  return Object.freeze({seal:input=>execute('seal',input),verify:input=>execute('verify',input),close});
}
