import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createPanelAudit,inspectExistingPanelDirectory} from '../lib/panel-audit.mjs';

const id=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const exists=async target=>{try{await fs.lstat(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rea-audit-boundary-'));
  const original=id(await fs.lstat(root,{bigint:true})),real=await fs.realpath(root);
  function inside(...parts){
    const target=path.resolve(root,...parts),relative=path.relative(root,target);
    assert.ok(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));
    return target;
  }
  t.after(async()=>{
    const now=await fs.lstat(root,{bigint:true});
    assert.equal(id(now),original);assert.ok(now.isDirectory()&&!now.isSymbolicLink());
    assert.equal(await fs.realpath(root),real);
    const retained=[];
    async function inspect(target){
      inside(path.relative(root,target));
      const stat=await fs.lstat(target,{bigint:true});
      if(stat.isSymbolicLink())inside(path.relative(root,await fs.realpath(target)));
      else if(stat.isDirectory())for(const entry of await fs.readdir(target))await inspect(inside(path.relative(root,target),entry));
      else assert.ok(stat.isFile());
      retained.push({target,identity:id(stat),directory:stat.isDirectory()&&!stat.isSymbolicLink()});
    }
    await inspect(root);
    for(const resource of retained){
      assert.equal(id(await fs.lstat(resource.target,{bigint:true})),resource.identity);
      if(resource.directory)await fs.rmdir(resource.target);else await fs.unlink(resource.target);
    }
    assert.equal(await exists(root),false);
  });
  return {root,at:inside,mkdir:async(...parts)=>{const target=inside(...parts);await fs.mkdir(target);return target;}};
}
function rejected(result,code){assert.equal(result.ok,false);assert.equal(result.error.code,code);assert.equal(result.value.queued,0);}

test('directory inspection returns frozen complete metadata and caller spelling without file or directory handles',async t=>{
  const f=await fixture(t),directory=await f.mkdir('ordinary'),requested=f.root+path.sep+path.sep+'ordinary',calls=[];
  const originals=[];
  for(const [api,names]of [[fsSync,['mkdirSync','openSync','readFileSync','opendirSync']],[fs,['mkdir','open','readFile','opendir']]])
    for(const name of names)originals.push(t.mock.method(api,name,()=>{calls.push(name);throw new Error('Unexpected resource operation');}));
  const before=Date.now(),result=inspectExistingPanelDirectory(requested),after=Date.now();
  for(const original of originals)original.mock.restore();
  assert.equal(result.ok,true);assert.deepEqual(calls,[]);
  const value=result.value;assert.equal(value.path,directory);assert.equal(value.requested,requested);
  assert.ok(Date.parse(value.observedAt)>=before&&Date.parse(value.observedAt)<=after);
  assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.chain),true);
  assert.equal(value.chain[0].path,path.parse(directory).root);assert.equal(value.chain.at(-1).path,directory);
  for(const [index,part]of value.chain.entries()){
    assert.equal(Object.isFrozen(part),true);assert.equal(part.identity,id(await fs.lstat(part.path,{bigint:true})));
    if(index)assert.equal(path.dirname(part.path),value.chain[index-1].path);
  }
  assert.throws(()=>value.chain.at(-1).identity='forged',TypeError);
  assert.throws(()=>value.chain.push({path:'outside',identity:'forged'}),TypeError);
});

test('directory inspection rejects missing, invalid, non-directory and linked paths without creating missing names',async t=>{
  const f=await fixture(t),missing=f.at('missing','suffix'),file=f.at('file'),physical=await f.mkdir('physical'),alias=f.at('alias');
  await fs.writeFile(file,'ordinary-file\n');fsSync.symlinkSync(physical,alias,'junction');
  for(const [input,code]of [[missing,'audit_directory_missing'],['relative','audit_directory_path_invalid'],[new URL('file:///not-a-string'),'audit_directory_path_invalid'],[file,'audit_not_directory'],[alias,'audit_directory_link']])
    assert.deepEqual(inspectExistingPanelDirectory(input),{ok:false,error:{code}});
  assert.equal(await exists(f.at('missing')),false);assert.equal(await fs.readFile(file,'utf8'),'ordinary-file\n');
  assert.deepEqual(await fs.readdir(physical),[]);
});

test('directory inspection snapshots do not acquire permanent identity after an ordinary path is replaced',async t=>{
  const f=await fixture(t),directory=await f.mkdir('observed'),first=inspectExistingPanelDirectory(directory);assert.equal(first.ok,true);
  const firstIdentity=first.value.chain.at(-1).identity;
  fsSync.renameSync(directory,f.at('displaced'));fsSync.mkdirSync(directory);
  const second=inspectExistingPanelDirectory(directory);assert.equal(second.ok,true);
  assert.notEqual(second.value.chain.at(-1).identity,firstIdentity);assert.equal(first.value.chain.at(-1).identity,firstIdentity);
  assert.equal(first.value.path,second.value.path);assert.equal(firstIdentity,id(await fs.lstat(f.at('displaced'),{bigint:true})));
  assert.equal(second.value.chain.at(-1).identity,id(await fs.lstat(directory,{bigint:true})));
});

test('directory inspection uses the shared fixed error classification without private I/O text',async t=>{
  const f=await fixture(t),target=await f.mkdir('unobservable'),original=fsSync.lstatSync;
  t.mock.method(fsSync,'lstatSync',(name,...args)=>{if(name===target)throw Object.assign(new Error('private filesystem error'),{code:'EIO'});return original(name,...args);});
  assert.deepEqual(inspectExistingPanelDirectory(target),{ok:false,error:{code:'audit_io_failed'}});
});

test('an expected ancestor refuses replacement before writer capture without log inspection or mkdir',async t=>{
  const f=await fixture(t),data=await f.mkdir('data'),expected=inspectExistingPanelDirectory(data);assert.equal(expected.ok,true);
  fsSync.renameSync(data,f.at('displaced'));fsSync.mkdirSync(data);
  const run=f.at('data','run');fsSync.mkdirSync(run);await fs.writeFile(f.at('data','run','lifecycle.jsonl'),'replacement-evidence\n');
  const originalLstat=fsSync.lstatSync;let logInspections=0,mkdirCalls=0,opens=0;
  const targetLogs=new Set(['connection-status.json','lifecycle.jsonl','tool-calls.jsonl'].map(file=>path.join(run,file)));
  t.mock.method(fsSync,'lstatSync',(target,...args)=>{if(targetLogs.has(target))logInspections++;return originalLstat(target,...args);});
  t.mock.method(fs,'mkdir',()=>{mkdirCalls++;throw new Error('Unexpected mkdir');});
  t.mock.method(fs,'open',()=>{opens++;throw new Error('Unexpected open');});
  const audit=createPanelAudit(run,{requireNewDirectory:true,expectedAncestor:expected.value});
  rejected(await audit.ready(),'audit_directory_changed');audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  rejected(await audit.flush(),'audit_directory_changed');assert.equal((await audit.close()).value.closed,true);
  assert.equal(logInspections,0);assert.equal(mkdirCalls,0);assert.equal(opens,0);
  assert.equal(await fs.readFile(f.at('data','run','lifecycle.jsonl'),'utf8'),'replacement-evidence\n');
});

test('an expected ancestor captures immutable data once and matching facts permit only the configured strict new run',async t=>{
  const f=await fixture(t),data=await f.mkdir('data'),expected=inspectExistingPanelDirectory(data).value,run=f.at('data','run');let optionReads=0,accessorReads=0;
  const options={requireNewDirectory:true};Object.defineProperty(options,'expectedAncestor',{get(){optionReads++;return optionReads===1?expected:null;}});
  const audit=createPanelAudit(run,options);assert.equal((await audit.ready()).ok,true);
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);assert.equal((await audit.flush()).ok,true);
  assert.equal((await audit.close()).value.closed,true);assert.equal(optionReads,1);assert.equal(JSON.parse(await fs.readFile(f.at('data','run','lifecycle.jsonl'),'utf8')).code,'service_started');
  const frozen=value=>Object.freeze(value),rootRow=expected.chain[0],badAccessor=frozen({get path(){accessorReads++;return expected.path;},chain:expected.chain});
  const badRow=frozen({path:rootRow.path,get identity(){accessorReads++;return rootRow.identity;}});
  for(const constraint of [null,{...expected},badAccessor,frozen({path:expected.path,chain:[...expected.chain]}),
    frozen({path:expected.path,chain:frozen(expected.chain.map(row=>({...row})))}),
    frozen({path:rootRow.path,chain:frozen([badRow])}),frozen({path:rootRow.path,chain:frozen(new Array(1))}),
    frozen({path:rootRow.path,chain:frozen(Array(66).fill(rootRow))}),frozen({path:expected.path,chain:frozen([rootRow])})]){
    const rejectedOwner=createPanelAudit(f.at('unused'),{requireNewDirectory:true,expectedAncestor:constraint});
    rejected(await rejectedOwner.ready(),'audit_ancestor_constraint_invalid');assert.equal((await rejectedOwner.close()).value.closed,true);
  }
  assert.equal(Object.hasOwn(Object.prototype,'path'),false);
  let inheritedOwner;
  try{
    Object.defineProperty(Object.prototype,'path',{value:{value:expected.path},configurable:true});
    inheritedOwner=createPanelAudit(f.at('unused'),{requireNewDirectory:true,expectedAncestor:frozen({chain:expected.chain})});
  }finally{delete Object.prototype.path;}
  rejected(await inheritedOwner.ready(),'audit_ancestor_constraint_invalid');assert.equal((await inheritedOwner.close()).value.closed,true);
  assert.equal(accessorReads,0);assert.equal(await exists(f.at('unused')),false);
});

test('exclusive audit refuses existing empty or recorded run directories without inspecting target logs',async t=>{
  const f=await fixture(t),empty=await f.mkdir('empty'),old=await f.mkdir('old');
  const oldRecord=f.at('old','server.json'),oldLog=f.at('old','lifecycle.jsonl');
  await fs.writeFile(oldRecord,'old-run-record\n');await fs.writeFile(oldLog,'old-run-evidence\n');
  const originalLstat=fsSync.lstatSync,targets=new Set([empty,old].flatMap(directory=>['connection-status.json','lifecycle.jsonl','tool-calls.jsonl'].map(file=>path.join(directory,file))));
  let logInspections=0;
  t.mock.method(fsSync,'lstatSync',(target,...args)=>{if(targets.has(target))logInspections++;return originalLstat(target,...args);});
  for(const directory of [empty,old]){
    const audit=createPanelAudit(directory,{requireNewDirectory:true});
    rejected(await audit.ready(),'audit_directory_exists');
    audit.audit('lifecycle.jsonl',{code:'service_started'},true);await audit.flush();
    assert.equal((await audit.close()).value.closed,true);
  }
  assert.equal(logInspections,0);assert.deepEqual(await fs.readdir(empty),[]);
  assert.equal(await fs.readFile(oldRecord,'utf8'),'old-run-record\n');assert.equal(await fs.readFile(oldLog,'utf8'),'old-run-evidence\n');
});

test('exclusive audit cannot adopt a run created by another actor at its mkdir boundary',async t=>{
  const f=await fixture(t),run=f.at('run'),foreignRecord=f.at('run','server.json'),originalMkdir=fs.mkdir;
  const audit=createPanelAudit(run,{requireNewDirectory:true});let mkdirCalls=0;
  t.mock.method(fs,'mkdir',async(target,...args)=>{
    assert.equal(target,run);assert.equal(args.length,0);mkdirCalls++;
    await originalMkdir(target);await fs.writeFile(foreignRecord,'foreign-run-record\n');
    return originalMkdir(target,...args);
  });
  rejected(await audit.ready(),'audit_directory_changed');
  const foreignIdentity=id(await fs.lstat(run,{bigint:true}));
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  rejected(await audit.ready(),'audit_directory_changed');await audit.flush();
  assert.equal((await audit.close()).value.closed,true);assert.equal(mkdirCalls,1);
  assert.equal(id(await fs.lstat(run,{bigint:true})),foreignIdentity);
  assert.equal(await fs.readFile(foreignRecord,'utf8'),'foreign-run-record\n');assert.deepEqual(await fs.readdir(run),['server.json']);
});

test('exclusive audit captures one strict boolean and owns a single successful mkdir across repeated ready and bounded writes',async t=>{
  const f=await fixture(t),run=f.at('run'),originalMkdir=fs.mkdir;let mkdirCalls=0,optionReads=0;
  for(const value of [null,0,1,'true',{},[]])assert.throws(()=>createPanelAudit(f.at('unused'),{requireNewDirectory:value}),/Invalid audit configuration/);
  const options={maxQueued:1};Object.defineProperty(options,'requireNewDirectory',{get(){optionReads++;return optionReads===1?true:false;}});
  const audit=createPanelAudit(run,options);
  t.mock.method(fs,'mkdir',async(target,...args)=>{assert.equal(target,run);assert.equal(args.length,0);mkdirCalls++;return originalMkdir(target,...args);});
  assert.equal((await audit.ready()).ok,true);const issued=id(await fs.lstat(run,{bigint:true}));
  assert.equal((await audit.ready()).ok,true);
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);audit.audit('lifecycle.jsonl',{code:'service_stopping'},true);
  assert.equal((await audit.flush()).ok,true);assert.equal(audit.state().dropped,1);
  const closed=await audit.close();assert.equal(closed.ok,true);assert.equal(closed.value.closed,true);
  assert.equal(optionReads,1);assert.equal(mkdirCalls,1);assert.equal(id(await fs.lstat(run,{bigint:true})),issued);
  const lines=(await fs.readFile(f.at('run','lifecycle.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).code,'service_started');
});

test('exclusive audit preserves an unknown mkdir outcome without retry, adoption, fallback or claimed directory rollback',async t=>{
  const f=await fixture(t),run=f.at('run'),originalMkdir=fs.mkdir,audit=createPanelAudit(run,{requireNewDirectory:true});let mkdirCalls=0;
  t.mock.method(fs,'mkdir',async(target,...args)=>{
    assert.equal(target,run);assert.equal(args.length,0);mkdirCalls++;
    await originalMkdir(target,...args);throw Object.assign(new Error('private creation outcome'),{code:'EIO'});
  });
  rejected(await audit.ready(),'audit_io_failed');const present=id(await fs.lstat(run,{bigint:true}));
  rejected(await audit.ready(),'audit_io_failed');audit.audit('lifecycle.jsonl',{code:'service_started'},true);await audit.flush();
  const closed=await audit.close();assert.equal(closed.ok,false);assert.equal(closed.value.closed,true);assert.equal(closed.value.reason,'audit_io_failed');
  assert.equal(mkdirCalls,1);assert.equal(id(await fs.lstat(run,{bigint:true})),present);assert.deepEqual(await fs.readdir(run),[]);
  assert.equal(JSON.stringify(audit.state()).includes('private'),false);
});

test('queued audit rejects a same-stack junction replacement and preserves the release sentinel',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),release=await f.mkdir('release'),sentinel=f.at('release','lifecycle.jsonl');
  await fs.writeFile(sentinel,'release-sentinel\n');
  const audit=createPanelAudit(run);
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  assert.equal(audit.state().queued,1);
  fsSync.renameSync(run,f.at('displaced'));
  fsSync.symlinkSync(release,run,'junction');
  rejected(await audit.flush(),'audit_directory_link');
  assert.equal(await fs.readFile(sentinel,'utf8'),'release-sentinel\n');
  assert.equal(await exists(f.at('displaced','lifecycle.jsonl')),false);
  assert.equal(audit.state().failures,1);
  const closed=await audit.close();assert.equal(closed.ok,false);assert.equal(closed.value.closed,true);assert.equal(closed.value.reason,'audit_directory_link');
});

for(const append of [true,false])test(`queued audit rejects hardlink before ${append?'append':'snapshot truncation'}`,async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),sentinel=f.at('sentinel'),log=f.at('run','lifecycle.jsonl');
  await fs.writeFile(sentinel,'hardlink-sentinel\n');
  const audit=createPanelAudit(run);
  audit.audit('lifecycle.jsonl',{code:'service_started'},append);
  fsSync.linkSync(sentinel,log);
  rejected(await audit.flush(),'audit_target_hardlink');
  assert.equal(await fs.readFile(sentinel,'utf8'),'hardlink-sentinel\n');
  assert.equal(await fs.readFile(log,'utf8'),'hardlink-sentinel\n');
});

test('queued audit rejects a different ordinary directory at the original path',async t=>{
  const f=await fixture(t),run=await f.mkdir('run');
  const audit=createPanelAudit(run);audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  fsSync.renameSync(run,f.at('displaced'));fsSync.mkdirSync(run);
  rejected(await audit.flush(),'audit_directory_changed');
  assert.deepEqual(await fs.readdir(run),[]);assert.deepEqual(await fs.readdir(f.at('displaced')),[]);
});

test('an absent suffix cannot adopt a replaced captured ancestor or an independently created directory',async t=>{
  const f=await fixture(t),anchor=await f.mkdir('anchor');
  const audit=createPanelAudit(f.at('anchor','missing','run'));
  fsSync.renameSync(anchor,f.at('displaced'));fsSync.mkdirSync(anchor);
  rejected(await audit.ready(),'audit_directory_changed');
  assert.deepEqual(await fs.readdir(anchor),[]);
  const other=createPanelAudit(f.at('independent'));
  fsSync.mkdirSync(f.at('independent'));
  rejected(await other.ready(),'audit_directory_changed');
});

test('static directory junctions and static log hardlinks fail closed',async t=>{
  const f=await fixture(t),target=await f.mkdir('physical'),alias=f.at('alias'),sentinel=f.at('sentinel');
  fsSync.symlinkSync(target,alias,'junction');
  rejected(await createPanelAudit(alias).ready(),'audit_directory_link');
  await fs.writeFile(sentinel,'static-original\n');
  fsSync.linkSync(sentinel,f.at('physical','connection-status.json'));
  const audit=createPanelAudit(target);rejected(await audit.ready(),'audit_target_hardlink');
  audit.audit('connection-status.json',{code:'service_started'});await audit.flush();
  assert.equal(await fs.readFile(sentinel,'utf8'),'static-original\n');
});

test('readiness rechecks captured file applicability before accepting startup',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),sentinel=f.at('sentinel');await fs.writeFile(sentinel,'before-ready\n');
  const audit=createPanelAudit(run);fsSync.linkSync(sentinel,f.at('run','lifecycle.jsonl'));
  rejected(await audit.ready(),'audit_target_hardlink');assert.equal(await fs.readFile(sentinel,'utf8'),'before-ready\n');
});

test('static file symlinks fail closed where the OS permits creating them',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),sentinel=f.at('sentinel');
  await fs.writeFile(sentinel,'symlink-original\n');
  try{await fs.symlink(sentinel,f.at('run','lifecycle.jsonl'),'file');}catch(error){if(error.code==='EPERM'){t.skip('OS denied test-owned file symlink creation');return;}throw error;}
  rejected(await createPanelAudit(run).ready(),'audit_target_link');
  assert.equal(await fs.readFile(sentinel,'utf8'),'symlink-original\n');
});

test('ordinary legacy directory, existing log and owner-created missing directories remain usable',async t=>{
  const f=await fixture(t),run=await f.mkdir('legacy'),log=f.at('legacy','lifecycle.jsonl');
  await fs.writeFile(log,'existing-evidence\n');
  const audit=createPanelAudit(run);assert.equal((await audit.ready()).ok,true);
  audit.audit('lifecycle.jsonl',{code:'service_started',message:'private fixture',access_token:'private fixture'},true);
  assert.equal((await audit.flush()).ok,true);
  const text=await fs.readFile(log,'utf8');assert.ok(text.startsWith('existing-evidence\n'));assert.equal(text.includes('private fixture'),false);
  assert.equal(JSON.parse(text.split('\n')[1]).service,'revit-local-codex');
  const missing=createPanelAudit(f.at('new','nested','run'));
  assert.equal((await missing.ready()).ok,true);assert.equal((await missing.ready()).ok,true);
  missing.audit('connection-status.json',{code:'service_started'});
  assert.equal((await missing.flush()).ok,true);
  assert.equal(JSON.parse(await fs.readFile(f.at('new','nested','run','connection-status.json'),'utf8')).code,'service_started');
});

test('new regular files, replaced logs and removed logs are not adopted by queued writes',async t=>{
  const f=await fixture(t);
  for(const mode of ['unexpected','replaced','removed']){
    const run=await f.mkdir(mode),log=f.at(mode,'connection-status.json');
    if(mode!=='unexpected')await fs.writeFile(log,'original-evidence\n');
    const audit=createPanelAudit(run);audit.audit('connection-status.json',{code:'service_started'});
    if(mode!=='unexpected')fsSync.renameSync(log,f.at(mode,'displaced'));
    if(mode!=='removed')fsSync.writeFileSync(log,'replacement-evidence\n');
    rejected(await audit.flush(),'audit_target_changed');
    if(mode!=='removed')assert.equal(await fs.readFile(log,'utf8'),'replacement-evidence\n');
    else assert.equal(await exists(log),false);
    if(mode!=='unexpected')assert.equal(await fs.readFile(f.at(mode,'displaced'),'utf8'),'original-evidence\n');
  }
});

test('file identity is checked after open before snapshot truncate',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),log=f.at('run','connection-status.json');
  await fs.writeFile(log,'original-evidence\n');
  const audit=createPanelAudit(run),originalOpen=fs.open;
  t.mock.method(fs,'open',async(target,flags)=>{
    const handle=await originalOpen(target,flags);
    assert.equal(target,log);assert.equal(typeof flags,'number');assert.equal(flags&fsSync.constants.O_TRUNC,0);
    fsSync.renameSync(log,f.at('run','displaced'));fsSync.writeFileSync(log,'replacement-evidence\n');
    return handle;
  });
  audit.audit('connection-status.json',{code:'service_started'});
  rejected(await audit.flush(),'audit_target_changed');
  assert.equal(await fs.readFile(log,'utf8'),'replacement-evidence\n');
  assert.equal(await fs.readFile(f.at('run','displaced'),'utf8'),'original-evidence\n');
});

test('a hardlink introduced during open is rejected by the opened handle observation',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),log=f.at('run','connection-status.json');
  await fs.writeFile(log,'original-evidence\n');
  const audit=createPanelAudit(run),originalOpen=fs.open;
  t.mock.method(fs,'open',async(target,flags)=>{
    const handle=await originalOpen(target,flags);fsSync.linkSync(log,f.at('sentinel'));return handle;
  });
  audit.audit('connection-status.json',{code:'service_started'});
  rejected(await audit.flush(),'audit_target_hardlink');
  assert.equal(await fs.readFile(f.at('sentinel'),'utf8'),'original-evidence\n');
});

test('an unknown open I/O failure remains blocked without fallback or replay',async t=>{
  const f=await fixture(t),run=await f.mkdir('run');let opens=0;
  const audit=createPanelAudit(run);
  t.mock.method(fs,'open',async()=>{opens++;throw Object.assign(new Error('private IO details'),{code:'EIO'});});
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  rejected(await audit.flush(),'audit_io_failed');
  audit.audit('lifecycle.jsonl',{code:'service_stopping'},true);await audit.flush();
  assert.equal(opens,1);assert.deepEqual(await fs.readdir(run),[]);
  assert.equal(JSON.stringify(audit.state()).includes('private'),false);
});

test('failed close retains one exact handle and cleanup id; retries close only and never replays writes',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),otherRun=await f.mkdir('other');
  const audit=createPanelAudit(run),other=createPanelAudit(otherRun),originalOpen=fs.open;
  let opens=0,writeCalls=0,closeCalls=0,wrapper;
  t.mock.method(fs,'open',async(...args)=>{
    opens++;const handle=await originalOpen(...args);
    wrapper={stat:options=>handle.stat(options),truncate:size=>handle.truncate(size),writeFile:async text=>{writeCalls++;return handle.writeFile(text);},
      async close(){assert.equal(this,wrapper);closeCalls++;if(closeCalls<3)throw new Error('controlled close denial');await handle.close();}};
    return wrapper;
  });
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  audit.audit('lifecycle.jsonl',{code:'service_stopping'},true);
  const first=await audit.flush();rejected(first,'audit_cleanup_pending');assert.equal(first.value.closed,false);assert.equal(first.value.processRetained,true);
  assert.equal(first.error.primaryCode,'audit_close_failed');assert.equal(first.value.status,'cleanup_pending');
  const cleanupId=first.error.cleanupId;assert.equal(typeof cleanupId,'string');
  await audit.flush();await audit.close();assert.equal(closeCalls,1);
  rejected(await other.cleanup(cleanupId),'audit_cleanup_id_invalid');assert.equal(closeCalls,1);
  rejected(await audit.cleanup('wrong-id'),'audit_cleanup_id_invalid');assert.equal(closeCalls,1);
  const again=await audit.cleanup(cleanupId);rejected(again,'audit_cleanup_pending');assert.equal(again.error.cleanupId,cleanupId);assert.equal(closeCalls,2);
  const final=await audit.cleanup(cleanupId);assert.equal(final.ok,true);assert.equal(final.value.cleanupId,null);assert.equal(final.value.reason,'audit_close_failed');assert.equal(final.value.closed,true);assert.equal(final.value.processRetained,false);
  audit.audit('lifecycle.jsonl',{code:'service_closed'},true);await audit.flush();await audit.close();
  assert.equal(opens,1);assert.equal(writeCalls,1);assert.equal(closeCalls,3);
  const lines=(await fs.readFile(f.at('run','lifecycle.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).code,'service_started');
});

test('a failed write keeps its primary reason through failed close and successful same-owner cleanup',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),audit=createPanelAudit(run),originalOpen=fs.open;
  let writes=0,closes=0;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await originalOpen(...args);
    return {stat:options=>handle.stat(options),truncate:size=>handle.truncate(size),async writeFile(){writes++;throw new Error('write outcome unknown');},async close(){closes++;if(closes===1)throw new Error('controlled close denial');await handle.close();}};
  });
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);
  const first=await audit.flush();rejected(first,'audit_cleanup_pending');assert.equal(first.error.primaryCode,'audit_io_failed');
  assert.equal((await audit.cleanup(first.error.cleanupId)).ok,true);
  rejected(await audit.flush(),'audit_io_failed');assert.equal(writes,1);assert.equal(closes,2);
});

test('pending cleanup retains a listener-free child process until explicit same-owner cleanup',async t=>{
  const f=await fixture(t),run=await f.mkdir('run');
  const source=`import fs from 'node:fs/promises';
import {createPanelAudit} from ${JSON.stringify(new URL('../lib/panel-audit.mjs',import.meta.url).href)};
const original=fs.open;let closes=0;
fs.open=async(...args)=>{const handle=await original(...args);return {stat:options=>handle.stat(options),writeFile:text=>handle.writeFile(text),async close(){if(++closes===1)throw new Error('controlled close denial');await handle.close();}};};
const audit=createPanelAudit(${JSON.stringify(run)});audit.audit('lifecycle.jsonl',{code:'service_started'},true);
const pending=await audit.flush();await audit.close();
if(pending.error?.code!=='audit_cleanup_pending'||!pending.value.processRetained)throw new Error('retention not observed');
setTimeout(async()=>{const cleaned=await audit.cleanup(pending.error.cleanupId);process.stdout.write(JSON.stringify({cleaned:cleaned.ok,closed:cleaned.value.closed,processRetained:cleaned.value.processRetained,closes})+'\\n');},60).unref();`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const watchdog=setTimeout(()=>{child.kill();},10000);
  const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(watchdog));
  assert.deepEqual(outcome,{code:0,signal:null});assert.equal(stderr,'');assert.deepEqual(JSON.parse(stdout),{cleaned:true,closed:true,processRetained:false,closes:2});
});

test('default queue, entry and file budgets remain bounded',async t=>{
  const f=await fixture(t),run=await f.mkdir('queue'),audit=createPanelAudit(run);
  for(let i=0;i<65;i++)audit.audit('lifecycle.jsonl',{code:'service_started',pid:i},true);
  assert.equal(audit.state().queued,64);await audit.flush();assert.equal(audit.state().dropped,1);
  assert.equal((await fs.readFile(f.at('queue','lifecycle.jsonl'),'utf8')).trim().split('\n').length,64);
  const fullRun=await f.mkdir('full'),fullLog=f.at('full','lifecycle.jsonl');await fs.writeFile(fullLog,'x'.repeat(1024*1024));
  const full=createPanelAudit(fullRun);full.audit('lifecycle.jsonl',{code:'service_started'},true);await full.flush();
  assert.equal((await fs.stat(fullLog)).size,1024*1024);assert.equal(full.state().dropped,1);
  const bigRun=await f.mkdir('big'),big=createPanelAudit(bigRun);
  big.audit('lifecycle.jsonl',{code:'service_started',toolNames:Array(100).fill('x'.repeat(120))},true);await big.flush();
  assert.equal(big.state().dropped,1);assert.deepEqual(await fs.readdir(bigRun),[]);
});

test('startup options are captured once and closed audits drain accepted work without accepting new writes',async t=>{
  const f=await fixture(t),run=await f.mkdir('run'),reads={service:0,maxFileBytes:0,maxQueued:0};
  const options={};for(const [key,value]of Object.entries({service:'fixture-service',maxFileBytes:1024,maxQueued:2}))Object.defineProperty(options,key,{get(){reads[key]++;return reads[key]===1?value:'changed';}});
  const audit=createPanelAudit(run,options);assert.equal((await audit.ready()).ok,true);
  audit.audit('lifecycle.jsonl',{code:'service_started'},true);const closing=audit.close();audit.audit('lifecycle.jsonl',{code:'service_stopping'},true);
  const closed=await closing;assert.equal(closed.ok,true);assert.equal(closed.value.status,'closed');assert.equal(closed.value.closed,true);
  rejected(await audit.ready(),'audit_closed');assert.deepEqual(reads,{service:1,maxFileBytes:1,maxQueued:1});
  const lines=(await fs.readFile(f.at('run','lifecycle.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).service,'fixture-service');
});

test('unsupported path forms and directory files are explicit failures',async t=>{
  const f=await fixture(t),file=f.at('file');await fs.writeFile(file,'ordinary file\n');
  rejected(await createPanelAudit(file).ready(),'audit_not_directory');
  for(const directory of ['relative-path',new URL('file:///not-a-string'),f.at('safe')+path.sep+'..'+path.sep+'alias'])rejected(await createPanelAudit(directory).ready(),'audit_directory_path_invalid');
  if(process.platform==='win32')for(const directory of ['C:relative','\\\\?\\C:\\alias','\\\\host\\share\\run',f.at('with:ads')])rejected(await createPanelAudit(directory).ready(),'audit_directory_path_invalid');
});
