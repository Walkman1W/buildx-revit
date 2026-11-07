// Contract research only. This file has no OS identity verifier and cannot
// produce a release authorization. Callers cannot turn it on with a flag.
import {createHash} from 'node:crypto';
const keys=(o,k)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===k.slice().sort().join(',');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[a-f0-9-]{32,36}$/.test(x);
const hash=b=>createHash('sha256').update(b).digest('hex');
// Pure evidence comparison for fixtures. Its result is never authority to
// publish, execute, unlock or claim that service identity was authenticated.
export function inspectSimulatedEvidence({anchor,pin,approved,requestBytes,receipt,host,interpret}){
 try{
  if(!keys(anchor,['version','rootIdentity','serviceSid'])||anchor.version!==1||typeof anchor.rootIdentity!=='string'||!anchor.rootIdentity||typeof anchor.serviceSid!=='string'||!/^S-1-\d+(?:-\d+)+$/.test(anchor.serviceSid)||!hex(pin)||hash(Buffer.from(JSON.stringify(anchor)))!==pin)return {state:'unknown'};
  if(!keys(approved,['version','requestId','requestDigest','operation','mode','document','hostSession','scopeDigest'])||approved.version!==1||!id(approved.requestId)||!hex(approved.requestDigest)||!hex(approved.scopeDigest)||!Buffer.isBuffer(requestBytes)||hash(requestBytes)!==approved.requestDigest||!host||host.sessionId!==approved.hostSession||typeof interpret!=='function')return {state:'unknown'};
  const request=JSON.parse(requestBytes.toString('utf8'));
  if(request.id!==approved.requestId||request.operation!==approved.operation||request.targetSession!==approved.hostSession||request.args?.mode!==approved.mode||request.args?.expected_document!==approved.document||request.scopeDigest!==approved.scopeDigest)return {state:'unknown'};
  if(!receipt||receipt.id!==approved.requestId||(receipt.hostSession!==undefined&&receipt.hostSession!==approved.hostSession)||receipt.timing?.hostSession!==approved.hostSession)return {state:'unknown'};
  const result=interpret(receipt,request,host);if(!result||result.terminal!==true||result.status!=='received'||typeof result.evidence?.committed!=='boolean'||result.evidence.committed!==(approved.mode==='commit'))return {state:'unknown'};
  return {state:'candidate',requestId:approved.requestId};
 }catch{return {state:'unknown'};}
}
// Production boundary remains closed until an authenticated OS service owner,
// protected provisioning, retained handles and durable transaction exist.
export function createProtectedOwner(){throw Error('protected service identity and durable transaction unavailable');}
