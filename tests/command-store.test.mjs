import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {COMMAND_TOOLS,isCommandTool,invokeCommand} from '../lib/command-store.mjs';

const example={command_id:'count-pipes',name:'Count pipes',description:'Count current model pipes and return a compact result.',code:'return 42;'};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'revit-command-store-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,call:(name,args={},options={})=>invokeCommand(name,args,{root,...options})};
}
function location(root,record){return path.join(root,'commands',record.command_id,record.revision+'.json');}
async function evidence(root,code,change={}){
  const id=randomUUID(),now=new Date().toISOString();
  const request={id,operation:'execute_csharp',args:{code,expected_document:'D:\\samples\\sample.rvt',mode:'rollback'},createdUtc:now};
  const outcome={id,ok:true,result:{operation:'execute_csharp',mode:'rollback',committed:false,value:42},completedUtc:now};
  change.request?.(request);change.outcome?.(outcome);
  for(const [folder,value] of [['processing',request],['outbox',outcome]]){
    await fs.mkdir(path.join(root,'queue',folder),{recursive:true});
    await fs.writeFile(path.join(root,'queue',folder,id+'.json'),JSON.stringify(value));
  }
  return id;
}
test('publishes four explicit schemas with exact-version execution and safe metadata',()=>{
  assert.equal(COMMAND_TOOLS.length,4);
  assert.equal(new Set(COMMAND_TOOLS.map(tool=>tool.name)).size,4);
  for(const tool of COMMAND_TOOLS){assert.ok(isCommandTool(tool.name));assert.equal(tool.inputSchema.additionalProperties,false);}
  assert.equal(isCommandTool('execute_csharp'),false);
  const run=COMMAND_TOOLS.find(tool=>tool.name==='revit_run_command');
  assert.ok(run.inputSchema.required.includes('revision'));
  assert.equal(run.inputSchema.properties.mode.default,'rollback');
  assert.equal(run.annotations.idempotentHint,false);
  assert.equal(run.annotations.destructiveHint,true);
});
test('save and read preserve exact source; identical save is immutable and idempotent',async t=>{
  const {root,call}=await fixture(t);
  const args={...example,code:'// 中文\r\nreturn 42;\r\n'};
  const first=await call('revit_save_command',args);
  const raw=await fs.readFile(location(root,first));
  assert.equal(first.created,true);assert.equal(first.verification.status,'unverified');assert.ok(!Object.hasOwn(first,'code'));
  assert.equal(first.revision,createHash('sha256').update(JSON.stringify({schema_version:1,...args})).digest('hex'));
  const second=await call('revit_save_command',args);
  assert.equal(second.created,false);assert.equal(second.created_utc,first.created_utc);
  assert.deepEqual(await fs.readFile(location(root,first)),raw);
  const restored=await call('revit_get_command',{command_id:args.command_id,revision:first.revision});
  assert.equal(restored.code,args.code);
  assert.deepEqual(await fs.readdir(path.dirname(location(root,first))),[first.revision+'.json']);
});
test('a separate Node process reads persisted commands without module state',async t=>{
  const {root,call}=await fixture(t);
  const saved=await call('revit_save_command',example);
  const moduleUrl=new URL('../lib/command-store.mjs',import.meta.url).href;
  const program=`import {invokeCommand} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await invokeCommand('revit_get_command',${JSON.stringify({command_id:example.command_id,revision:saved.revision})},{root:${JSON.stringify(root)}})));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).code,example.code);
});
test('concurrent saves publish one complete revision and never expose staging files',async t=>{
  const {root,call}=await fixture(t);
  const args={...example,code:'x'+'\u0000'.repeat(63999)};
  const pending=Array.from({length:12},()=>call('revit_save_command',args));
  const completed=await Promise.all(pending);
  assert.equal(completed.filter(value=>value.created).length,1);
  assert.equal(new Set(completed.map(value=>value.revision)).size,1);
  assert.equal((await call('revit_list_commands')).total,1);
  assert.deepEqual(await fs.readdir(path.join(root,'command-store-state')),[]);
  assert.equal((await call('revit_get_command',{command_id:example.command_id,revision:completed[0].revision})).code,args.code);
});
test('metadata or source changes create independent revisions; list is stable and paged without source',async t=>{
  const {call}=await fixture(t);
  const one=await call('revit_save_command',example);
  const two=await call('revit_save_command',{...example,description:'Updated description'});
  const three=await call('revit_save_command',{...example,command_id:'other-command'});
  assert.notEqual(one.revision,two.revision);assert.notEqual(one.revision,three.revision);
  const all=await call('revit_list_commands');
  assert.equal(all.total,3);assert.equal(all.limit,20);assert.equal(all.has_more,false);
  assert.ok(all.commands.every(record=>!Object.hasOwn(record,'code')));
  assert.deepEqual(await call('revit_list_commands'),all);
  const page=await call('revit_list_commands',{offset:1,limit:1});
  assert.deepEqual(page.commands,[all.commands[1]]);assert.equal(page.has_more,true);
  assert.equal((await call('revit_list_commands',{command_id:example.command_id})).total,2);
});
test('missing store is empty and a missing explicit revision fails',async t=>{
  const {call}=await fixture(t);
  assert.deepEqual((await call('revit_list_commands')).commands,[]);
  await assert.rejects(call('revit_get_command',{command_id:'missing',revision:'a'.repeat(64)}),error=>error.code==='ENOENT');
});
test('arguments reject traversal, reserved IDs, implicit revisions, unknown keys and invalid pagination',async t=>{
  const {call}=await fixture(t);
  for(const command_id of ['../escape','x/y','x\\y','X','a.b','a'.repeat(65),'con','nul','com1',''])await assert.rejects(call('revit_save_command',{...example,command_id}),/command_id/);
  for(const revision of ['latest','../x','a'.repeat(63),'A'.repeat(64)])await assert.rejects(call('revit_get_command',{command_id:'count-pipes',revision}),/revision/);
  await assert.rejects(call('revit_get_command',{command_id:'count-pipes'}),/revision/);
  await assert.rejects(call('revit_save_command',{...example,unexpected:true}),/unknown/);
  await assert.rejects(call('missing',{}),/unknown tool/);
  await assert.rejects(call('revit_list_commands',null),/object/);
  for(const limit of [0,101,1.5,NaN,Infinity,null])await assert.rejects(call('revit_list_commands',{limit}),/limit/);
  for(const offset of [-1,1.5,NaN,Infinity,null])await assert.rejects(call('revit_list_commands',{offset}),/offset/);
  await assert.rejects(call('revit_save_command',{...example,source_request_id:'../bad'}),/source_request_id/);
});
test('code byte bounds account for Unicode and JSON escape expansion',async t=>{
  const {call}=await fixture(t);
  for(const field of ['name','description','code'])await assert.rejects(call('revit_save_command',{...example,[field]:' '}),new RegExp(field));
  await assert.rejects(call('revit_save_command',{...example,name:'x'.repeat(81)}),/name/);
  await assert.rejects(call('revit_save_command',{...example,description:'x'.repeat(2001)}),/description/);
  await assert.rejects(call('revit_save_command',{...example,code:'中'.repeat(22000)}),/64000 UTF-8 bytes/);
  await assert.rejects(call('revit_save_command',{...example,code:'x'.repeat(64001)}),/code/);
  const code='x'+'\u0000'.repeat(63999);
  const saved=await call('revit_save_command',{...example,code});
  assert.equal((await call('revit_get_command',{command_id:example.command_id,revision:saved.revision})).code,code);
});
test('read, list and repeated save reject a content-tampered record',async t=>{
  const {root,call}=await fixture(t),saved=await call('revit_save_command',example);
  const file=location(root,saved),record=JSON.parse(await fs.readFile(file,'utf8'));
  record.code='return 100;';await fs.writeFile(file,JSON.stringify(record));
  await assert.rejects(call('revit_get_command',{command_id:example.command_id,revision:saved.revision}),/SHA256 mismatch/);
  await assert.rejects(call('revit_list_commands'),/SHA256 mismatch/);
  await assert.rejects(call('revit_save_command',example),/SHA256 mismatch/);
});
test('read rejects oversized or malformed UTF8/JSON files before trusting content',async t=>{
  const {root,call}=await fixture(t),saved=await call('revit_save_command',example),file=location(root,saved);
  const get=()=>call('revit_get_command',{command_id:example.command_id,revision:saved.revision});
  await fs.writeFile(file,Buffer.alloc(512*1024+1));await assert.rejects(get(),/size limit/);
  await fs.writeFile(file,'{bad');await assert.rejects(get(),/malformed/);
  await fs.writeFile(file,Buffer.from([0xff]));await assert.rejects(get(),/UTF-8/);
});
test('list reports malformed entries even outside a command filter',async t=>{
  const {root,call}=await fixture(t);
  await call('revit_save_command',example);
  await fs.writeFile(path.join(root,'commands','unexpected.txt'),'broken');
  await assert.rejects(call('revit_list_commands',{command_id:example.command_id}),/malformed command directory/);
});
test('get rejects stored path identity mismatch and list rejects malformed revision names',async t=>{
  const {root,call}=await fixture(t),saved=await call('revit_save_command',example);
  const original=location(root,saved),wrong=path.join(path.dirname(original),'b'.repeat(64)+'.json');
  await fs.copyFile(original,wrong);
  await assert.rejects(call('revit_get_command',{command_id:example.command_id,revision:'b'.repeat(64)}),/identity/);
  await fs.unlink(wrong);await fs.writeFile(path.join(path.dirname(original),'unexpected.txt'),'broken');
  await assert.rejects(call('revit_list_commands'),/malformed revision/);
});
test('directory links and hard-linked records are rejected',async t=>{
  const {root,call}=await fixture(t);
  const outside=path.join(root,'outside');await fs.mkdir(outside);
  await fs.symlink(outside,path.join(root,'commands'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(call('revit_save_command',example),/unsafe directory/);
  await assert.rejects(call('revit_list_commands'),/unsafe directory/);
  await fs.unlink(path.join(root,'commands'));
  const saved=await call('revit_save_command',example);
  await fs.link(location(root,saved),path.join(outside,'record.json'));
  await assert.rejects(call('revit_get_command',{command_id:example.command_id,revision:saved.revision}),/unsafe file/);
});
test('successful source evidence records the exact completed request and mode',async t=>{
  const {root,call}=await fixture(t),id=await evidence(root,example.code);
  const saved=await call('revit_save_command',{...example,source_request_id:id});
  assert.equal(saved.verification.status,'source_execution_succeeded');assert.equal(saved.verification.evidence[0].source_request_id,id);
  assert.equal(saved.verification.evidence[0].mode,'rollback');assert.equal(saved.verification.evidence[0].outcome,'ok');
  assert.match(saved.verification.evidence[0].request_sha256,/^[a-f0-9]{64}$/);assert.match(saved.verification.evidence[0].outcome_sha256,/^[a-f0-9]{64}$/);
  const get=await call('revit_get_command',{command_id:example.command_id,revision:saved.revision});
  assert.deepEqual(get.verification,saved.verification);
});
test('failed, missing, foreign-operation, different-code and mismatched-mode sources are rejected',async t=>{
  const {root,call}=await fixture(t);
  await assert.rejects(call('revit_save_command',{...example,source_request_id:randomUUID()}),/missing/);
  const variants=[
    {outcome:outcome=>{outcome.ok=false;}},
    {request:request=>{request.operation='status';}},
    {outcome:outcome=>{outcome.result.operation='status';}},
    {request:request=>{request.args.code+=' ';}},
    {outcome:outcome=>{outcome.id=randomUUID();}},
    {outcome:outcome=>{outcome.result.mode='commit';}},
    {outcome:outcome=>{outcome.result.committed=true;}}
  ];
  for(const variant of variants){const id=await evidence(root,example.code,variant);await assert.rejects(call('revit_save_command',{...example,source_request_id:id}),/source/);}
  assert.equal((await call('revit_list_commands')).total,0);
});
test('existing immutable drafts gain separate append-only evidence after execution',async t=>{
  const {root,call}=await fixture(t),first=await call('revit_save_command',example);
  const original=await fs.readFile(location(root,first));
  const id=await evidence(root,example.code);
  const again=await call('revit_save_command',{...example,source_request_id:id});
  assert.equal(again.revision,first.revision);assert.equal(again.created,false);assert.equal(again.verification.status,'source_execution_succeeded');
  assert.equal(again.verification_added,true);assert.deepEqual(await fs.readFile(location(root,first)),original);
  const validationFile=path.join(root,'commands',example.command_id,'validations',first.revision,id+'.json');
  const originalValidation=await fs.readFile(validationFile);
  const repeated=await call('revit_save_command',{...example,source_request_id:id});
  assert.equal(repeated.verification_added,false);assert.equal(repeated.verification.evidence.length,1);
  assert.deepEqual(await fs.readFile(validationFile),originalValidation);
  const nextId=await evidence(root,example.code,{request:request=>{request.args.mode='commit';},outcome:outcome=>{outcome.result.mode='commit';outcome.result.committed=true;}});
  const next=await call('revit_save_command',{...example,source_request_id:nextId});
  assert.equal(next.verification.evidence.length,2);assert.deepEqual(await fs.readFile(location(root,first)),original);
  await assert.rejects(call('revit_save_command',{...example,source_request_id:randomUUID()}),/missing/);
});
test('malformed or mismatched append-only evidence is reported on get and list',async t=>{
  const {root,call}=await fixture(t),id=await evidence(root,example.code);
  const saved=await call('revit_save_command',{...example,source_request_id:id});
  const file=path.join(root,'commands',example.command_id,'validations',saved.revision,id+'.json');
  const record=JSON.parse(await fs.readFile(file,'utf8'));record.source.source_request_id=randomUUID();
  await fs.writeFile(file,JSON.stringify(record));
  await assert.rejects(call('revit_get_command',{command_id:example.command_id,revision:saved.revision}),/source identity/);
  await assert.rejects(call('revit_list_commands'),/source identity/);
});
test('run executes the exact stored version once with default rollback and returns execution identity',async t=>{
  const {call}=await fixture(t),old=await call('revit_save_command',example);
  await call('revit_save_command',{...example,code:'return 99;'});
  const calls=[],response={request_id:randomUUID(),operation:'execute_csharp',mode:'rollback',value:42};
  const run=await call('revit_run_command',{command_id:example.command_id,revision:old.revision,expected_document:'D:\\sample.rvt'},{execute:async(...args)=>{calls.push(args);return response;}});
  assert.deepEqual(calls,[['revit_execute_csharp',{code:example.code,expected_document:'D:\\sample.rvt',mode:'rollback'}]]);
  assert.equal(run.command.revision,old.revision);assert.equal(run.execution,response);
});
test('run passes explicit commit and never retries or hides executor unknown errors',async t=>{
  const {call}=await fixture(t),saved=await call('revit_save_command',example);
  let count=0;
  const expected=new Error('Outcome unknown (request '+randomUUID()+'). Do not retry.');
  await assert.rejects(call('revit_run_command',{command_id:example.command_id,revision:saved.revision,expected_document:'D:\\sample.rvt',mode:'commit'},{execute:async(name,args)=>{count++;assert.equal(args.mode,'commit');throw expected;}}),error=>error===expected);
  assert.equal(count,1);
});
test('run rejects invalid parameters or absent executor before execution',async t=>{
  const {call}=await fixture(t),saved=await call('revit_save_command',example);
  const base={command_id:example.command_id,revision:saved.revision,expected_document:'D:\\sample.rvt'};
  await assert.rejects(call('revit_run_command',base),/existing Revit executor/);
  for(const expected_document of ['',null,' '])await assert.rejects(call('revit_run_command',{...base,expected_document}),/expected_document/);
  await assert.rejects(call('revit_run_command',{...base,mode:'auto'}),/mode/);
  await assert.rejects(call('revit_run_command',{...base,code:'return 0;'}),/unknown/);
});
