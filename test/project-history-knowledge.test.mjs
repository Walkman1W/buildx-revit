import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createProjectHistory} from '../lib/project-history.mjs';
import {createProjectKnowledge} from '../lib/project-knowledge.mjs';

test('service persists exact text, CSV, and XLSX facts for another Node process', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-project-persist-'));
  t.after(() => fs.rm(tmp, {recursive:true, force:true}));
  const rootPath = path.join(tmp,'sources'), stateDirectory = path.join(tmp,'state');
  await fs.mkdir(rootPath); await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(rootPath,'brief.md'),'height 3\n');
  await fs.writeFile(path.join(rootPath,'rooms.csv'),'use,area\nA,12.5\nA,7.5\n');
  const python = `import sys, zipfile
from pathlib import Path
p=Path(sys.argv[1])/'rooms.xlsx'
with zipfile.ZipFile(p,'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rooms" sheetId="1" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2"><v>12.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>A</t></is></c><c r="B3"><v>7.5</v></c></row></sheetData></worksheet>')`;
  const generated = spawnSync('python',['-c',python,rootPath],{encoding:'utf8'}); assert.equal(generated.status,0,generated.stderr);
  const history = createProjectHistory({stateDirectory,accountId:'user-A'}).value;
  const service = createProjectKnowledge({projectId:'project-A',rootPath,history}).value;
  assert.equal((await service.refresh()).ok,true);
  const files = service.list().value.files;
  assert.deepEqual(files.map(file => [file.path,file.status,file.persistence]).sort(), [['brief.md','indexed','durable'],['rooms.csv','indexed','durable'],['rooms.xlsx','indexed','durable']]);
  const refs = Object.fromEntries(files.map(file => [file.path,{path:file.path,sha256:file.sha256}]));
  await fs.writeFile(path.join(rootPath,'brief.md'),'height 4\n');
  await fs.rm(path.join(rootPath,'rooms.csv')); await fs.rm(path.join(rootPath,'rooms.xlsx'));
  const knowledgeUrl = pathToFileURL(path.resolve('lib/project-knowledge.mjs')).href, historyUrl = pathToFileURL(path.resolve('lib/project-history.mjs')).href;
  const script = `import {createProjectHistory} from ${JSON.stringify(historyUrl)}; import {createProjectKnowledge} from ${JSON.stringify(knowledgeUrl)};
  const history=createProjectHistory(${JSON.stringify({stateDirectory,accountId:'user-A'})}).value;
  const service=createProjectKnowledge({...${JSON.stringify({projectId:'project-A',rootPath})},history}).value;
  const refs=${JSON.stringify(refs)}; await service.refresh(); const restored=[]; for(const ref of Object.values(refs)) restored.push(await service.restoreVersion(ref));
  const text=service.read(refs['brief.md']); const csv=service.table({...refs['rooms.csv'],column:1,equals:'A',sumColumn:2}); const xlsx=service.table({...refs['rooms.xlsx'],sheet:'Rooms',column:1,equals:'A',sumColumn:2}); const sheet=service.read(refs['rooms.xlsx']);
  console.log(JSON.stringify({restored,text,csv,xlsx,sheet}));`;
  const out = JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}));
  assert.ok(out.restored.every(item => item.ok));
  assert.equal(out.text.value.lines[0].text,'height 3'); assert.equal(out.text.value.historical,true);
  assert.equal(out.csv.value.sum,20); assert.deepEqual(out.csv.value.locations,[{row:2,column:2},{row:3,column:2}]);
  assert.equal(out.xlsx.value.sum,20); assert.deepEqual(out.xlsx.value.locations,[{sheet:'Rooms',cell:'B2',row:2,column:2},{sheet:'Rooms',cell:'B3',row:3,column:2}]);
  assert.deepEqual(out.sheet.value.lines[0].location,{sheet:'Rooms',cell:'A2'});
});

test('failed persistence never publishes the parsed version and allows a later retry', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-project-fail-'));
  t.after(() => fs.rm(tmp,{recursive:true,force:true}));
  await fs.writeFile(path.join(tmp,'spec.md'),'protected text');
  let reject = true, stored;
  const history = {async saveVersion(input) { if (reject) return {ok:false,error:{code:'HISTORY_CAPACITY'}}; stored = input; return {ok:true}; },async readVersion() { return {ok:false,error:{code:'HISTORY_VERSION_UNAVAILABLE'}}; }};
  const service = createProjectKnowledge({projectId:'p',rootPath:tmp,history}).value;
  assert.equal((await service.refresh()).ok,true);
  const failed = service.list().value.files[0];
  assert.equal(failed.status,'error'); assert.equal(failed.issue,'HISTORY_PERSISTENCE_FAILED'); assert.equal(failed.persistenceIssue,'HISTORY_CAPACITY'); assert.equal(failed.sha256,null);
  assert.equal(service.search({query:'protected'}).value.matches.length,0);
  reject = false; await service.refresh();
  const success = service.list().value.files[0]; assert.equal(success.status,'indexed'); assert.equal(success.persistence,'durable');
  assert.equal(service.read({path:success.path,sha256:success.sha256}).value.lines[0].text,'protected text');
  assert.equal(stored.snapshot.schema,1);
});

test('restore rejects corrupted producer output', async t => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-restore-')); t.after(() => fs.rm(rootPath,{recursive:true,force:true}));
  const sha256 = 'a'.repeat(64);
  const history = {async saveVersion() { return {ok:true}; },async readVersion() { return {ok:true,value:{projectId:'p',path:'a.txt',sha256,source:Buffer.from('wrong'),snapshot:{schema:1,format:'txt',text:'wrong'}}}; }};
  const service = createProjectKnowledge({projectId:'p',rootPath,history}).value;
  assert.equal((await service.restoreVersion({path:'a.txt',sha256})).error.code,'KNOWLEDGE_HISTORY_INVALID');
  assert.equal(service.read({path:'a.txt',sha256}).error.code,'KNOWLEDGE_VERSION_UNAVAILABLE');
});

test('cancellation after a persisted file keeps the prior index and does not publish staged versions', async t => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-cancel-')); t.after(() => fs.rm(rootPath,{recursive:true,force:true}));
  const file = path.join(rootPath,'spec.md'); await fs.writeFile(file,'old text');
  let cancel = false, cancelAfterStore = false; const saved = new Map();
  const history = {
    async saveVersion(input) {saved.set(input.path+'\0'+input.sha256,{...input,source:Buffer.from(input.source)}); if (cancelAfterStore) cancel = true; return {ok:true};},
    async readVersion(input) {const value = saved.get(input.path+'\0'+input.sha256); return value ? {ok:true,value} : {ok:false,error:{code:'HISTORY_VERSION_UNAVAILABLE'}};}
  };
  const service = createProjectKnowledge({projectId:'p',rootPath,history}).value;
  assert.equal((await service.refresh()).ok,true);
  const before = service.list().value, old = before.files[0];
  await fs.writeFile(file,'new text'); cancelAfterStore = true;
  const result = await service.refresh({isCancelled:()=>cancel});
  assert.equal(result.error.code,'KNOWLEDGE_CANCELLED'); assert.equal(result.persistedVersions,1); assert.equal(result.persistenceUnconfirmed,0);
  assert.deepEqual(service.list().value,before);
  assert.equal(service.search({query:'old text'}).value.matches.length,1); assert.equal(service.search({query:'new text'}).value.matches.length,0);
  const latest = [...saved.values()].find(item => item.source.toString() === 'new text');
  assert.equal(service.read({path:'spec.md',sha256:latest.sha256}).error.code,'KNOWLEDGE_VERSION_UNAVAILABLE');
  assert.equal(service.read({path:old.path,sha256:old.sha256}).value.lines[0].text,'old text');
  assert.equal((await service.restoreVersion({path:'spec.md',sha256:latest.sha256})).ok,true);
  assert.equal(service.read({path:'spec.md',sha256:latest.sha256}).value.lines[0].text,'new text');
});

test('cancellation before work and unconfirmed persistence keep results distinct', async t => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-cancel-')); t.after(() => fs.rm(rootPath,{recursive:true,force:true}));
  await fs.writeFile(path.join(rootPath,'one.txt'),'text');
  let cancel = false, attempts = 0;
  const history = {async saveVersion() {attempts++; cancel = true; return {ok:false,error:{code:'HISTORY_IO_ERROR'}};},async readVersion() {return {ok:false};}};
  const service = createProjectKnowledge({projectId:'p',rootPath,history}).value;
  assert.equal((await service.refresh({isCancelled:()=>true})).error.code,'KNOWLEDGE_CANCELLED'); assert.equal(attempts,0);
  assert.equal((await service.refresh({isCancelled:()=>{throw new Error('unknown owner');}})).error.code,'KNOWLEDGE_CANCELLED'); assert.equal(attempts,0);
  const result = await service.refresh({isCancelled:()=>cancel});
  assert.equal(result.error.code,'KNOWLEDGE_CANCELLED'); assert.equal(result.persistedVersions,0); assert.equal(result.persistenceUnconfirmed,1);
  assert.equal(service.list().value.files.length,0); assert.equal(service.list().value.refreshing,false);
});

test('in-memory cancellation during traversal does not publish a partial next index', async t => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-cancel-')); t.after(() => fs.rm(rootPath,{recursive:true,force:true}));
  for (let i=0;i<5;i++) await fs.writeFile(path.join(rootPath,`${i}.txt`),`before ${i}`);
  const service = createProjectKnowledge({projectId:'p',rootPath}).value; assert.equal((await service.refresh()).ok,true);
  const before = service.list().value;
  for (let i=0;i<5;i++) await fs.writeFile(path.join(rootPath,`${i}.txt`),`after ${i}`);
  let checks = 0; const result = await service.refresh({isCancelled:()=>++checks>=12});
  assert.equal(result.error.code,'KNOWLEDGE_CANCELLED'); assert.equal(result.persistedVersions,0);
  assert.deepEqual(service.list().value,before);
  assert.equal(service.search({query:'before'}).value.matches.length,5);
  assert.equal(service.search({query:'after'}).value.matches.length,0);
});
