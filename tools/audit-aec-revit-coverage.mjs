import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifestName = 'buildx-package.json';
const dllPath = 'revit-addin/bin/LocalCodexRevit.dll';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validPayloadPath = value => typeof value === 'string' && value.split('/').every(part =>
  /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');

async function listPayload(root, prefix = '') {
  const paths = [];
  for (const entry of await readdir(path.join(root, prefix), {withFileTypes: true})) {
    const relative = prefix + entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) paths.push(...await listPayload(root, relative + '/'));
    else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(relative);
    else throw new Error(`Unexpected payload entry ${relative}`);
  }
  return paths;
}

async function verifyCandidate(root) {
  const actual = await listPayload(root);
  assert(actual.includes(manifestName), 'BuildX component manifest is missing');
  const manifest = await readJson(path.join(root, manifestName));
  assert(manifest.stage === 'candidate' && manifest.releaseReady === false &&
    manifest.target?.platform === 'win32' && manifest.target.architecture === 'x64' &&
    manifest.target.revit === '2024', 'Expected a Windows x64 Revit 2024 internal candidate');
  const files = new Map();
  for (const file of manifest.files) {
    assert(validPayloadPath(file.path) && validSha(file.sha256) && file.path !== manifestName &&
      !files.has(file.path), 'Invalid or duplicate manifest entry');
    files.set(file.path, file.sha256);
  }
  assert.deepEqual(actual.sort(), [...files.keys(), manifestName].sort(), 'Payload must match manifest');
  for (const [relative, sha256] of files) {
    assert.equal(digest(await readFile(path.join(root, relative))), sha256, `Payload SHA-256 mismatch for ${relative}`);
  }
  const build = manifest.buildEvidence;
  assert(build?.compilerExit === 0 && build.dllSha256 === files.get(dllPath) && validSha(build.dllSha256) &&
    build.compilerOptions?.includes('/define:BUILDX_CONFIRMED_WRITE') && Array.isArray(build.sources) &&
    build.sources.length && build.sources.every(source => validPayloadPath(source.path) && validSha(source.sha256)),
    'Confirmed-write DLL compile record is missing or mismatched');
  return manifest;
}

export function readAecRows(inventory, crosswalk) {
  const names = new Set(inventory.tools.map(tool => tool.name));
  assert.equal(inventory.tools.length, 103, 'Expected the pinned 103-row AEC Revit inventory');
  assert.equal(names.size, inventory.tools.length, 'Duplicate AEC inventory name');
  const descriptions = new Map();
  for (const line of crosswalk.split(/\r?\n/)) {
    const match = /^\|\s*`(revit_[\w]+)`\s*\|[^|]*\|\s*([^|]+?)\s*\|$/.exec(line);
    if (!match) continue;
    assert(names.has(match[1]) && !descriptions.has(match[1]), `Unexpected or duplicate crosswalk name ${match[1]}`);
    descriptions.set(match[1], match[2]);
  }
  assert.equal(descriptions.size, names.size, 'Crosswalk must account for every pinned AEC tool');
  return inventory.tools.map(tool => {
    const comparison = descriptions.get(tool.name);
    const mentioned = Array.from(comparison.matchAll(/`(revit_[\w]+)`/g), match => match[1]);
    return {name: tool.name, group: tool.businessGroup, aecEffect: tool.migrationEffectAssessment,
      comparison, mappedNames: [...new Set([tool.name, ...mentioned])]};
  });
}

async function catalog(root) {
  const load = name => import(pathToFileURL(path.join(root, 'lib', name)).href);
  const [commands, tools, profile] = await Promise.all([
    load('model-command-catalog.mjs'), load('panel-tools.mjs'), load('confirmed-write-profile.mjs'),
  ]);
  return {
    names: new Set(commands.MODEL_COMMAND_CATALOG.map(command => command.tool)),
    mcpListed: new Set(tools.MODEL_AI_READ_TOOLS.map(tool => tool.name)),
    eligible: new Set(commands.MODEL_COMMAND_CATALOG.filter(command => command.enabled &&
      profile.supportsConfirmedWriteCommand(command)).map(command => command.tool)),
    guarded: profile.confirmedWriteProfile(root),
  };
}

export function projectCoverage(rows, source, candidate) {
  return rows.map(({mappedNames, ...row}) => ({...row,
    sourceContracts: mappedNames.filter(name => source.names.has(name)),
    candidateContracts: mappedNames.filter(name => candidate.names.has(name)),
    candidatePanelEligible: mappedNames.filter(name => candidate.eligible.has(name)),
    candidateMcpReadCatalog: mappedNames.filter(name => candidate.mcpListed.has(name)),
  }));
}

export async function auditCoverage(packageRoot, sourceRoot = ROOT) {
  const manifest = await verifyCandidate(packageRoot);
  const directory = path.join(sourceRoot, 'docs', 'migration');
  const [inventory, crosswalk, source, candidate] = await Promise.all([
    readJson(path.join(directory, 'aec-revit-command-inventory.json')),
    readFile(path.join(directory, 'AEC-103-CROSSWALK.zh-CN.md'), 'utf8'),
    catalog(sourceRoot), catalog(packageRoot),
  ]);
  assert(candidate.guarded, 'Candidate does not select the confirmed-write profile');
  const rows = projectCoverage(readAecRows(inventory, crosswalk), source, candidate);
  const summary = {
    aecRows: rows.length,
    sourceRowsWithNamedContract: rows.filter(row => row.sourceContracts.length).length,
    candidateRowsWithNamedContract: rows.filter(row => row.candidateContracts.length).length,
    candidateRowsWithPanelEligibleContract: rows.filter(row => row.candidatePanelEligible.length).length,
    candidateRowsWithDirectMcpReadCatalogMatch: rows.filter(row => row.candidateMcpReadCatalog.length).length,
    candidateRowsWithExactNamePanelEligible: rows.filter(row => row.candidatePanelEligible.includes(row.name)).length,
  };
  return {
    candidate: {version: manifest.productVersion, revit: manifest.target.revit, filesVerified: manifest.files.length,
      dllSha256: manifest.buildEvidence.dllSha256, compileInputCount: manifest.buildEvidence.sources.length},
    definition: 'Read-only comparison of a trusted BuildX component directory, compiled DLL manifest evidence and source catalogs. A row may match a related tool or preflight only. Panel eligibility and MCP listing do not establish host acceptance, granted permission, semantic parity or verified live execution.',
    summary, rows,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node tools/audit-aec-revit-coverage.mjs <trusted extracted candidate directory>');
    console.log(JSON.stringify(await auditCoverage(path.resolve(process.argv[2])), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
