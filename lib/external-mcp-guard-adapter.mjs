// Composition boundary for a future trusted native launcher. This module is
// not a sandbox and is not wired into the panel. The injected launcher must be
// supplied by trusted host code, never by the user's MCP configuration.
// Its prepare() MUST be synchronous, allocate no native resources and spawn
// nothing. startAtomic() must perform the guarded launch while binding helper,
// target, all executable dependencies and paths to the approved snapshot.
// confirmClosed() must retain ownership unless the whole owned Job and pipes
// have actually closed; process exit or SDK onclose alone is not enough.

const dataOwner=(v,methods)=>v&&typeof v==='object'&&Object.isFrozen(v)&&methods.every(k=>{
  const d=Object.getOwnPropertyDescriptor(v,k);return d&&Object.hasOwn(d,'value')&&typeof d.value==='function';
});
const invalid=()=>new Error('Guarded MCP transport unavailable');
const copyArgs=v=>Object.freeze([...v]);

export function createExternalMcpGuardAdapter({launcher}={}) {
  if(!dataOwner(launcher,['prepare']))throw new TypeError('Trusted native launcher required');
  // A process or its handles may outlive a caller. Keep the original session
  // strongly owned until confirmed release, including cleanup failures.
  const owners=new Map();let closing=false,closePromise=null;

  function createTransport(input){
    if(closing)throw invalid();
    if(!input||typeof input!=='object'||typeof input.command!=='string'||typeof input.cwd!=='string'||
      typeof input.executableIdentity!=='string'||typeof input.executableSha256!=='string'||
      !/^[a-f0-9]{64}$/.test(input.executableSha256)||typeof input.cwdIdentity!=='string'||
      !Array.isArray(input.args)||input.args.some(x=>typeof x!=='string')||
      !input.environment||typeof input.environment!=='object'||Array.isArray(input.environment)||
      typeof input.StdioClientTransport!=='function'||!Number.isSafeInteger(input.maxBufferSize)||input.maxBufferSize<1)throw invalid();
    const env=Object.create(null);
    for(const [key,value] of Object.entries(input.environment)){
      if(typeof value!=='string'||key.includes('\0')||value.includes('\0'))throw invalid();env[key]=value;
    }
    const spec=Object.freeze({command:input.command,cwd:input.cwd,args:copyArgs(input.args),
      executableIdentity:input.executableIdentity,executableSha256:input.executableSha256,
      cwdIdentity:input.cwdIdentity,environment:Object.freeze(env),maxBufferSize:input.maxBufferSize,
      StdioClientTransport:input.StdioClientTransport});
    const session=launcher.prepare(spec);
    if(!dataOwner(session,['startAtomic','confirmClosed','disposeUnstarted'])||
      !session.transport||typeof session.transport.start!=='function'||typeof session.transport.send!=='function'||typeof session.transport.close!=='function')throw invalid();
    const raw=session.transport;
    const state={phase:'prepared',delivered:false,completion:null,startPromise:null,rawClosePromise:null,closePromise:null,disposePromise:null};
    const transport={onclose:null,onerror:null,onmessage:null,
      async start(){
        if(state.phase!=='prepared')throw invalid();state.phase='starting';
        const pending=Promise.resolve().then(()=>session.startAtomic());state.startPromise=pending;
        try{await pending;if(state.phase!=='starting')throw invalid();state.phase='running';}
        catch{if(state.phase!=='closed')state.phase='unknown';throw invalid();}
      },
      send(...args){if(state.phase!=='running')throw invalid();return raw.send(...args);},
      async close(){
        if(state.phase==='disposed'||state.phase==='closed')return;
        if(state.phase==='prepared'||state.phase==='disposing'){
          if(!await dispose(transport))throw invalid();
          // Once handed to an SDK client, confirmed never-started disposal is
          // a complete close too; the client must not wait forever for a child
          // event from a process that was never created.
          if(!state.delivered){state.delivered=true;try{transport.onclose?.();}catch{}}
          return;
        }
        if(state.closePromise)return state.closePromise;
        state.phase='closing';
        const pending=(async()=>{
          // Start may already have spawned even if its promise ultimately fails.
          // Never release while that original launch is still in flight.
          if(state.startPromise)try{await state.startPromise;}catch{}
          // A failed/late close may already have taken effect. Retain the
          // original close promise instead of issuing a second close.
          if(!state.rawClosePromise)state.rawClosePromise=Promise.resolve().then(()=>raw.close());
          try{await state.rawClosePromise;}catch{}
          if(!await finish())throw invalid();
        })();state.closePromise=pending;
        try{return await pending;}finally{if(state.closePromise===pending)state.closePromise=null;}
      }
    };
    async function finish(){
      if(state.phase==='closed')return true;
      if(state.completion)return state.completion;
      const pending=(async()=>{
        if(state.startPromise)try{await state.startPromise;}catch{}
        // A trusted launcher verifies actual job/pipe completion and releases
        // every held identity. A process-only onclose is never that proof.
        let complete=false;try{complete=await session.confirmClosed()===true;}catch{}
        if(!complete){state.phase='cleanup_pending';return false;}
        state.phase='closed';owners.delete(transport);
        if(!state.delivered){state.delivered=true;try{transport.onclose?.();}catch{}}
        return true;
      })();state.completion=pending;
      try{return await pending;}finally{if(state.completion===pending)state.completion=null;}
    }
    async function dispose(candidate){
      if(candidate!==transport)return false;
      if(state.disposePromise)return state.disposePromise;
      if(state.phase!=='prepared')return false;
      state.phase='disposing';
      const pending=(async()=>{let ok=false;try{ok=await session.disposeUnstarted()===true;}catch{}
        state.phase=ok?'disposed':'prepared';if(ok)owners.delete(transport);return ok;})();state.disposePromise=pending;
      try{return await pending;}finally{if(state.disposePromise===pending)state.disposePromise=null;}
    }
    raw.onmessage=message=>transport.onmessage?.(message);
    raw.onerror=()=>transport.onerror?.(invalid());
    raw.onclose=()=>{
      if(['prepared','disposing','disposed','closed'].includes(state.phase))return;
      state.phase='cleanup_pending';
      void finish().then(ok=>{if(!ok)try{transport.onerror?.(invalid());}catch{}});
    };
    owners.set(transport,{dispose});return transport;
  }
  async function disposeUnstarted({transport}={}){
    const owner=owners.get(transport);return owner?owner.dispose(transport):false;
  }
  async function close(){
    closing=true;if(closePromise)return closePromise;
    const pending=(async()=>{
      await Promise.allSettled([...owners.keys()].map(transport=>transport.close()));
      return {closed:owners.size===0,remaining:owners.size};
    })();closePromise=pending;
    try{return await pending;}finally{if(closePromise===pending)closePromise=null;}
  }
  return Object.freeze({createTransport,disposeUnstarted,close});
}
