import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createDynamicTerminalOwner} from '../lib/dynamic-terminal-owner.mjs';

const scope=Object.freeze({client:'test-client',conversationId:'test-conversation',threadId:'thread',turnId:'turn',generation:1,revision:1,account:null});
const request=(args,id='call')=>({threadId:'thread',turnId:'turn',callId:id,tool:'buildx_terminal',arguments:args});
async function temp(){
  const base=await realpath(os.tmpdir()),dir=await mkdtemp(path.join(base,'buildx-dynamic-terminal-')),actual=await realpath(dir);
  if(path.dirname(actual)!==base||!path.basename(actual).startsWith('buildx-dynamic-terminal-'))throw new Error('Unexpected test directory');
  return actual;
}
async function missing(file){try{await stat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}

test('real terminal action starts exactly once after matching approval; display matches actual command',async()=>{
  const dir=await temp(),marker=path.join(dir,'marker');const owner=createDynamicTerminalOwner();
  try{
    const args={executable:process.execPath,cwd:dir,args:['-e',"require('node:fs').writeFileSync(process.argv[1],'done');process.stdout.write('ok')",marker]};
    const p=owner.propose({params:request(args),scope,isCurrent:()=>true});assert.ok(Object.isFrozen(p));
    assert.equal(p.target,process.execPath);assert.equal(p.cwd,dir);assert.deepEqual(JSON.parse(p.parameters),args.args);
    await delay(80);assert.equal(await missing(marker),true);
    await assert.rejects(owner.decide({ticket:p.ticket,digest:'wrong',decision:'accept'}));assert.equal(await missing(marker),true);
    const result=await owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
    assert.equal(result.success,true);assert.equal(JSON.parse(result.contentItems[0].text).stdout,'ok');assert.equal(await readFile(marker,'utf8'),'done');
    await assert.rejects(owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}));
    assert.throws(()=>owner.propose({params:request(args),scope,isCurrent:()=>true}),/Duplicate/);
  }finally{assert.equal((await owner.close()).closed,true);await rm(dir,{recursive:true,force:true});}
});

test('denial, expired permission and changed current turn never start a real process',async()=>{
  const dir=await temp(),marker=path.join(dir,'marker');let active=true;const owner=createDynamicTerminalOwner({approvalTimeoutMs:80});
  try{
    const args={executable:process.execPath,cwd:dir,args:['-e',"require('node:fs').writeFileSync(process.argv[1],'bad')",marker]};
    const denied=owner.propose({params:request(args,'deny'),scope,isCurrent:()=>active});
    assert.equal((await owner.decide({ticket:denied.ticket,digest:denied.digest,decision:'decline'})).success,false);
    const stale=owner.propose({params:request(args,'stale'),scope,isCurrent:()=>active});active=false;
    await assert.rejects(owner.decide({ticket:stale.ticket,digest:stale.digest,decision:'accept'}));await owner.cancel({ticket:stale.ticket});
    active=true;const expired=owner.propose({params:request(args,'expired'),scope,isCurrent:()=>active});await delay(130);
    await assert.rejects(owner.decide({ticket:expired.ticket,digest:expired.digest,decision:'accept'}));
    assert.equal(await missing(marker),true);
  }finally{assert.equal((await owner.close()).closed,true);await rm(dir,{recursive:true,force:true});}
});

test('other tools, unbound identities and extra argument fields are rejected',async()=>{
  const owner=createDynamicTerminalOwner();
  try{
    const args={executable:process.execPath,cwd:process.cwd(),args:[]};
    assert.throws(()=>owner.propose({params:{...request(args),tool:'revit_execute_csharp'},scope,isCurrent:()=>true}));
    assert.throws(()=>owner.propose({params:request({...args,extra:true}),scope,isCurrent:()=>true}));
    assert.throws(()=>owner.propose({params:request(args),scope:{...scope,turnId:'other'},isCurrent:()=>true}));
    assert.throws(()=>owner.propose({params:request(args),scope,isCurrent:()=>false}));
  }finally{assert.equal((await owner.close()).closed,true);}
});

test('closing the owner retains and stops its own running test child',async()=>{
  const owner=createDynamicTerminalOwner({executionTimeoutMs:5000});
  const p=owner.propose({params:request({executable:process.execPath,cwd:process.cwd(),args:['-e','setTimeout(()=>{},5000)']}),scope,isCurrent:()=>true});
  const execution=owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
  await delay(100);assert.equal((await owner.close()).closed,true);await assert.rejects(execution,/unknown/);
});

test('a real launch error reports unknown without retry',async()=>{
  const dir=await temp(),owner=createDynamicTerminalOwner();
  try{
    const p=owner.propose({params:request({executable:path.join(dir,'no-such-program.exe'),cwd:dir,args:[]}),scope,isCurrent:()=>true});
    await assert.rejects(owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}),/unknown/);
    await assert.rejects(owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}));
  }finally{assert.equal((await owner.close()).closed,true);await rm(dir,{recursive:true,force:true});}
});
