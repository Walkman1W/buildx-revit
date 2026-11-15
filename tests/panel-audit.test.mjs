import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sanitizePanelAudit,createPanelAudit} from '../lib/panel-audit.mjs';

test('startup diagnostics retain a tagged failure code without accepting raw error text',()=>{
  assert.deepEqual(sanitizePanelAudit('lifecycle.jsonl',{code:'service_start_failed',error_code:'CHAT_STORE_LOCKED',message:'raw private text'}),{code:'service_start_failed',error_code:'CHAT_STORE_LOCKED'});
  assert.deepEqual(sanitizePanelAudit('lifecycle.jsonl',{code:'service_start_failed',error_code:'contains private text'}),{code:'service_start_failed'});
});

test('audit retains lifecycle facts but rejects credentials, arbitrary messages and raw protocol bodies',()=>{
  const result=sanitizePanelAudit('lifecycle.jsonl',{code:'codex_lifecycle',phase:'fault',reason:'codex_stdin_error',generation:3,pid:42,stream:'stdin',exitCode:null,signal:null,message:'fixture credential',stderr:'fixture transcript',tokens:'private',params:{anything:true}});
  assert.deepEqual(result,{code:'codex_lifecycle',phase:'fault',reason:'codex_stdin_error',generation:3,pid:42,exitCode:null,signal:null,stream:'stdin'});
  assert.equal(sanitizePanelAudit('../outside',{code:'service_started'}),null);
  assert.equal(sanitizePanelAudit('lifecycle.jsonl',{code:'arbitrary'}),null);
});
test('customer empty-catalog diagnostic keeps only fixed metadata',()=>{
  assert.deepEqual(sanitizePanelAudit('connection-status.json',{code:'customer_chat_tools_verified',count:0,generation:2,
    email:'not-for-logs@example.invalid',access_token:'fixture-private',body:'fixture conversation'}),
  {code:'customer_chat_tools_verified',generation:2,count:0});
});

test('dynamic model audit retains rejection shapes and stage, never argument values or arbitrary error bodies',()=>{
  const input={kind:'dynamic_model',phase:'rejected',tool:'buildx_model_operation',stage:'admission',hasCurrentGrant:true,
    code:'MODEL_OPERATION_ARGUMENTS_INVALID',outcome:'not_started',modelTool:'revit_create_wall',
    conversationId:'conversation',threadId:'thread',turnId:'turn',callId:'call',parametersType:'string',
    argumentKeys:['tool','parameters'],parameterKeys:['code'],elapsedMs:2,
    arguments:{parameters:'private body'},codeText:'private script',message:'private error',access_token:'private credential'};
  assert.deepEqual(sanitizePanelAudit('tool-calls.jsonl',input),{
    kind:'dynamic_model',phase:'rejected',tool:'buildx_model_operation',stage:'admission',hasCurrentGrant:true,
    conversationId:'conversation',threadId:'thread',turnId:'turn',callId:'call',modelTool:'revit_create_wall',
    code:'MODEL_OPERATION_ARGUMENTS_INVALID',outcome:'not_started',parametersType:'string',argumentKeys:['tool','parameters'],parameterKeys:['code'],elapsedMs:2,
  });
  assert.equal(sanitizePanelAudit('tool-calls.jsonl',{...input,phase:'arbitrary'}),null);
  assert.equal(sanitizePanelAudit('tool-calls.jsonl',{...input,stage:'arbitrary'}),null);
  const expired=sanitizePanelAudit('tool-calls.jsonl',{...input,stage:'approval',code:'MODEL_APPROVAL_EXPIRED'});
  assert.equal(expired.stage,'approval');assert.equal(expired.code,'MODEL_APPROVAL_EXPIRED');assert.equal(expired.outcome,'not_started');
  assert.equal(JSON.stringify(expired).includes('private'),false);
  const malformed=sanitizePanelAudit('tool-calls.jsonl',{...input,code:'private text',modelTool:'private text',argumentKeys:['a'.repeat(121),'private text'],elapsedMs:-1});
  assert.equal(malformed.code,undefined);assert.equal(malformed.modelTool,undefined);assert.equal(malformed.elapsedMs,undefined);assert.deepEqual(malformed.argumentKeys,[]);
});
test('audit appends bounded files, preserves existing evidence and exposes discarded writes',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-audit-'));
  const directoryIdentity=await fs.lstat(directory,{bigint:true});
  const audit=createPanelAudit(directory,{maxFileBytes:1024,maxQueued:2});
  for(let i=0;i<20;i++)audit.audit('lifecycle.jsonl',{code:'service_started',pid:i},true);
  await audit.flush();const before=await fs.readFile(path.join(directory,'lifecycle.jsonl'),'utf8');
  assert.equal(before.trim().split('\n').length,2);assert.ok(audit.state().dropped>=18);assert.equal(audit.state().queued,0);
  await fs.writeFile(path.join(directory,'lifecycle.jsonl'),'x'.repeat(1024));
  audit.audit('lifecycle.jsonl',{code:'service_stopping'},true);await audit.flush();
  assert.equal((await fs.stat(path.join(directory,'lifecycle.jsonl'))).size,1024);assert.ok(audit.state().dropped>=19);
  // Test-owned files only; no application runtime/evidence is removed.
  const directoryNow=await fs.lstat(directory,{bigint:true}),fileNow=await fs.lstat(path.join(directory,'lifecycle.jsonl'),{bigint:true});
  assert.ok(directoryNow.isDirectory()&&!directoryNow.isSymbolicLink());assert.equal(directoryNow.ino,directoryIdentity.ino);assert.equal(directoryNow.dev,directoryIdentity.dev);
  assert.ok(fileNow.isFile()&&!fileNow.isSymbolicLink());assert.equal(fileNow.nlink,1n);
  await fs.unlink(path.join(directory,'lifecycle.jsonl'));await fs.rmdir(directory);
});
