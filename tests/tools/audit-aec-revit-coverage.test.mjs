import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {auditCoverage, readAecRows} from '../../tools/audit-aec-revit-coverage.mjs';

const inventory = JSON.parse(await readFile(new URL('../../docs/migration/aec-revit-command-inventory.json', import.meta.url), 'utf8'));
const crosswalk = await readFile(new URL('../../docs/migration/AEC-103-CROSSWALK.zh-CN.md', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');

async function candidateFixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'buildx-aec-coverage-'));
  assert.equal(path.dirname(root), parent);
  t.after(() => rm(root, {recursive: true, force: true}));
  const dll = 'revit-addin/bin/LocalCodexRevit.dll';
  const contracts = [{tool:'revit_list_family_types', enabled:true, readOnly:true},
    {tool:'revit_create_pipe', enabled:true, readOnly:false}, {tool:'revit_create_group', enabled:true, readOnly:false},
    {tool:'revit_family_inspect_job', enabled:true, readOnly:true}];
  const contents = {
    'lib/model-command-catalog.mjs': `export const MODEL_COMMAND_CATALOG = ${JSON.stringify(contracts)};`,
    'lib/panel-tools.mjs': "export const MODEL_AI_READ_TOOLS = [{name:'revit_list_family_types'},{name:'revit_family_inspect_job'}];",
    'lib/confirmed-write-profile.mjs': `import {readFileSync} from 'node:fs'; import path from 'node:path';
      export const confirmedWriteProfile = root => readFileSync(path.join(root,'buildx-confirmed-write.json'),'utf8') === 'confirmed-write';
      export const supportsConfirmedWriteCommand = cmd => cmd.tool === 'revit_create_group' || cmd.readOnly && !cmd.tool.startsWith('revit_family_');`,
    'buildx-confirmed-write.json': 'confirmed-write',
    [dll]: 'fixture dll bytes',
  };
  for (const [relative, bytes] of Object.entries(contents)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, bytes);
  }
  const manifest = {stage:'candidate', releaseReady:false, productVersion:'fixture',
    target:{platform:'win32', architecture:'x64', revit:'2024'},
    files:Object.entries(contents).map(([relative, content]) => ({path:relative, sha256:sha(content)})),
    buildEvidence:{compilerExit:0, compilerOptions:['/define:BUILDX_CONFIRMED_WRITE'], dllSha256:sha(contents[dll]),
      sources:[{path:'revit-addin/WorkbenchHost.cs', sha256:sha('fixture source')}]}};
  await writeFile(path.join(root, 'buildx-package.json'), JSON.stringify(manifest));
  return root;
}

test('the canonical frozen inventory and crosswalk have the same 103 unique names', () => {
  const rows = readAecRows(inventory, crosswalk);
  assert.equal(rows.length, 103);
  const alias = rows.find(row => row.name === 'revit_list_families');
  assert.deepEqual(alias.mappedNames, ['revit_list_families', 'revit_list_family_types']);
  assert.match(alias.comparison, /未提供完整族层级/);
});

test('incomplete or duplicate crosswalk rows stop the audit', () => {
  const row = crosswalk.split(/\r?\n/).find(line => line.startsWith('| `revit_edit_family`'));
  assert.throws(() => readAecRows(inventory, crosswalk.replace(row, '')), /account for every/);
  assert.throws(() => readAecRows(inventory, crosswalk + '\n' + row), /duplicate crosswalk name/);
});

test('distinguishes packaged source, panel eligibility and MCP listing without granting execution', async t => {
  const report = await auditCoverage(await candidateFixture(t));
  const row = name => report.rows.find(item => item.name === `revit_${name}`);
  assert.deepEqual(row('list_families').candidatePanelEligible, ['revit_list_family_types']);
  assert.deepEqual(row('create_pipe').sourceContracts, ['revit_create_pipe']);
  assert.deepEqual(row('create_pipe').candidateContracts, ['revit_create_pipe']);
  assert.deepEqual(row('create_pipe').candidatePanelEligible, []);
  assert.deepEqual(row('create_group').candidatePanelEligible, ['revit_create_group']);
  assert.deepEqual(row('create_group').candidateMcpReadCatalog, []);
  assert.deepEqual(row('edit_family').candidateMcpReadCatalog, ['revit_family_inspect_job']);
  assert.deepEqual(row('edit_family').candidatePanelEligible, []);
  assert.match(report.definition, /do not establish host acceptance/);
});

test('rejects a changed packaged module before importing it', async t => {
  const root = await candidateFixture(t);
  await writeFile(path.join(root, 'lib/panel-tools.mjs'), "throw new Error('imported unexpectedly');");
  await assert.rejects(auditCoverage(root), /Payload SHA-256 mismatch for lib\/panel-tools.mjs/);
});

test('rejects installed or contaminated program folders with unlisted files', async t => {
  const root = await candidateFixture(t);
  await writeFile(path.join(root, 'buildx-installation.json'), '{}');
  await assert.rejects(auditCoverage(root), /Payload must match manifest/);
});
