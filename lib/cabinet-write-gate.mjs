import {createHash} from 'node:crypto';

// This is an isolated contract, not an installed cross-process lock or journal.
// The caller must supply trustworthy owners and must publish through the same
// lock. In particular, an ordinary directory listing is not proof of completeness.
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).sort().join('\0')===[...keys].sort().join('\0');
const text=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\x00-\x1f\x7f]/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const keys=['requestId','requestDigest','requestFileIdentity','directoryIdentity','hostSession','hostPid','hostStartedUtc','accountId','authorizationId'];
const record=x=>exact(x,keys)&&keys.filter(k=>!['requestDigest','hostPid'].includes(k)).every(k=>text(x[k]))&&hex(x.requestDigest)&&Number.isSafeInteger(x.hostPid)&&x.hostPid>0;
const resolution=x=>exact(x,['requestId','attemptDigest','receiptDigest','decisionId'])&&text(x.requestId)&&hex(x.attemptDigest)&&hex(x.receiptDigest)&&text(x.decisionId);
const digest=x=>hash(JSON.stringify(keys.map(k=>x[k])));
const failure=code=>({ok:false,code});

/**
 * Dependencies are trusted capabilities, not security predicates inferred from
 * paths. lock.acquire() must establish exclusive cross-process ownership;
 * lease.verify/release and journal.load/appendAttempt/appendResolution must
 * preserve ownership and return only after the caller's required durability.
 * load() reports complete=true only when absence of records is trustworthy.
 * verifier.authorize and verifier.verifyTerminal must independently establish
 * the human decision, original request/host and terminal receipt identities.
 * If any promise fails or gives an ambiguous result this instance stays blocked.
 */
export function createCabinetWriteGate({lock,journal,verifier}={}){
  if(!lock||typeof lock.acquire!=='function'||!journal||!['load','appendAttempt','appendResolution'].every(k=>typeof journal[k]==='function')||!verifier||!['authorize','verifyTerminal'].every(k=>typeof verifier[k]==='function'))throw new TypeError('Trusted lock, journal and verifier capabilities required');
  let lease=null,poisoned=null,closed=false,active=null,seen=new Set(),eventCount=0,initialized=false,tail=Promise.resolve();
  const serial=fn=>{const run=tail.then(fn,fn);tail=run.catch(()=>{});return run;};
  async function verify(){if(!lease||await lease.verify()!==true)throw new Error('LOCK_UNVERIFIED');}
  function inventory(snapshot){
    if(!exact(snapshot,['complete','events'])||snapshot.complete!==true||!Array.isArray(snapshot.events)||snapshot.events.length>10000)throw new Error('JOURNAL_UNVERIFIED');
    let pending=null;const seen=new Set();
    for(const event of snapshot.events){
      if(!exact(event,['kind','value']))throw new Error('JOURNAL_INVALID');
      if(event.kind==='attempt'){
        if(!record(event.value)||pending||seen.has(event.value.requestId))throw new Error('JOURNAL_INVALID');
        pending=clone(event.value);seen.add(pending.requestId);
      }else if(event.kind==='resolution'){
        if(!pending||!resolution(event.value)||event.value.requestId!==pending.requestId||event.value.attemptDigest!==digest(pending))throw new Error('JOURNAL_INVALID');
        pending=null;
      }else throw new Error('JOURNAL_INVALID');
    }
    return {pending,seen,count:snapshot.events.length};
  }
  async function recover(){await verify();const found=inventory(await journal.load());await verify();active=found.pending;seen=found.seen;eventCount=found.count;initialized=true;return active;}
  async function run(fn){
    if(closed)return failure('GATE_CLOSED');if(poisoned)return failure(poisoned);
    try{return await fn();}catch{poisoned='GATE_UNCONFIRMED';return failure(poisoned);}
  }
  return Object.freeze({
    ready:()=>serial(()=>run(async()=>{
      if(!lease){lease=await lock.acquire();if(!lease||typeof lease.verify!=='function'||typeof lease.release!=='function')throw new Error('LOCK_UNVERIFIED');}
      const found=await recover();return {ok:true,blocked:found!==null,attempt:found&&clone(found)};
    })),
    begin:input=>serial(()=>run(async()=>{
      if(!lease)return failure('GATE_NOT_READY');
      if(!record(input))return failure('INVALID_ATTEMPT');const attempt=clone(input);
      if(await recover())return failure('ATTEMPT_PENDING');
      if(seen.has(attempt.requestId))return failure('REQUEST_ID_REUSED');
      // Leave room for both this attempt and its eventual resolution. A pending
      // attempt at the boundary must always remain resolvable.
      if(eventCount>9998)return failure('JOURNAL_CAPACITY');
      if(await verifier.authorize(clone(attempt))!==true)return failure('AUTHORIZATION_UNVERIFIED');
      await verify();
      // An exception or indeterminate write result is never treated as absent.
      if(await journal.appendAttempt(clone(attempt))!==true)throw new Error('APPEND_UNCONFIRMED');
      const observed=await recover();if(!observed||digest(observed)!==digest(attempt))throw new Error('APPEND_UNCONFIRMED');
      return {ok:true,requestId:attempt.requestId,attemptDigest:digest(attempt)};
    })),
    inspect:()=>serial(()=>run(async()=>{
      if(!lease)return failure('GATE_NOT_READY');const found=await recover();return {ok:true,blocked:found!==null,attempt:found&&clone(found)};
    })),
    resolve:proof=>serial(()=>run(async()=>{
      if(!lease)return failure('GATE_NOT_READY');const attempt=await recover();if(!attempt)return failure('NO_PENDING_ATTEMPT');
      if(!plain(proof))return failure('INVALID_PROOF');
      // Only a trusted verifier can bind a terminal receipt and explicit human
      // acknowledgement to the original attempt and current authorized identity.
      const result=await verifier.verifyTerminal(clone(attempt),clone(proof));
      if(!resolution(result)||result.requestId!==attempt.requestId||result.attemptDigest!==digest(attempt))return failure('TERMINAL_UNVERIFIED');
      await verify();if(await journal.appendResolution(clone(result))!==true)throw new Error('RESOLUTION_UNCONFIRMED');
      if(await recover())throw new Error('RESOLUTION_UNCONFIRMED');return {ok:true};
    })),
    close:()=>serial(async()=>{
      if(closed)return {ok:true};if(!lease){closed=true;return {ok:true};}
      try{await verify();if(await lease.release()!==true)throw new Error();closed=true;lease=null;return {ok:true};}
      catch{poisoned='LOCK_CLEANUP_UNCONFIRMED';return failure(poisoned);}
    }),
    status:()=>({closed,ready:Boolean(initialized&&lease&&!closed&&!poisoned),blocked:Boolean(!initialized||!lease||closed||poisoned||active),poisoned}),
  });
}
