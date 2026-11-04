import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createProjectHistory} from '../lib/project-history.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleUrl = pathToFileURL(path.resolve('lib/project-history.mjs')).href;

async function stopAt(stateDirectory, accountId, point, ref) {
  const script = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {createProjectHistory} from ${JSON.stringify(moduleUrl)};
    const point = ${JSON.stringify(point)};
    const pause = async () => { process.send('paused'); await new Promise(() => {}); };
    const wrap = (h, overrides) => new Proxy(h, {get(t, key) { const v = overrides[key] ?? t[key]; return typeof v === 'function' ? v.bind(t) : v; }});
    const deps = {
      open: async (...args) => {
        const h = await fs.open(...args), name = path.basename(args[0]);
        if (name === '.project-history.lock' && point === 'lock') return wrap(h, {sync: async () => { await h.sync(); await pause(); }});
        if (name.startsWith('pending-') && point === 'partial') return wrap(h, {writeFile: async bytes => { await h.writeFile(bytes.subarray(0, 10)); await h.sync(); await pause(); }});
        return h;
      },
      link: async (from, to) => { await fs.link(from, to); if (point === 'linked') await pause(); },
      unlink: async file => { await fs.unlink(file); if (point === 'unlinked' && path.basename(file).startsWith('pending-')) await pause(); }
    };
    const store = createProjectHistory(${JSON.stringify({stateDirectory, accountId})}, deps).value;
    const ref = ${JSON.stringify(ref)}; ref.source = Buffer.from(ref.source, 'base64');
    await store.saveVersion(ref);
    process.exit(2);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio:['ignore','pipe','pipe','ipc']});
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child timeout at ${point}: ${stderr}`)), 10000);
      child.once('message', message => { clearTimeout(timer); message === 'paused' ? resolve() : reject(new Error('unexpected child message')); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited early (${code}): ${stderr}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
  }
}

test('process termination preserves unresolved lock and stages; isolated manual recovery retains complete history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-history-crash-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const stateDirectory = path.join(root, 'state'), selected = path.join(root, 'selected');
  await fs.mkdir(stateDirectory); await fs.mkdir(selected);
  const source = Buffer.from('old bytes'), sha256 = digest(source);
  const prior = {projectId:'project', path:'old.txt', sha256, source, snapshot:{text:'old'}};
  const nextBytes = Buffer.from('new bytes'), next = {projectId:'project', path:'new.txt', sha256:digest(nextBytes), source:nextBytes, snapshot:{text:'new'}};
  for (const point of ['lock', 'partial', 'linked', 'unlinked']) {
    const accountId = `crash-${point}`, dir = path.join(stateDirectory, `account-${digest(accountId)}`);
    const owner = createProjectHistory({stateDirectory, accountId}).value;
    assert.equal((await owner.bind({projectId:'project', rootPath:selected})).ok, true);
    assert.equal((await owner.saveVersion(prior)).ok, true);
    await stopAt(stateDirectory, accountId, point, {...next, source:next.source.toString('base64')});

    const names = (await fs.readdir(dir)).sort();
    const stages = names.filter(name => name.startsWith('pending-'));
    const versions = names.filter(name => name.startsWith('v-'));
    assert.ok(names.includes('.project-history.lock'), point);
    assert.equal(stages.length, ['partial','linked'].includes(point) ? 1 : 0, point);
    assert.equal(versions.length, ['linked','unlinked'].includes(point) ? 2 : 1, point);
    const before = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(dir,name))])));
    const reopened = createProjectHistory({stateDirectory, accountId}).value;
    assert.equal((await reopened.currentBinding()).error.code, 'HISTORY_LOCKED', point);
    assert.equal((await reopened.readVersion(prior)).error.code, 'HISTORY_LOCKED', point);
    assert.equal((await reopened.cleanup()).ok, true, point); // No resources owned by this new process.
    assert.deepEqual((await fs.readdir(dir)).sort(), names, point);
    for (const [name, bytes] of before) assert.deepEqual(await fs.readFile(path.join(dir,name)), bytes, `${point}: ${name}`);

    // The fixture owns these exact temporary files and the writer is confirmed dead.
    // This is not a general procedure for unknown production locks.
    for (const name of stages) await fs.unlink(path.join(dir,name));
    await fs.unlink(path.join(dir,'.project-history.lock'));
    assert.deepEqual((await reopened.currentBinding()).value, {projectId:'project',rootPath:selected}, point);
    assert.deepEqual((await reopened.readVersion(prior)).value.source, source, point);
    const recovered = await reopened.readVersion(next);
    if (['linked','unlinked'].includes(point)) {
      assert.equal(recovered.ok, true, point);
      assert.deepEqual(recovered.value.source, nextBytes, point);
      assert.deepEqual(recovered.value.snapshot, next.snapshot, point);
    } else assert.equal(recovered.error.code, 'HISTORY_VERSION_UNAVAILABLE', point);
  }
});
