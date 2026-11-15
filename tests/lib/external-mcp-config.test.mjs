import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {createExternalMcpConfigRegistry} from '../../lib/external-mcp-config.mjs';

const cwd=path.dirname(process.execPath);
const base=()=>({name:'本机工具',command:process.execPath,cwd,args:[{value:'plain',sensitive:false},{value:'marked-secret-value',sensitive:true}]});
function registry(){
  let approvals=0,receipts=0;
  const approvalOwner=Object.freeze({async consume(){approvals++;return false;}});
  const receiptOwner=Object.freeze({async ready(){receipts++;return {ok:true,unresolved:[]};},async recordAttempt(){receipts++;return false;},async recordOutcome(){receipts++;return false;}});
  return {config:createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner}}),calls:()=>({approvals,receipts})};
}

test('add, edit and list keep marked arguments hidden, without disk or process operations',()=>{
  const {config,calls}=registry(),original=base(),added=config.add(original);original.args[0].value='changed';
  assert.deepEqual(added.args,[{value:'plain',sensitive:false},{value:'[REDACTED]',sensitive:true}]);
  const edited=config.replace({id:added.id,revision:added.revision,configuration:{...base(),name:'已编辑',args:[{value:'after',sensitive:false},{preserveSensitiveAt:1}]}});
  assert.equal(edited.revision,2);assert.equal(config.list()[0].name,'已编辑');
  assert.equal(JSON.stringify(config.list()).includes('marked-secret-value'),false);
  assert.throws(()=>config.replace({id:added.id,revision:1,configuration:base()}),/changed or is unavailable/);
  assert.deepEqual(config.remove({id:added.id,revision:2}),{removed:true});assert.deepEqual(config.list(),[]);
  assert.deepEqual(calls(),{approvals:0,receipts:0});
});

test('only marked prior arguments can be preserved, and validation never echoes secret values',()=>{
  const {config}=registry(),added=config.add(base());
  for(const args of [[{preserveSensitiveAt:0}],[{preserveSensitiveAt:9}],[{value:'secret-here',sensitive:'yes'}]]){
    assert.throws(()=>config.replace({id:added.id,revision:1,configuration:{...base(),args}}),error=>!error.message.includes('secret-here'));
  }
  assert.equal(config.list()[0].revision,1);
});

test('rejects relative commands, unsupported executable form, oversized or malformed arguments',()=>{
  const {config}=registry();
  const inputs=[{...base(),command:'relative.exe'},{...base(),cwd:'relative'},{...base(),args:new Array(1)},{...base(),args:Array.from({length:33},()=>({value:'a',sensitive:false}))},{...base(),args:[{value:'a'.repeat(8200),sensitive:false}]}];
  if(process.platform==='win32')inputs.push({...base(),command:path.join(cwd,'server.cmd')});
  for(const input of inputs)assert.throws(()=>config.add(input),/Invalid/);
  const args=[];Object.defineProperty(args,'0',{get(){throw new Error('accessor called');},enumerable:true});args.length=1;
  assert.throws(()=>config.add({...base(),args}),/Invalid/);assert.deepEqual(config.list(),[]);
});

test('secret repeated in visible fields is rejected instead of leaking through a launch proposal',()=>{
  const {config}=registry();
  for(const input of [{...base(),name:'marked-secret-value'},{...base(),args:[{value:'marked-secret-value',sensitive:true},{value:'--token=marked-secret-value',sensitive:false}]}])assert.throws(()=>config.add(input),/Invalid/);
});

test('prepare returns an unstarted owner, with redacted launch proposal and no automatic start',async()=>{
  const {config,calls}=registry(),item=config.add(base()),owner=config.prepare({id:item.id,revision:item.revision});
  assert.equal(owner.view().phase,'new');const proposal=await owner.launchProposal();assert.equal(proposal.ok,true);
  assert.deepEqual(proposal.proposal.args,['plain','[REDACTED]']);assert.equal(JSON.stringify(proposal).includes('marked-secret-value'),false);
  assert.deepEqual(calls(),{approvals:0,receipts:0});
  assert.equal((await owner.start({proposalId:proposal.proposal.proposalId,approvalId:'not-approved'})).code,'EXECUTABLE_IDENTITY_UNVERIFIED');
  assert.equal((await owner.close()).ok,true);assert.deepEqual(calls(),{approvals:0,receipts:0});
  config.close();assert.throws(()=>config.list(),/closed/);assert.throws(()=>config.prepare({id:item.id,revision:1}),/closed/);
});

test('replacement, removal and registry closure revoke old owners without closing their receipts',async()=>{
  for(const action of ['replace','remove','close']){
    const {config}=registry(),item=config.add(base()),owner=config.prepare({id:item.id,revision:1});
    if(action==='replace')config.replace({id:item.id,revision:1,configuration:base()});
    if(action==='remove')config.remove({id:item.id,revision:1});
    if(action==='close')config.close();
    assert.equal((await owner.launchProposal()).code,'CONFIGURATION_REVOKED');assert.equal(owner.view().phase,'new');
    assert.equal((await owner.close()).ok,true);
  }
});

test('revocation during asynchronous approval or guard preparation prevents guard start',async()=>{
  for(const stage of ['approval','guard']){
    let release,entered,started=0;const waiting=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
    const approvalOwner=Object.freeze({async consume(){if(stage==='approval'){entered();await waiting;}return true;}});
    const receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
    const executionGuard=Object.freeze({async createTransport(){if(stage==='guard'){entered();await waiting;}return {start(){started++;},send(){},close(){}};},async disposeUnstarted(){return true;}});
    const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
    const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await arrived;config.remove({id:item.id,revision:1});release();
    assert.equal((await pending).code,'CONFIGURATION_REVOKED');assert.equal(started,0);assert.equal((await owner.close()).ok,true);
  }
});

test('failed unstarted guard disposal retains the same owner and supports cleanup retry',async()=>{
  let release,entered,disposed=0,starts=0;const waiting=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const raw={start(){starts++;},send(){},close(){}};
  const executionGuard=Object.freeze({async createTransport(){entered();await waiting;return raw;},async disposeUnstarted({transport}){assert.equal(transport,raw);return ++disposed>1;}});
  const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
  const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await arrived;config.remove({id:item.id,revision:1});release();
  assert.equal((await pending).code,'CLEANUP_UNCONFIRMED');assert.equal(owner.view().phase,'cleanup_pending');assert.equal(starts,0);assert.equal((await owner.close()).ok,true);assert.equal(disposed,2);
});

test('close while guard is preparing keeps the returned transport until disposal confirms',async()=>{
  let release,entered,disposed=0;const waiting=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const raw={start(){throw new Error('unexpected start');},send(){},close(){}};
  const executionGuard=Object.freeze({async createTransport(){entered();await waiting;return raw;},async disposeUnstarted({transport}){assert.equal(transport,raw);disposed++;return true;}});
  const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
  const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await arrived;assert.equal((await owner.close()).code,'START_IN_PROGRESS');release();
  assert.equal((await pending).code,'CANCELLED_BEFORE_START');assert.equal(disposed,1);assert.equal(owner.view().phase,'closed');
});

test('missing unstarted-disposal proof cannot release retained guard resources',async()=>{
  let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const executionGuard=Object.freeze({async createTransport(){entered();await waiting;return {start(){},send(){},close(){}};}});
  const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
  const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await arrived;config.remove({id:item.id,revision:1});release();
  assert.equal((await pending).code,'CLEANUP_UNCONFIRMED');assert.equal((await owner.close()).code,'CLEANUP_UNCONFIRMED');assert.equal(owner.view().phase,'cleanup_pending');
});

test('timed-out disposal keeps the in-flight cleanup owner and does not start a duplicate',async()=>{
  let releaseCreate,createEntered,releaseDispose,disposeEntered,calls=0;
  const createWait=new Promise(resolve=>{releaseCreate=resolve;}),created=new Promise(resolve=>{createEntered=resolve;});
  const disposeWait=new Promise(resolve=>{releaseDispose=resolve;}),disposing=new Promise(resolve=>{disposeEntered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const executionGuard=Object.freeze({async createTransport(){createEntered();await createWait;return {start(){},send(){},close(){}};},async disposeUnstarted(){calls++;disposeEntered();await disposeWait;return true;}});
  const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
  const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await created;config.remove({id:item.id,revision:1});releaseCreate();await disposing;
  assert.equal((await pending).code,'CLEANUP_UNCONFIRMED');assert.equal(calls,1);
  const closing=owner.close();releaseDispose();assert.equal((await closing).ok,true);assert.equal(calls,1);
});

test('a launch already handed to a guard remains owned while configuration is removed',async()=>{
  let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const approvalOwner=Object.freeze({async consume(){return true;}}),receiptOwner=Object.freeze({async ready(){return {ok:true,unresolved:[]};},async recordAttempt(){return true;},async recordOutcome(){return true;}});
  const executionGuard=Object.freeze({async createTransport(){return {onclose:null,start(){entered();return waiting.then(()=>{throw new Error('fixture launch outcome');});},send(){},close(){this.onclose?.();}};}});
  const config=createExternalMcpConfigRegistry({ownerDependencies:{approvalOwner,receiptOwner,executionGuard}}),item=config.add(base()),owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();
  const pending=owner.start({proposalId:p.proposal.proposalId,approvalId:'fixture'});await arrived;config.remove({id:item.id,revision:1});
  assert.equal(owner.view().phase,'starting');release();const result=await pending;assert.equal(result.ok,false);assert.notEqual(owner.view().phase,'new');
  assert.equal((await owner.close()).ok,true);
});

test('resolved path cannot disclose a sensitive argument even when input alias did not',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-config-')),target=path.join(root,'McpResolvedPrivateName'),alias=path.join(root,'alias');
  try{
    await mkdir(target);await symlink(target,alias,process.platform==='win32'?'junction':'dir');
    const {config}=registry(),item=config.add({...base(),cwd:alias,args:[{value:'McpResolvedPrivateName',sensitive:true}]});
    const owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();assert.equal(p.ok,false);assert.equal(JSON.stringify(p).includes('McpResolvedPrivateName'),false);assert.equal((await owner.close()).ok,true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows resolved path matching does not disclose case variants of a marked argument',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-config-')),target=path.join(root,'McpResolvedPrivateName');
  try{
    await mkdir(target);const {config}=registry(),item=config.add({...base(),cwd:target,args:[{value:'mcpresolvedprivatename',sensitive:true}]});
    const owner=config.prepare({id:item.id,revision:1}),p=await owner.launchProposal();assert.equal(p.ok,false);assert.equal((await owner.close()).ok,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
