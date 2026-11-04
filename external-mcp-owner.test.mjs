import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,copyFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createExternalMcpOwner} from './lib/external-mcp-owner.mjs';

const fixture=fileURLToPath(new URL('./external-mcp-fixture.mjs',import.meta.url));
const ownerSource=fileURLToPath(new URL('./lib/external-mcp-owner.mjs',import.meta.url));
// Synthetic-only fake: this does not pin an executable and cannot be used in production.
const testExecutionGuard=Object.freeze({async createTransport({command,args,cwd,environment,maxBufferSize,StdioClientTransport}){return new StdioClientTransport({command,args,cwd,env:environment,maxBufferSize,stderr:'ignore'});}});
async function context(delay='none'){
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-owner-'));
  const marker=path.join(root,'events.jsonl'),approvals=new Map(),events=[];
  const approvalOwner=Object.freeze({async consume({approvalId,kind,proposal}){const expected=approvals.get(approvalId);approvals.delete(approvalId);return Boolean(expected&&expected.kind===kind&&expected.proposalId===proposal.proposalId);}});
  const receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(v){events.push({type:'attempt',...v});return true;},async recordOutcome(v){events.push({type:'outcome',...v});return true;}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,marker,delay],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  function allow(kind,p){const id=crypto.randomUUID();approvals.set(id,{kind,proposalId:p.proposalId});return id;}
  return {owner,marker,events,allow};
}
async function start(c){const proposal=await c.owner.launchProposal();assert.equal(proposal.ok,true);const approvalId=c.allow('mcp_start',proposal.proposal);const started=await c.owner.start({proposalId:proposal.proposal.proposalId,approvalId});assert.equal(started.ok,true,JSON.stringify(started));return started;}

function syntheticDisclosureContext(tool,responseText='ok',structuredContent){
  const approvals=[],attempts=[],secret='MarkedLaunchSecret';let calls=0;
  const approvalOwner=Object.freeze({async consume(value){approvals.push(value);return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(value){attempts.push(value);return true;},async recordOutcome(){return true;}});
  const executionGuard=Object.freeze({async createTransport(){
    return {onclose:null,onmessage:null,async start(){},async close(){this.onclose?.();},async send(message){
      if(!Object.hasOwn(message,'id'))return;
      let result;if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      else if(message.method==='tools/list')result={tools:[tool]};
      else if(message.method==='tools/call'){calls++;result={content:[{type:'text',text:responseText}],...(structuredContent?{structuredContent}:{})};}
      else throw new Error('Unexpected fixture method');
      queueMicrotask(()=>this.onmessage?.({jsonrpc:'2.0',id:message.id,result}));
    }};
  }});
  const owner=createExternalMcpOwner({command:process.execPath,cwd:os.tmpdir(),args:[secret],sensitiveArgumentIndexes:[0],approvalOwner,receiptOwner,executionGuard});
  return {owner,secret,approvals,attempts,calls:()=>calls};
}

test('startup secrets in tool names, descriptions and schema are rejected before exposing catalog',async()=>{
  const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
  for(const tool of [
    {name:'MarkedLaunchSecret',description:'safe',inputSchema:schema},
    {name:'safe',description:'leaked MarkedLaunchSecret',inputSchema:schema},
    {name:'safe',description:'safe',inputSchema:{...schema,properties:{MarkedLaunchSecret:{type:'string'}}}},
    {name:'safe',description:'safe',inputSchema:{...schema,description:'MarkedLaunchSecret'}}
  ]){
    const c=syntheticDisclosureContext(tool),p=await c.owner.launchProposal(),result=await c.owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});
    assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(c.secret),false);assert.equal(c.owner.listTools().ok,false);assert.equal(c.attempts.length,0);
  }
});

test('a numeric representation of a marked string is redacted from structured output',async()=>{
  const c=syntheticDisclosureContext({name:'safe',inputSchema:{type:'object',additionalProperties:true}},'ok',{echo:123456789}),p=await c.owner.launchProposal();
  assert.equal((await c.owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'})).ok,true);
  const a=c.owner.prepareCall({name:'safe',args:{a:'123456789'},sensitivePaths:['/a']});assert.equal(a.ok,true);
  const outcome=await c.owner.call({proposalId:a.proposal.proposalId,approvalId:'fixture'});assert.equal(outcome.ok,true);assert.equal(JSON.stringify(outcome).includes('123456789'),false);await c.owner.close();
});

test('startup secret in unmarked call values or argument keys cannot reach proposal or receipt',async()=>{
  const c=syntheticDisclosureContext({name:'safe',description:'safe',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}},process.platform==='win32'?'MARKEDLAUNCHSECRET':'MarkedLaunchSecret');
  const p=await c.owner.launchProposal(),started=await c.owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});assert.equal(started.ok,true,JSON.stringify(started));
  const rejected=c.owner.prepareCall({name:'safe',args:{value:'prefix MarkedLaunchSecret suffix'}});assert.equal(rejected.code,'ARGUMENTS_DISCLOSURE_UNSAFE');
  assert.equal(JSON.stringify(rejected).includes(c.secret),false);assert.equal(c.attempts.length,0);assert.equal(c.calls(),0);
  const masked=c.owner.prepareCall({name:'safe',args:{value:'MarkedLaunchSecret'},sensitivePaths:['/value']});assert.equal(masked.ok,true);assert.equal(JSON.stringify(masked).includes(c.secret),false);
  const result=await c.owner.call({proposalId:masked.proposal.proposalId,approvalId:'fixture'});assert.equal(result.ok,true);assert.equal(JSON.stringify(result).toLowerCase().includes(c.secret.toLowerCase()),false);assert.equal(JSON.stringify(c.attempts).includes(c.secret),false);assert.equal(c.calls(),1);await c.owner.close();
  const keys=syntheticDisclosureContext({name:'safe',description:'safe',inputSchema:{type:'object',additionalProperties:{type:'string'}}});
  const k=await keys.owner.launchProposal();assert.equal((await keys.owner.start({proposalId:k.proposal.proposalId,approvalId:'fixture'})).ok,true);
  assert.equal(keys.owner.prepareCall({name:'safe',args:{MarkedLaunchSecret:'x'}}).code,'ARGUMENTS_DISCLOSURE_UNSAFE');assert.equal(keys.attempts.length,0);await keys.owner.close();
});

test('explicit call secrets cannot reappear in another argument, nested field, key, pointer or tool schema',async()=>{
  const secret='CallSecretOcean';
  const c=syntheticDisclosureContext({name:'safe',description:'safe',inputSchema:{type:'object',additionalProperties:true}},`echo ${secret}`);
  const p=await c.owner.launchProposal();assert.equal((await c.owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'})).ok,true);
  const cases=[
    {args:{a:secret,b:`prefix ${secret}`},sensitivePaths:['/a']},
    {args:{a:secret,nested:{value:secret}},sensitivePaths:['/a']},
    {args:{a:secret,[secret]:'x'},sensitivePaths:['/a']},
    {args:{[secret]:secret},sensitivePaths:[`/${secret}`]},
  ];
  for(const input of cases){const rejected=c.owner.prepareCall({name:'safe',...input});assert.equal(rejected.code,'ARGUMENTS_DISCLOSURE_UNSAFE');assert.equal(JSON.stringify(rejected).includes(secret),false);}
  assert.equal(c.owner.prepareCall({name:'safe',args:{a:'123456789',b:123456789},sensitivePaths:['/a']}).code,'ARGUMENTS_DISCLOSURE_UNSAFE');
  if(process.platform==='win32')assert.equal(c.owner.prepareCall({name:'safe',args:{a:'FALSE',b:false},sensitivePaths:['/a']}).code,'ARGUMENTS_DISCLOSURE_UNSAFE');
  assert.equal(c.attempts.length,0);assert.equal(c.calls(),0);
  const approved=c.owner.prepareCall({name:'safe',args:{a:secret},sensitivePaths:['/a']});assert.equal(approved.ok,true);assert.equal(JSON.stringify(approved).includes(secret),false);
  const result=await c.owner.call({proposalId:approved.proposal.proposalId,approvalId:'fixture'});assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(c.attempts).includes(secret),false);await c.owner.close();
  const schema=syntheticDisclosureContext({name:'safe',description:'safe',inputSchema:{type:'object',properties:{a:{type:'string'},[secret]:{type:'string'}},additionalProperties:true}});
  const s=await schema.owner.launchProposal();assert.equal((await schema.owner.start({proposalId:s.proposal.proposalId,approvalId:'fixture'})).ok,true);
  assert.equal(schema.owner.prepareCall({name:'safe',args:{a:secret},sensitivePaths:['/a']}).code,'ARGUMENTS_DISCLOSURE_UNSAFE');assert.equal(schema.attempts.length,0);await schema.owner.close();
});

test('non-string, empty and structured explicitly sensitive values are rejected before approval or dispatch',async()=>{
  const c=syntheticDisclosureContext({name:'safe',inputSchema:{type:'object',additionalProperties:true}}),p=await c.owner.launchProposal();
  assert.equal((await c.owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'})).ok,true);
  for(const value of [0,123456,true,false,null,'',[],['a'],{}, {inner:'private'}]){
    assert.equal(c.owner.prepareCall({name:'safe',args:{a:value},sensitivePaths:['/a']}).code,'ARGUMENTS_INVALID');
  }
  assert.equal(c.approvals.length,1);assert.equal(c.attempts.length,0);assert.equal(c.calls(),0);await c.owner.close();
});

test('closing during launch proposal cannot revive the closed owner',async()=>{
  const c=await context();const pending=c.owner.launchProposal();assert.equal(c.owner.view().phase,'preparing');
  assert.equal((await c.owner.close()).ok,true);assert.equal((await pending).code,'CANCELLED_BEFORE_START');assert.equal(c.owner.view().phase,'closed');
  assert.equal((await c.owner.launchProposal()).code,'INVALID_STATE');await assert.rejects(readFile(c.marker));
});

test('only one concurrent launch proposal can be prepared',async()=>{
  const c=await context();const first=c.owner.launchProposal(),second=c.owner.launchProposal();
  assert.equal((await second).code,'INVALID_STATE');assert.equal((await first).ok,true);assert.equal(c.owner.view().phase,'prepared');assert.equal((await c.owner.close()).ok,true);
});

test('launch requires one-use explicit approval and tool calls bind schema and exact arguments',async()=>{
  const c=await context();const proposal=await c.owner.launchProposal();assert.equal(proposal.ok,true);
  const denied=await c.owner.start({proposalId:proposal.proposal.proposalId,approvalId:'not-approved'});assert.equal(denied.code,'EXECUTION_APPROVAL_REQUIRED');
  const started=await c.owner.start({proposalId:proposal.proposal.proposalId,approvalId:c.allow('mcp_start',proposal.proposal)});assert.equal(started.ok,true,JSON.stringify(started));
  assert.equal(started.tools.length,1);assert.equal(started.tools[0].sideEffects,'unknown');
  assert.equal(c.owner.prepareCall({name:'record',args:{wrong:'x'}}).code,'ARGUMENTS_SCHEMA_INVALID');
  const mutable={value:'before'},p=c.owner.prepareCall({name:'record',args:mutable});assert.equal(p.ok,true);mutable.value='after';
  const answer=await c.owner.call({proposalId:p.proposal.proposalId,approvalId:c.allow('mcp_call',p.proposal)});
  assert.equal(answer.ok,true,JSON.stringify(answer));assert.equal(c.events[0].outcome,'unknown');assert.equal(c.events[1].outcome,'response_received');
  const lines=(await readFile(c.marker,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(lines,[{value:'before'}]);
  assert.equal((await c.owner.call({proposalId:p.proposal.proposalId,approvalId:'old'})).code,'PROPOSAL_INVALID');
  assert.equal((await c.owner.close()).ok,true);
});

test('timeout keeps unknown attempt and never automatically replays',async()=>{
  const c=await context('delay');await start(c);const p=c.owner.prepareCall({name:'record',args:{value:'once'}});assert.equal(p.ok,true);
  const result=await c.owner.call({proposalId:p.proposal.proposalId,approvalId:c.allow('mcp_call',p.proposal),timeoutMs:100});
  assert.equal(result.code,'RESULT_UNKNOWN');assert.equal(result.receipt.outcome,'unknown');assert.equal(c.owner.prepareCall({name:'record',args:{value:'twice'}}).code,'INVALID_STATE');
  await new Promise(resolve=>setTimeout(resolve,1100));assert.deepEqual((await readFile(c.marker,'utf8')).trim().split('\n').map(JSON.parse),[{value:'once'}]);
  assert.equal(c.events.length,1);assert.equal((await c.owner.close()).ok,true);
});

test('tool list change during a call invalidates the snapshot and retains unknown',async()=>{
  const c=await context('notify');await start(c);const p=c.owner.prepareCall({name:'record',args:{value:'once'}});
  const result=await c.owner.call({proposalId:p.proposal.proposalId,approvalId:c.allow('mcp_call',p.proposal)});
  assert.equal(result.code,'RESULT_UNKNOWN');assert.equal(result.receipt.outcome,'unknown');assert.equal(c.owner.prepareCall({name:'record',args:{value:'twice'}}).code,'INVALID_STATE');
  assert.deepEqual((await readFile(c.marker,'utf8')).trim().split('\n').map(JSON.parse),[{value:'once'}]);assert.equal(c.events.length,1);assert.equal((await c.owner.close()).ok,true);
});

test('durable attempt failure stops before send and holds unknown',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-receipt-')),marker=path.join(root,'events');
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return false;},async recordOutcome(){throw new Error('unexpected');}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,marker,'none'],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  const l=await owner.launchProposal();assert.equal((await owner.start({proposalId:l.proposal.proposalId,approvalId:'approved'})).ok,true);
  const p=owner.prepareCall({name:'record',args:{value:'not-sent'}}),result=await owner.call({proposalId:p.proposal.proposalId,approvalId:'approved'});
  assert.equal(result.code,'RECEIPT_UNCONFIRMED');assert.equal(owner.view().unknown,true);await assert.rejects(readFile(marker));assert.equal((await owner.close()).ok,true);
});

test('close during human launch approval never starts a server',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-approval-'));let resolveApproval;
  const approvalOwner=Object.freeze({consume(){return new Promise(resolve=>{resolveApproval=resolve;});}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  const l=await owner.launchProposal(),started=owner.start({proposalId:l.proposal.proposalId,approvalId:'pending'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal((await owner.close()).ok,true);resolveApproval(true);
  assert.equal((await started).code,'CANCELLED_BEFORE_START');assert.equal(owner.view().phase,'closed');
});

test('without an executable identity guard no user approval is consumed and nothing starts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-guard-'));let count=0;
  const approvalOwner=Object.freeze({async consume(){count++;return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner,receiptOwner});
  const p=await owner.launchProposal(),r=await owner.start({proposalId:p.proposal.proposalId,approvalId:'anything'});
  assert.equal(r.code,'EXECUTABLE_IDENTITY_UNVERIFIED');assert.equal(count,0);assert.equal((await owner.close()).ok,true);
});

test('unresolved durable receipt blocks server startup before approval and spawn',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-unresolved-'));let count=0;
  const approvalOwner=Object.freeze({async consume(){count++;return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[{attemptId:'old'}]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  const p=await owner.launchProposal(),r=await owner.start({proposalId:p.proposal.proposalId,approvalId:'anything'});
  assert.equal(r.code,'RECEIPT_RECOVERY_REQUIRED');assert.equal(count,0);await assert.rejects(readFile(path.join(root,'events')));assert.equal((await owner.close()).ok,true);
});

test('denied call approval resolving after close does not restore a closed owner',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-call-close-'));let resolveCall;
  const approvalOwner=Object.freeze({consume({kind}){return kind==='mcp_start'?Promise.resolve(true):new Promise(resolve=>{resolveCall=resolve;});}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  const l=await owner.launchProposal();assert.equal((await owner.start({proposalId:l.proposal.proposalId,approvalId:'launch'})).ok,true);
  const p=owner.prepareCall({name:'record',args:{value:'x'}}),pending=owner.call({proposalId:p.proposal.proposalId,approvalId:'pending'});
  await new Promise(resolve=>setImmediate(resolve));let settled=false;const closing=owner.close().then(r=>{settled=true;return r;});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(settled,false);resolveCall(false);
  assert.equal((await pending).code,'CALL_APPROVAL_REQUIRED');assert.equal((await closing).ok,true);assert.equal(owner.view().phase,'closed');
});

test('close waits for an in-flight durable attempt and never dispatches it after closing',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-receipt-close-')),marker=path.join(root,'events');let resolveAttempt,entered;
  const enteredAttempt=new Promise(resolve=>{entered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},recordAttempt(){entered();return new Promise(resolve=>{resolveAttempt=resolve;});},async recordOutcome(){throw new Error('unexpected');}});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,marker,'none'],cwd:root,approvalOwner,receiptOwner,executionGuard:testExecutionGuard});
  const l=await owner.launchProposal();assert.equal((await owner.start({proposalId:l.proposal.proposalId,approvalId:'launch'})).ok,true);
  const p=owner.prepareCall({name:'record',args:{value:'never sent'}}),pending=owner.call({proposalId:p.proposal.proposalId,approvalId:'approved'});await enteredAttempt;
  let settled=false;const closing=owner.close().then(r=>{settled=true;return r;});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(settled,false);
  resolveAttempt(true);assert.equal((await pending).code,'RESULT_UNKNOWN');assert.equal((await closing).ok,true);await assert.rejects(readFile(marker));assert.equal(owner.view().phase,'closed');
});

test('explicitly marked inputs are masked in proposal and durable attempt but sent correctly',async()=>{
  const c=await context();await start(c);const p=c.owner.prepareCall({name:'record',args:{value:'private-value'},sensitivePaths:['/value']});
  assert.equal(p.proposal.arguments.value,'[REDACTED]');
  const result=await c.owner.call({proposalId:p.proposal.proposalId,approvalId:c.allow('mcp_call',p.proposal)});assert.equal(result.ok,true);
  assert.equal(c.events[0].arguments.value,'[REDACTED]');assert.equal(JSON.stringify(c.events).includes('private-value'),false);
  assert.equal(JSON.parse((await readFile(c.marker,'utf8')).trim()).value,'private-value');assert.equal((await c.owner.close()).ok,true);
});

test('optional SDK absence does not prevent importing the owner and fails only on explicit start',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-no-sdk-'));await copyFile(ownerSource,path.join(root,'owner.mjs'));
  const source=`import {createExternalMcpOwner} from './owner.mjs';
    const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]}},async recordAttempt(){return true},async recordOutcome(){return true}});
    const executionGuard=Object.freeze({async createTransport(){throw new Error('must not run')}});
    const owner=createExternalMcpOwner({command:process.execPath,args:[],cwd:process.cwd(),approvalOwner,receiptOwner,executionGuard});
    const p=await owner.launchProposal();const result=await owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});console.log(JSON.stringify(result));`;
  await writeFile(path.join(root,'check.mjs'),source);
  const {stdout}=await promisify(execFile)(process.execPath,[path.join(root,'check.mjs')],{cwd:root,windowsHide:true,timeout:15000});
  assert.equal(JSON.parse(stdout).code,'MCP_RUNTIME_UNAVAILABLE');
});
