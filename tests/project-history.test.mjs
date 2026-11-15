import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createProjectHistory} from '../lib/project-history.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-project-history-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const stateDirectory = path.join(root, 'state'), selected = path.join(root, 'selected');
  await fs.mkdir(stateDirectory); await fs.mkdir(selected);
  const store = accountId => createProjectHistory({stateDirectory, accountId}).value;
  return {root, stateDirectory, selected, store};
}

test('binding and exact older snapshot survive a new Node process; accounts and projects are separate', async t => {
  const {stateDirectory, selected, store} = await fixture(t), owner = store('user-A');
  assert.equal((await owner.bind({projectId: 'project-1', rootPath: selected})).ok, true);
  const source = Buffer.from('earlier version\n'), sha256 = digest(source), snapshot = {text: 'earlier version\n', rows: [['earlier version']]};
  assert.equal((await owner.saveVersion({projectId: 'project-1', path: 'spec.csv', sha256, source, snapshot})).ok, true);
  const newer = Buffer.from('newer version\n');
  assert.equal((await owner.saveVersion({projectId: 'project-1', path: 'spec.csv', sha256: digest(newer), source: newer, snapshot: {text: 'newer version\n'}})).ok, true);
  const moduleUrl = pathToFileURL(path.resolve('lib/project-history.mjs')).href;
  const script = `import {createProjectHistory} from ${JSON.stringify(moduleUrl)}; const s=createProjectHistory(${JSON.stringify({stateDirectory, accountId:'user-A'})}).value; const a=await s.currentBinding(); const b=await s.readVersion(${JSON.stringify({projectId:'project-1',path:'spec.csv',sha256})}); console.log(JSON.stringify({a,b:{...b,value:{...b.value,source:b.value.source.toString('utf8')}}}));`;
  const reopened = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'}));
  assert.deepEqual(reopened.a.value, {projectId: 'project-1', rootPath: selected});
  assert.equal(reopened.b.value.source, 'earlier version\n'); assert.deepEqual(reopened.b.value.snapshot, snapshot);
  assert.equal((await store('user-B').currentBinding()).value, null);
  assert.equal((await store('user-B').readVersion({projectId:'project-1',path:'spec.csv',sha256})).error.code, 'HISTORY_VERSION_UNAVAILABLE');
  assert.equal((await owner.readVersion({projectId:'project-2',path:'spec.csv',sha256})).error.code, 'HISTORY_VERSION_UNAVAILABLE');
});

test('unavailable replaced root and corrupt snapshots fail closed without substituting current data', async t => {
  const {root, selected, stateDirectory, store} = await fixture(t), owner = store('user-A');
  await owner.bind({projectId:'one', rootPath:selected});
  const source = Buffer.from('old'), sha256 = digest(source);
  await owner.saveVersion({projectId:'one',path:'a.txt',sha256,source,snapshot:{text:'old'}});
  await fs.rename(selected, path.join(root, 'former-selected')); await fs.mkdir(selected);
  assert.equal((await owner.currentBinding()).error.code, 'HISTORY_ROOT_CHANGED');
  const account = path.join(stateDirectory, `account-${digest('user-A')}`), file = (await fs.readdir(account)).find(name => name.startsWith('v-'));
  const record = JSON.parse(await fs.readFile(path.join(account,file), 'utf8')); record.source = Buffer.from('new').toString('base64');
  await fs.writeFile(path.join(account,file), JSON.stringify(record));
  assert.equal((await owner.readVersion({projectId:'one',path:'a.txt',sha256})).error.code, 'HISTORY_RECORD_INVALID');
});

test('binding rejects equal and nested source and history roots without confusing sibling names', async t => {
  const {root,stateDirectory,store} = await fixture(t), owner = store('overlap');
  const nested = path.join(stateDirectory,'source'), sibling = path.join(root,'state-neighbor');
  await fs.mkdir(nested); await fs.mkdir(sibling);
  for (const rootPath of [stateDirectory, root, nested]) {
    const result = await owner.bind({projectId:'p',rootPath});
    assert.equal(result.error.code,'HISTORY_ROOT_OVERLAP');
  }
  if (process.platform === 'win32') assert.equal((await owner.bind({projectId:'p',rootPath:stateDirectory.toUpperCase()})).error.code,'HISTORY_ROOT_OVERLAP');
  const account = path.join(stateDirectory,`account-${digest('overlap')}`);
  await assert.rejects(fs.lstat(account),{code:'ENOENT'});
  assert.equal((await owner.bind({projectId:'p',rootPath:sibling})).ok,true);
  assert.deepEqual((await owner.currentBinding()).value,{projectId:'p',rootPath:sibling});
});

test('restoring a preexisting binding rejects overlapping roots even with matching directory identity', async t => {
  const {root,stateDirectory,selected,store} = await fixture(t), owner = store('legacy-overlap');
  assert.equal((await owner.bind({projectId:'p',rootPath:selected})).ok,true);
  const dir = path.join(stateDirectory,`account-${digest('legacy-overlap')}`), name = (await fs.readdir(dir)).find(item => item.startsWith('b-'));
  const file = path.join(dir,name), original = JSON.parse(await fs.readFile(file,'utf8'));
  for (const rootPath of [stateDirectory,root]) {
    const stat = await fs.lstat(rootPath,{bigint:true});
    await fs.writeFile(file,JSON.stringify({...original,rootPath,rootIdentity:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`}));
    assert.equal((await owner.currentBinding()).error.code,'HISTORY_ROOT_OVERLAP');
  }
});

test('limits, malformed inputs, conflicts and unresolved locks leave existing data intact', async t => {
  const {stateDirectory, store} = await fixture(t), owner = store('user-A');
  const source = Buffer.from('one'), sha256 = digest(source), ref = {projectId:'p',path:'dir/a.txt',sha256,source,snapshot:{text:'one'}};
  assert.equal((await owner.saveVersion(ref)).ok, true);
  assert.equal((await owner.saveVersion(ref)).value.existing, true);
  assert.equal((await owner.saveVersion({...ref,snapshot:{text:'different'}})).error.code, 'HISTORY_VERSION_CONFLICT');
  assert.equal((await owner.saveVersion({...ref,path:'../a'})).error.code, 'HISTORY_REFERENCE_INVALID');
  assert.equal((await owner.saveVersion({...ref,source:Buffer.from('bad')})).error.code, 'HISTORY_SOURCE_INVALID');
  assert.equal((await owner.saveVersion({...ref,snapshot:{bad:undefined}})).error.code, 'HISTORY_SNAPSHOT_INVALID');
  const tiny = createProjectHistory({stateDirectory,accountId:'small',maxEntries:1}).value;
  assert.equal((await tiny.saveVersion(ref)).ok, true);
  assert.equal((await tiny.saveVersion({...ref,path:'other.txt'})).error.code, 'HISTORY_CAPACITY');
  const account = path.join(stateDirectory, `account-${digest('user-A')}`), lock = path.join(account, '.project-history.lock');
  await fs.writeFile(lock, 'unknown');
  assert.equal((await owner.readVersion(ref)).error.code, 'HISTORY_LOCKED');
  assert.equal(await fs.readFile(lock, 'utf8'), 'unknown');
});

test('separate owners serialize through the same lock and preserve admitted bytes', async t => {
  const {store} = await fixture(t), first = store('same-user'), second = store('same-user');
  const source = Buffer.from('one'), sha256 = digest(source), snapshot = {text: 'one'};
  const save = first.saveVersion({projectId:'p',path:'a.txt',sha256,source,snapshot});
  source.fill(120); snapshot.text = 'changed';
  const competing = second.saveVersion({projectId:'p',path:'b.txt',sha256,source:Buffer.from('one'),snapshot:{text:'one'}});
  const [saved, other] = await Promise.all([save, competing]);
  assert.ok([saved, other].some(result => result.ok));
  for (const result of [saved, other].filter(result => !result.ok)) assert.equal(result.error.code, 'HISTORY_LOCKED');
  if (saved.ok) assert.equal((await first.readVersion({projectId:'p',path:'a.txt',sha256})).value.snapshot.text, 'one');
});

function wrapped(handle, overrides = {}) {
  return new Proxy(handle, {get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  }});
}

test('owned partial stages are cleaned and post-link failures retain a verifiable complete record', async t => {
  const {stateDirectory} = await fixture(t); let partial = true;
  const owner = createProjectHistory({stateDirectory,accountId:'partial'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (partial && path.basename(args[0]).startsWith('pending-')) return wrapped(h,{writeFile:async bytes => { await h.writeFile(bytes.subarray(0,10)); throw new Error('injected write failure'); }});
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  assert.equal((await owner.saveVersion(ref)).ok,false);
  const dir = path.join(stateDirectory,`account-${digest('partial')}`), files = await fs.readdir(dir);
  assert.equal(files.filter(name => name.startsWith('pending-')).length,0); assert.equal(files.some(name => name.startsWith('v-')),false);
  partial = false; assert.equal((await owner.readVersion(ref)).error.code,'HISTORY_VERSION_UNAVAILABLE');
  const afterLink = createProjectHistory({stateDirectory,accountId:'linked'}, {link:async (from,to) => {await fs.link(from,to); throw new Error('injected post-link failure');}}).value;
  assert.equal((await afterLink.saveVersion(ref)).ok,false);
  const dir2 = path.join(stateDirectory,`account-${digest('linked')}`), files2 = await fs.readdir(dir2);
  assert.equal(files2.some(name => name.startsWith('pending-')),false); assert.ok(files2.some(name => name.startsWith('v-')));
  assert.equal((await afterLink.readVersion(ref)).ok,true);
});

test('failed stage and directory closes retain handles for cleanup and never publish partial stages', async t => {
  const {stateDirectory} = await fixture(t); let stageFailures = 2;
  const staged = createProjectHistory({stateDirectory,accountId:'stage-close'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (path.basename(args[0]).startsWith('pending-')) return wrapped(h,{close:async () => {if (stageFailures-- > 0) throw new Error('injected stage close'); return h.close();}});
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const stageResult = await staged.saveVersion(ref); assert.equal(stageResult.error.code,'HISTORY_CLOSE_UNCONFIRMED'); assert.equal(stageResult.cleanupPending,true);
  assert.equal((await staged.cleanup()).ok,true);
  const dir = path.join(stateDirectory,`account-${digest('stage-close')}`), entries = await fs.readdir(dir);
  assert.equal(entries.some(name => name.startsWith('pending-')),false); assert.equal(entries.some(name => name.startsWith('v-')),false);
  let dirFailures = 2;
  const directory = createProjectHistory({stateDirectory,accountId:'dir-close'}, {opendir:async (...args) => {
    const h = await fs.opendir(...args);
    return wrapped(h,{close:async () => {if (dirFailures-- > 0) throw new Error('injected directory close'); return h.close();}});
  }}).value;
  const dirResult = await directory.currentBinding(); assert.equal(dirResult.error.code,'HISTORY_CLOSE_UNCONFIRMED'); assert.equal(dirResult.cleanupPending,true);
  assert.equal((await directory.cleanup()).ok,true);
  assert.equal((await directory.currentBinding()).ok,true);
});

test('failed record close retains the owner and retries cleanup before releasing its lock', async t => {
  const {stateDirectory} = await fixture(t); let closeFailures = 2, closeAttempts = 0;
  const owner = createProjectHistory({stateDirectory,accountId:'close'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (args[1] === 'r') return wrapped(h,{close:async () => {closeAttempts++; if (closeFailures-- > 0) throw new Error('injected close failure'); return h.close();}});
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  assert.equal((await owner.saveVersion(ref)).ok,true);
  const failed = await owner.readVersion(ref); assert.equal(failed.error.code,'HISTORY_CLOSE_UNCONFIRMED'); assert.equal(failed.cleanupPending,true);
  const dir = path.join(stateDirectory,`account-${digest('close')}`);
  assert.ok((await fs.readdir(dir)).includes('.project-history.lock'));
  assert.equal((await owner.cleanup()).ok,true); assert.ok(closeAttempts >= 3);
  assert.equal((await owner.readVersion(ref)).ok,true);
});

test('unknown lock identity closes the handle but preserves the unclaimable lock', async t => {
  const {stateDirectory} = await fixture(t); let closed = false;
  const owner = createProjectHistory({stateDirectory,accountId:'unknown'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (path.basename(args[0]) === '.project-history.lock') return wrapped(h,{stat:async () => {throw new Error('injected stat failure');},close:async () => {await h.close(); closed = true;}});
    return h;
  }}).value;
  const failed = await owner.currentBinding(); assert.equal(failed.error.code,'HISTORY_IO_ERROR'); assert.equal(failed.cleanupPending,true); assert.equal(closed,true);
  assert.equal((await owner.cleanup()).error.code,'HISTORY_CLEANUP_UNCONFIRMED');
  const dir = path.join(stateDirectory,`account-${digest('unknown')}`);
  assert.ok((await fs.readdir(dir)).includes('.project-history.lock'));
});

test('queue rejects excess work before snapshot serialization', async t => {
  const {stateDirectory} = await fixture(t); let unblock;
  const gate = new Promise(resolve => {unblock = resolve;});
  const owner = createProjectHistory({stateDirectory,accountId:'queue'}, {open:async (...args) => {if (path.basename(args[0]) === '.project-history.lock') await gate; return fs.open(...args);}}).value;
  const source = Buffer.from('source'), sha256 = digest(source);
  const pending = Array.from({length:4},(_,i) => owner.saveVersion({projectId:'p',path:`${i}.txt`,sha256,source,snapshot:{text:'source'}}));
  let touched = false; const snapshot = {get text() {touched = true; return 'source';}};
  assert.equal((await owner.saveVersion({projectId:'p',path:'overflow.txt',sha256,source,snapshot})).error.code,'HISTORY_BUSY'); assert.equal(touched,false);
  unblock(); const results = await Promise.all(pending); assert.ok(results.every(result => result.ok));
});

test('unlink failure retains stage ownership and lock until cleanup retry', async t => {
  const {stateDirectory} = await fixture(t); let failures = 2;
  const owner = createProjectHistory({stateDirectory,accountId:'unlink'}, {unlink:async file => {
    if (path.basename(file).startsWith('pending-') && failures-- > 0) throw new Error('injected unlink failure');
    await fs.unlink(file);
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const result = await owner.saveVersion(ref); assert.equal(result.error.code,'HISTORY_IO_ERROR'); assert.equal(result.cleanupPending,true);
  const dir = path.join(stateDirectory,`account-${digest('unlink')}`), names = await fs.readdir(dir);
  assert.ok(names.includes('.project-history.lock')); assert.ok(names.some(name => name.startsWith('pending-'))); assert.ok(names.some(name => name.startsWith('v-')));
  assert.equal((await owner.readVersion(ref)).error.code,'HISTORY_CLEANUP_UNCONFIRMED');
  assert.equal((await owner.cleanup()).ok,true);
  assert.equal((await owner.readVersion(ref)).ok,true);
  const after = await fs.readdir(dir); assert.equal(after.some(name => name.startsWith('pending-')),false);
});

test('primary write error survives a secondary close failure and owned stage is cleaned on retry', async t => {
  const {stateDirectory} = await fixture(t); let failures = 2;
  const owner = createProjectHistory({stateDirectory,accountId:'primary'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (path.basename(args[0]).startsWith('pending-')) return wrapped(h,{
      writeFile:async bytes => {await h.writeFile(bytes.subarray(0,10)); throw Object.assign(new Error('injected write'),{historyCode:'HISTORY_TEST_WRITE'});},
      close:async () => {if (failures-- > 0) throw new Error('injected close'); return h.close();}
    });
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const result = await owner.saveVersion(ref); assert.equal(result.error.code,'HISTORY_TEST_WRITE'); assert.equal(result.cleanupPending,true);
  assert.equal((await owner.cleanup()).ok,true);
  const dir = path.join(stateDirectory,`account-${digest('primary')}`), files = await fs.readdir(dir);
  assert.equal(files.some(name => name.startsWith('pending-')),false); assert.equal(files.some(name => name.startsWith('v-')),false);
});

test('unknown stage identity preserves stage and lock until ownership becomes provable', async t => {
  const {root,stateDirectory} = await fixture(t); let savedStage, foreign;
  const owner = createProjectHistory({stateDirectory,accountId:'replacement'}, {link:async (stage) => {
    savedStage = path.join(root,'saved-stage'); foreign = stage;
    await fs.rename(stage,savedStage); await fs.writeFile(stage,'foreign');
    throw Object.assign(new Error('injected replacement'),{historyCode:'HISTORY_TEST_LINK'});
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const result = await owner.saveVersion(ref); assert.equal(result.error.code,'HISTORY_TEST_LINK'); assert.equal(result.cleanupPending,true);
  assert.equal(await fs.readFile(foreign,'utf8'),'foreign');
  assert.equal((await owner.cleanup()).error.code,'HISTORY_CLEANUP_UNCONFIRMED');
  assert.equal(await fs.readFile(foreign,'utf8'),'foreign');
  // Restore the test-owned original only after checking the foreign path was preserved.
  await fs.unlink(foreign); await fs.rename(savedStage,foreign);
  assert.equal((await owner.cleanup()).ok,true);
});

test('sync failure cleans an owned unpublished stage and preserves the primary failure', async t => {
  const {stateDirectory} = await fixture(t);
  const owner = createProjectHistory({stateDirectory,accountId:'sync'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (path.basename(args[0]).startsWith('pending-')) return wrapped(h,{sync:async () => {throw Object.assign(new Error('injected sync'),{historyCode:'HISTORY_TEST_SYNC'});}});
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  assert.equal((await owner.saveVersion(ref)).error.code,'HISTORY_TEST_SYNC');
  const dir = path.join(stateDirectory,`account-${digest('sync')}`);
  assert.equal((await fs.readdir(dir)).some(name => name.startsWith('pending-')),false);
  assert.equal((await owner.readVersion(ref)).error.code,'HISTORY_VERSION_UNAVAILABLE');
});

test('stage stat failure retains the open handle until identity can be proven on retry', async t => {
  const {stateDirectory} = await fixture(t); let statFailures = 2, stageClosed = false;
  const owner = createProjectHistory({stateDirectory,accountId:'stage-stat'}, {open:async (...args) => {
    const h = await fs.open(...args);
    if (path.basename(args[0]).startsWith('pending-')) return wrapped(h,{
      stat:async options => {if (statFailures-- > 0) throw Object.assign(new Error('injected stat'),{historyCode:'HISTORY_TEST_STAT'}); return h.stat(options);},
      close:async () => {await h.close(); stageClosed = true;}
    });
    return h;
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const result = await owner.saveVersion(ref); assert.equal(result.error.code,'HISTORY_TEST_STAT'); assert.equal(result.cleanupPending,true); assert.equal(stageClosed,false);
  assert.equal((await owner.cleanup()).ok,true); assert.equal(stageClosed,true);
  assert.equal((await owner.readVersion(ref)).error.code,'HISTORY_VERSION_UNAVAILABLE');
});

test('unlink that succeeds but reports failure is reconciled without losing the primary error', async t => {
  const {stateDirectory} = await fixture(t); let injected = false;
  const owner = createProjectHistory({stateDirectory,accountId:'unlink-unknown'}, {unlink:async file => {
    await fs.unlink(file);
    if (!injected && path.basename(file).startsWith('pending-')) {injected = true; throw Object.assign(new Error('lost result'),{historyCode:'HISTORY_TEST_UNLINK'});}
  }}).value;
  const source = Buffer.from('source'), sha256 = digest(source), ref = {projectId:'p',path:'a.txt',sha256,source,snapshot:{text:'source'}};
  const result = await owner.saveVersion(ref); assert.equal(result.error.code,'HISTORY_TEST_UNLINK');
  assert.equal((await owner.readVersion(ref)).ok,true);
});
