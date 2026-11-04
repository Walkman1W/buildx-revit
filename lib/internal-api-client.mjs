import path from 'node:path';
import {CodexClient} from './codex-client.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from './codex-profile.mjs';
import {createApiProviderLaunch} from './api-provider-launch.mjs';

// Internal composition only: do not expose this factory to HTTP or a browser.
// A client-side process cannot protect a paid service's shared API key from
// its local user. Production billing needs a separately managed service.
const data=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value))&&
  Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const allowedDependencyKeys=new Set(['spawn','resolveRuntimes','readConfiguredNames','closeTimeoutMs','killTimeoutMs']);
const permittedErrors=new Set(['CODEX_PROVIDER_UNVERIFIED','CODEX_CLEANUP_UNCONFIRMED','CODEX_CONFIG_UNAVAILABLE','CODEX_CONFIG_INVALID','CODEX_CONNECTION_CHANGED','CODEX_ACCOUNT_REVISION_CHANGED']);
function safeFailure(error){
  const safe=new Error('内部 API 连接未能完成，请核对运行配置。');
  safe.code=permittedErrors.has(error?.code)?error.code:'INTERNAL_API_START_FAILED';
  return safe;
}

// The provider is a transient, one-shot launch owner. Its credential never
// appears in this factory's return value, config, diagnostics, or arguments.
// Caller owns the returned client and must call close, including after errors.
export function createInternalApiClient(input, dependencies={}){
  if(!data(input)||Reflect.ownKeys(input).some(key=>!['root','provider'].includes(key))||
     typeof input.root!=='string'||!path.isAbsolute(input.root)||input.root.includes('\0')||!data(input.provider)||
     !data(dependencies)||Reflect.ownKeys(dependencies).some(key=>!allowedDependencyKeys.has(key)))
    throw new Error('内部 API 连接参数无效。');
  const provider=createApiProviderLaunch(input.provider);
  let client;
  try{client=new CodexClient(input.root,{profile:MODEL_WORKSPACE_SESSION_PROFILE},{...dependencies,apiProvider:provider});}
  catch{provider.dispose();throw new Error('内部 API 客户端创建失败。');}
  let closed=false,closing=false,closePromise=null,startPromise=null;
  async function close(){
    if(closed)return {closed:true};
    if(closePromise)return closePromise;
    closing=true;
    closePromise=client.close();
    try{const result=await closePromise;if(result?.closed!==true)throw new Error();closed=true;return result;}
    catch{const error=new Error('内部 API 连接清理尚未确认，可重试关闭。');error.code='CODEX_CLEANUP_UNCONFIRMED';throw error;}
    finally{closePromise=null;}
  }
  async function start(){
    if(closing||closed)throw new Error('内部 API 连接已关闭。');
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      try{await client.start();return {ready:client.state.ready,modelAvailability:'unverified'};}
      catch(error){try{await close();}catch{const failure=new Error('内部 API 连接清理尚未确认，可重试关闭。');failure.code='CODEX_CLEANUP_UNCONFIRMED';throw failure;}throw safeFailure(error);}
    })();
    return startPromise;
  }
  return Object.freeze({client,start,close});
}
