import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSourcePolicy, DEFAULT_SOURCE_ROOTS, SOURCE_FILE_MAX_BYTES } from '../lib/source-policy.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-source-policy-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source'), sibling = path.join(base, 'source-other');
  await fs.mkdir(root); await fs.mkdir(sibling);
  const roots = [{ id: 'sample-source', path: root }];
  const configured = createSourcePolicy({ roots, ...options });
  assert.equal(configured.ok, true);
  return { base, root, sibling, roots, policy: configured.value,
    inspect: relative => configured.value.inspect({ rootId: 'sample-source', path: relative }) };
}

test('default roots are explicit source subtrees, not user/project runtime roots', () => {
  assert.equal(DEFAULT_SOURCE_ROOTS.length, 7);
  assert.equal(Object.isFrozen(DEFAULT_SOURCE_ROOTS), true);
  assert.equal(DEFAULT_SOURCE_ROOTS.every(Object.isFrozen), true);
  assert.deepEqual(DEFAULT_SOURCE_ROOTS.filter(root => root.id.startsWith('buildx-'))
    .map(root => path.basename(root.path)).sort(), ['lib', 'prompts', 'public', 'revit-addin']);
  assert.equal(DEFAULT_SOURCE_ROOTS.some(root => /(?:workbench|runtime|\.codex)(?:[\\/]|$)/i.test(root.path)), false);
});

test('configuration copies and freezes roots and bounds the pre-read file budget', async t => {
  const f = await fixture(t);
  f.roots[0].path = f.sibling; f.roots.push({ id: 'outside', path: f.base });
  assert.equal(f.policy.roots.length, 1);
  assert.equal(f.policy.roots[0].path, f.root);
  assert.equal(Object.isFrozen(f.policy.roots[0]), true);
  for (const maxFileBytes of [0, -1, 1.5, SOURCE_FILE_MAX_BYTES + 1, '100'])
    assert.equal(createSourcePolicy({ roots: f.roots, maxFileBytes }).error.code, 'INVALID_SOURCE_POLICY');
  for (const roots of [[], [{ id: 'a', path: 'relative' }], [{ id: 'a', path: f.root }, { id: 'a', path: f.root }],
    [{ id: 'bad ID', path: f.root }], [{ id: 'a', path: '\\\\server\\share' }]])
    assert.equal(createSourcePolicy({ roots }).ok, false);
  for (const options of [null, 1, [], 'source', { roots: f.roots, override: true }])
    assert.equal(createSourcePolicy(options).error.code, 'INVALID_SOURCE_POLICY');
});

test('root configuration canonicalizes once and rejects network, device and implicit-drive roots without IO', () => {
  const invalid = ['//server/share/source', '\\\\server/share/source', '\\\\?\\D:\\source', '\\\\.\\D:\\source',
    'D:relative', '\\source'];
  if (process.platform === 'win32') invalid.push('/source');
  for (const selected of invalid)
    assert.equal(createSourcePolicy({ roots: [{ id: 'source', path: selected }] }).error.code, 'INVALID_SOURCE_POLICY', selected);
  const valid = process.platform === 'win32' ? ['D:\\source', 'D:/source'] : ['/source'];
  for (const selected of valid) {
    const result = createSourcePolicy({ roots: [{ id: 'source', path: selected }] });
    assert.equal(result.ok, true, selected);
    assert.equal(result.value.roots[0].path, path.resolve(selected));
  }
});

test('real source files and directories return JSON-safe metadata without bytes or invented hash', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested')); await fs.writeFile(path.join(f.root, 'nested', 'Example.cs'), 'class Example {}');
  const result = await f.inspect('nested/Example.cs');
  assert.equal(result.ok, true);
  assert.equal(result.value.byteLength, 16);
  assert.equal(result.value.sha256, null);
  assert.equal(result.value.hashStatus, 'not_computed');
  assert.equal(result.value.contentsRead, false);
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
    assert.match(result.value[key], /^[0-9]+$/);
    assert.match(result.value.rootIdentity[key], /^[0-9]+$/);
  }
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal((await f.inspect('')).value.kind, 'directory');
  assert.equal((await f.inspect('nested')).value.kind, 'directory');
  assert.equal((await f.policy.revalidate(result.value)).ok, true);
  assert.equal((await f.policy.revalidate({ ...result.value, absolutePath: path.join(f.sibling, 'secret.cs') })).ok, true);
});

test('relative POSIX path boundary rejects traversal and Windows alternate names', async t => {
  const f = await fixture(t);
  const invalid = ['../source-other/File.cs', 'nested/../../File.cs', './File.cs', '/File.cs', 'C:/File.cs',
    'C:File.cs', '\\\\server\\share\\File.cs', 'nested\\File.cs', 'a//File.cs', 'a/', 'a/../File.cs',
    'File.cs:stream', 'File.cs\0', 'CON', 'con.cs', 'a/COM1.txt', 'LPT².cs', 'NUL.txt', 'aux.cs',
    'CLOCK$.cs', 'CONIN$.cs', 'file.cs.', 'file.cs ', ' name.cs', 'SHORT~1.cs', 'a?b.cs', 'a\nb.cs'];
  for (const relative of invalid) assert.equal((await f.inspect(relative)).error.code, 'INVALID_SOURCE_PATH', relative);
  for (const relative of [null, 1, {}, undefined])
    assert.equal((await f.inspect(relative)).error.code, 'INVALID_SOURCE_PATH');
  assert.equal((await f.policy.inspect({ rootId: 'unknown', path: '' })).error.code, 'UNKNOWN_SOURCE_ROOT');
  assert.equal((await f.policy.inspect({ rootId: '__proto__', path: '' })).error.code, 'UNKNOWN_SOURCE_ROOT');
  for (const extra of [{ absolutePath: f.sibling }, { overrideRoot: f.sibling }])
    assert.equal((await f.policy.inspect({ rootId: 'sample-source', path: '', ...extra })).error.code, 'INVALID_SOURCE_REQUEST');
});

test('generated, private, credential and model paths are excluded by the owning boundary', async t => {
  const f = await fixture(t);
  for (const relative of ['bin/File.cs', 'bin-schematic-040/Generated.cs', 'obj-next/Generated.cs', 'backups/File.cs', '.git/config', '.env', 'runtime/server.json',
    'workbench/queue/status.json', 'logs/event.json', 'credentials/test.cs', 'node_modules/pkg/File.cs'])
    assert.equal((await f.inspect(relative)).error.code, 'EXCLUDED_SOURCE_PATH', relative);
  for (const name of ['auth.json', 'credentials.json', 'appsettings.Production.json', 'config.toml',
    'secret.pem', 'Project.rvt', 'Valve.rfa', 'Model.rte', 'Input.dwg', 'Assembly.dll', 'Program.exe', 'image.png', 'trace.log']) {
    await fs.writeFile(path.join(f.root, name), 'fixture');
    assert.equal((await f.inspect(name)).error.code, 'EXCLUDED_SOURCE_FILE', name);
  }
  await fs.writeFile(path.join(f.root, 'Auth.cs'), 'class Auth {}');
  assert.equal((await f.inspect('Auth.cs')).ok, true);
});

test('file size budget is checked from real metadata before any content access', async t => {
  const f = await fixture(t, { maxFileBytes: 8 });
  await fs.writeFile(path.join(f.root, 'Exact.cs'), '12345678');
  await fs.writeFile(path.join(f.root, 'Large.cs'), '123456789');
  assert.equal((await f.inspect('Exact.cs')).value.byteLength, 8);
  assert.equal((await f.inspect('Large.cs')).error.code, 'SOURCE_FILE_TOO_LARGE');
});

test('revalidation detects real file metadata changes and replacement', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'File.cs'); await fs.writeFile(file, 'before');
  const before = (await f.inspect('File.cs')).value;
  await fs.writeFile(file, 'after-more');
  assert.equal((await f.policy.revalidate(before)).error.code, 'SOURCE_IDENTITY_CHANGED');
  const second = (await f.inspect('File.cs')).value;
  await fs.rename(file, path.join(f.root, 'old.cs')); await fs.writeFile(file, 'after-more');
  assert.equal((await f.policy.revalidate(second)).error.code, 'SOURCE_IDENTITY_CHANGED');
  assert.equal((await f.policy.revalidate({ ...second, path: '../source-other/File.cs' })).error.code, 'INVALID_SOURCE_PATH');
  assert.equal((await f.policy.revalidate({})).error.code, 'INVALID_SOURCE_IDENTITY');
});

test('a real sibling with a similar name never grants access and errors omit outside paths', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sibling, 'private.cs'), 'outside secret content');
  const result = await f.inspect('../source-other/private.cs');
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(f.sibling), false);
  assert.equal(JSON.stringify(result).includes('outside secret content'), false);
  const missing = await f.inspect('missing.cs');
  assert.equal(missing.error.code, 'SOURCE_NOT_FOUND');
  assert.equal(JSON.stringify(missing).includes(f.root), false);
});

test('real hard-linked files are rejected even when their relative name looks like source', async t => {
  const f = await fixture(t);
  const outside = path.join(f.sibling, 'private.cs'); await fs.writeFile(outside, 'outside content');
  await fs.link(outside, path.join(f.root, 'Linked.cs'));
  assert.equal((await f.inspect('Linked.cs')).error.code, 'SOURCE_LINK_REJECTED');
});

for (const type of process.platform === 'win32' ? ['file', 'dir', 'junction'] : ['file', 'dir']) {
  test(`real ${type} links are rejected, including links targeting the same root`, async t => {
    const f = await fixture(t);
    const target = type === 'file' ? path.join(f.sibling, 'private.cs') : f.sibling;
    if (type === 'file') await fs.writeFile(target, 'outside');
    const link = path.join(f.root, type === 'file' ? 'Linked.cs' : 'linked');
    try { await fs.symlink(target, link, type); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Host cannot create ${type} links.`); return; } throw error; }
    assert.equal((await f.inspect(path.basename(link))).error.code, 'SOURCE_LINK_REJECTED');
    if (type !== 'file') {
      await fs.writeFile(path.join(f.sibling, 'private.cs'), 'outside');
      assert.equal((await f.inspect('linked/private.cs')).error.code, 'SOURCE_LINK_REJECTED');
      await fs.unlink(link);
      await fs.mkdir(path.join(f.root, 'inside')); await fs.writeFile(path.join(f.root, 'inside', 'File.cs'), 'inside');
      await fs.symlink(path.join(f.root, 'inside'), link, type);
      assert.equal((await f.inspect('linked/File.cs')).error.code, 'SOURCE_LINK_REJECTED');
    }
  });
}

test('configured roots reached through a real junction or link are rejected', async t => {
  const f = await fixture(t);
  const link = path.join(f.base, 'root-alias');
  try { await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Host cannot create directory links.'); return; } throw error; }
  for (const selected of [link, path.join(link, 'nested')]) {
    const configured = createSourcePolicy({ roots: [{ id: 'linked', path: selected }] });
    assert.equal((await configured.value.inspect({ rootId: 'linked', path: '' })).error.code, 'SOURCE_LINK_REJECTED');
  }
});

test('root replacement remains rejected after its first real identity was bound', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'File.cs'), 'before');
  const identity = (await f.inspect('File.cs')).value;
  await fs.rename(f.root, path.join(f.base, 'old-root')); await fs.mkdir(f.root);
  await fs.writeFile(path.join(f.root, 'File.cs'), 'before');
  assert.equal((await f.inspect('File.cs')).error.code, 'SOURCE_ROOT_CHANGED');
  assert.equal((await f.policy.revalidate(identity)).error.code, 'SOURCE_ROOT_CHANGED');
});
