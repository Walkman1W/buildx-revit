import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

// This owner is composed only on a trusted server. Creating it does not listen
// on a port. It is not a billing system or an authorization implementation.
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const bounded=(v,n)=>Number.isSafeInteger(v)&&v>0&&v<=n;
const fail=(res,status)=>{if(!res.headersSent&&!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"request unavailable"}');}else if(!res.destroyed)res.destroy();};

function targetUrl(base){
  if(typeof base!=='string'||!base||base.length>2048||base.trim()!==base||base.includes('?')||base.includes('#')||/[\x00-\x20\x7f]/.test(base))throw new TypeError('Invalid upstream');
  const url=new URL(base);
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password)throw new TypeError('Invalid upstream');
  // The owner supplies the complete base URL; do not allow the client to pick
  // an upstream or alter its query string, including during redirects.
  return url.href.replace(/\/$/,'')+'/responses';
}

function authMethod(owner){
  if(!plain(owner)||!Object.isFrozen(owner))throw new TypeError('A trusted immutable authorization owner is required');
  const d=Object.getOwnPropertyDescriptor(owner,'authorize');
  if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function')throw new TypeError('Invalid authorization owner');
  return args=>d.value.call(owner,args);
}

function responseGuard(secret,maxBytes){
  const forbidden=Buffer.from(secret,'utf8');let tail=Buffer.alloc(0),size=0;
  return new Transform({
    transform(chunk,_encoding,callback){
      try{
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
        if(size>maxBytes)throw new Error('response limit');
        const all=Buffer.concat([tail,bytes]);
        if(all.indexOf(forbidden)!==-1)throw new Error('upstream returned credential');
        const safe=Math.max(0,all.length-(forbidden.length-1));
        if(safe)this.push(all.subarray(0,safe));
        tail=Buffer.from(all.subarray(safe));callback();
      }catch(error){callback(error);}
    },
    flush(callback){if(tail.indexOf(forbidden)!==-1){callback(new Error('upstream returned credential'));return;}if(tail.length)this.push(tail);tail=Buffer.alloc(0);callback();}
  });
}

function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(new Error('cancelled'));
  return new Promise((resolve,reject)=>{
    const stop=()=>{cleanup();reject(new Error('cancelled'));};
    const cleanup=()=>signal.removeEventListener('abort',stop);
    signal.addEventListener('abort',stop,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}

/** Internal composition. Never pass these parameters from an HTTP client. */
export function createServerApiGateway({upstreamBaseUrl,apiKey,authorizationOwner,fetchImpl=fetch,timeoutMs=30000,maxRequestBytes=256*1024,maxResponseBytes=4*1024*1024,maxInflight=32,maxOutputTokens=4096}={}){
  const target=targetUrl(upstreamBaseUrl),authorize=authMethod(authorizationOwner);
  if(typeof apiKey!=='string'||Buffer.byteLength(apiKey)<8||Buffer.byteLength(apiKey)>4096||/[\x00-\x20\x7f]/.test(apiKey)||typeof fetchImpl!=='function'||
    !bounded(timeoutMs,120000)||!bounded(maxRequestBytes,4*1024*1024)||!bounded(maxResponseBytes,32*1024*1024)||!bounded(maxInflight,256)||!bounded(maxOutputTokens,1000000)||target.includes(apiKey))throw new TypeError('Invalid gateway configuration');
  let closed=false;const inflight=new Set(),pendingTasks=new Set(),cleanupOwners=new Set();
  function track(promise,onResolve){
    const owner={};pendingTasks.add(owner);
    const task=Promise.resolve(promise).then(value=>{if(onResolve)onResolve(value);return value;});
    void task.then(()=>pendingTasks.delete(owner),()=>pendingTasks.delete(owner));
    return task;
  }
  function retryCleanup(owner){
    if(owner.pending)return;
    owner.pending=true;
    void Promise.resolve().then(()=>owner.body.cancel()).then(()=>cleanupOwners.delete(owner),()=>{owner.pending=false;});
  }
  function cancelBody(response){
    if(!response?.body||typeof response.body.cancel!=='function')return;
    const owner={body:response.body,pending:false};cleanupOwners.add(owner);retryCleanup(owner);
  }
  async function handle(req,res){
    if(closed){fail(res,503);return;}
    if(req.method!=='POST'||req.url!=='/v1/responses'){fail(res,404);return;}
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||''))){fail(res,415);return;}
    // Include unresolved authentication and transport operations in admission:
    // a timed-out callback that ignores cancellation retains its capacity.
    if(inflight.size+pendingTasks.size+cleanupOwners.size>=maxInflight){fail(res,503);return;}
    const declared=req.headers['content-length'];
    if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maxRequestBytes)){fail(res,413);return;}
    const controller=new AbortController(),entry={controller};inflight.add(entry);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
    const onClose=()=>{if(!res.writableFinished)controller.abort();};res.once('close',onClose);
    const stopReading=()=>{if(!req.complete&&!req.destroyed)req.destroy();};controller.signal.addEventListener('abort',stopReading,{once:true});
    try{
      let used=0;const chunks=[];
      for await(const chunk of req){if(controller.signal.aborted)throw new Error('cancelled');const bytes=Buffer.from(chunk);used+=bytes.length;if(used>maxRequestBytes){fail(res,413);return;}chunks.push(bytes);}
      if(controller.signal.aborted)throw new Error('cancelled');
      const body=Buffer.concat(chunks,used);let parsed;
      try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{fail(res,400);return;}
      if(!plain(parsed)||typeof parsed.model!=='string'||!parsed.model.trim()||parsed.model.length>200){fail(res,400);return;}
      // Codex may omit max_output_tokens. This server policy adds its default
      // only when absent; a caller-selected valid budget is never replaced.
      // A byte budget is not a token count or billable usage measurement.
      const requested=Object.hasOwn(parsed,'max_output_tokens')?parsed.max_output_tokens:maxOutputTokens;
      if(!bounded(requested,maxOutputTokens)){fail(res,400);return;}
      const outbound=Object.hasOwn(parsed,'max_output_tokens')?body:Buffer.from(JSON.stringify({...parsed,max_output_tokens:requested}));
      if(outbound.length>maxRequestBytes){fail(res,413);return;}
      const authorization=typeof req.headers.authorization==='string'?req.headers.authorization:'';
      let decision;try{decision=await abortable(track(authorize(Object.freeze({authorization,model:parsed.model,inputBytes:outbound.length,maxOutputTokens:requested,signal:controller.signal}))),controller.signal);}catch{fail(res,403);return;}
      if(controller.signal.aborted||closed)throw new Error('cancelled');
      if(!plain(decision)||decision.allowed!==true){fail(res,403);return;}
      // Forward an explicitly constructed header set, never the client token,
      // cookies, arbitrary client headers, or upstream error body.
      const requestKey=apiKey;
      // If an injected transport ignores cancellation and completes later,
      // release the returned response body without dispatching another call.
      const upstream=track(fetchImpl(target,{method:'POST',redirect:'manual',signal:controller.signal,
        headers:{authorization:'Bearer '+requestKey,'content-type':'application/json','accept':'text/event-stream, application/json'},body:outbound}),value=>{if(controller.signal.aborted)cancelBody(value);});
      const response=await abortable(upstream,controller.signal);
      if(!response||response.status>=300&&response.status<400||!response.ok){cancelBody(response);fail(res,502);return;}
      const contentType=response.headers?.get('content-type')||'';
      if(!/^(?:text\/event-stream|application\/json)(?:\s*;|$)/i.test(contentType)||!response.body){cancelBody(response);fail(res,502);return;}
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxResponseBytes)){cancelBody(response);fail(res,502);return;}
      // Never reflect upstream header values: even a Content-Type parameter
      // could contain a credential supplied by a faulty provider.
      const safeType=/^text\/event-stream/i.test(contentType)?'text/event-stream; charset=utf-8':'application/json; charset=utf-8';
      res.writeHead(response.status,{'content-type':safeType,'cache-control':'no-store','x-content-type-options':'nosniff'});
      await pipeline(Readable.fromWeb(response.body),responseGuard(requestKey,maxResponseBytes),res,{signal:controller.signal});
    }catch{fail(res,502);}
    finally{clearTimeout(timer);res.removeListener('close',onClose);controller.signal.removeEventListener('abort',stopReading);controller.abort();inflight.delete(entry);}
  }
  function close(){
    closed=true;apiKey=null;for(const entry of inflight)entry.controller.abort();
    for(const owner of cleanupOwners)retryCleanup(owner);
    const pending=inflight.size+pendingTasks.size+cleanupOwners.size;
    return {closed:pending===0,pending};
  }
  return Object.freeze({handle,close});
}
