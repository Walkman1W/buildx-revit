import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSnapshot,verifySnapshot,inspectSnapshotClosure,inspectLiteralModuleReferences} from '../../tools/build-brain-candidate.mjs';
import {buildCandidate} from '../../tools/buildx-installer.mjs';

const project=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'build-brain-closure-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('build-brain-closure-'));await fs.rm(root,{recursive:true,force:true});});return root;}

test('snapshot only contains explicit files and rejects changes and unexpected additions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'build-brain-candidate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const src=path.join(root,'src'),out=path.join(root,'out');await fs.mkdir(src);await fs.writeFile(path.join(src,'allowed.mjs'),'export const value=1;');await fs.writeFile(path.join(src,'secret.txt'),'excluded');
 const trusted={expectedFiles:['allowed.mjs'],expectedWhitelistSha256:'fixture'};
 const m=await buildSnapshot({sourceRoot:src,output:out,files:['allowed.mjs'],whitelistSha256:'fixture'});assert.equal(m.installable,false);assert.equal((await verifySnapshot(out,trusted)).files,1);await assert.rejects(fs.stat(path.join(out,'source','secret.txt')),{code:'ENOENT'});
 await assert.rejects(verifySnapshot(out,{expectedFiles:['different.mjs'],expectedWhitelistSha256:'fixture'}),/trusted whitelist/);
 await fs.writeFile(path.join(out,'source','extra.txt'),'unexpected');await assert.rejects(verifySnapshot(out,trusted),/inventory/);await fs.unlink(path.join(out,'source','extra.txt'));await fs.writeFile(path.join(out,'source','allowed.mjs'),'tampered');await assert.rejects(verifySnapshot(out,trusted),/mismatch/);
 await assert.rejects(buildSnapshot({sourceRoot:src,output:out,files:['allowed.mjs']}),{code:'EEXIST'});await assert.rejects(buildSnapshot({sourceRoot:src,output:path.join(root,'bad'),files:['../secret.txt']}),/invalid whitelist/);
});

test('literal dependency inspection ignores quoted examples while retaining real dynamic imports and resource URLs',()=>{
  const source=[
    "// import('./comment.mjs')",
    'const example = "import(\'./quoted.mjs\')";',
    "const regex = /import\\(['\"]/;",
    "const template = `text import('./template-text.mjs') ${import('./template-code.mjs')}`;",
    "await import('./dynamic.mjs');",
    "const resource = new URL('./parser.py', import.meta.url);",
    'await import(selectedModule);',
  ].join('\n');
  const result=inspectLiteralModuleReferences(source);
  assert.deepEqual(result.imports,['./template-code.mjs','./dynamic.mjs']);
  assert.deepEqual(result.resources,['./parser.py']);assert.equal(result.nonLiteralImports.length,1);
});

test('snapshot publication requires actual static, dynamic and non-JS resource closure before creating output',async t=>{
  const root=await temporary(t),source=path.join(root,'source'),output=path.join(root,'snapshot');await fs.mkdir(source);
  await fs.writeFile(path.join(source,'entry.mjs'),"import './static.mjs'; await import('./dynamic.mjs'); const parser = new URL('./parser.py', import.meta.url);");
  await fs.writeFile(path.join(source,'static.mjs'),'export const readOnly=true;');await fs.writeFile(path.join(source,'dynamic.mjs'),'export const loaded=true;');await fs.writeFile(path.join(source,'parser.py'),'# source asset only');
  const files=['entry.mjs','static.mjs','dynamic.mjs','parser.py'];
  for(const omitted of ['static.mjs','dynamic.mjs','parser.py']){
    await assert.rejects(buildSnapshot({sourceRoot:source,output,files:files.filter(file=>file!==omitted),whitelistSha256:'fixture'}),/dependency closure is incomplete/);
    await assert.rejects(fs.stat(output),{code:'ENOENT'});
  }
  const built=await buildSnapshot({sourceRoot:source,output,files,whitelistSha256:'fixture'});assert.equal(built.closure.ok,true);
  const checked=await verifySnapshot(output,{expectedFiles:files,expectedWhitelistSha256:'fixture'});assert.equal(checked.closure.missing.length,0);
});

test('default product source snapshot closes the actual routes, parser assets, package scripts and C# compile inventory',async()=>{
  const files=JSON.parse(await fs.readFile(path.join(project,'tools/build-brain-candidate-files.json'),'utf8'));
  const result=await inspectSnapshotClosure({sourceRoot:project,files});assert.equal(result.ok,true,JSON.stringify(result.missing));assert.ok(result.modules>100);assert.ok(result.references>300);
  assert.ok(files.every(file=>! /^(?:runtime|runtime-history|workbench|artifacts|node_modules|private-runtime)\//.test(file)&&! /\.(?:dll|exe|rvt|rfa)$/.test(file)));
  const withoutRegistration=await inspectSnapshotClosure({sourceRoot:project,files:files.filter(file=>!['public/register.html','public/register.css'].includes(file))});
  assert.ok(withoutRegistration.missing.some(item=>item.owner==='lib/panel-server-core.mjs'&&item.target==='public/register.html'&&item.kind==='served-route'));
  assert.ok(withoutRegistration.missing.some(item=>item.owner==='public/account.js'&&item.target==='public/register.html'&&item.kind==='public-link'));
  const withoutStyles=await inspectSnapshotClosure({sourceRoot:project,files:files.filter(file=>file!=='public/register.css')});
  assert.ok(withoutStyles.missing.some(item=>item.owner==='public/register.html'&&item.target==='public/register.css'&&item.kind==='markup-resource'));
  const withoutParser=await inspectSnapshotClosure({sourceRoot:project,files:files.filter(file=>file!=='lib/project-knowledge-parser.py')});
  assert.ok(withoutParser.missing.some(item=>item.owner==='lib/parse-project-document.mjs'&&item.target==='lib/project-knowledge-parser.py'&&item.kind==='url-resource'));
  const withoutCompiledSource=await inspectSnapshotClosure({sourceRoot:project,files:files.filter(file=>file!=='revit-addin/AccessPolicy.cs')});
  assert.ok(withoutCompiledSource.missing.some(item=>item.target==='revit-addin/AccessPolicy.cs'&&item.kind==='compiled-source'));
});

test('default source whitelist contains the resources actually emitted by the current product candidate builder',async t=>{
  const root=await temporary(t),plugin=path.join(root,'plugin'),output=path.join(root,'runtime-candidate');await fs.mkdir(plugin);
  await buildCandidate({sourceRoot:project,pluginDirectory:plugin,output});
  const manifest=JSON.parse(await fs.readFile(path.join(output,'buildx-package.json'),'utf8'));
  const files=new Set(JSON.parse(await fs.readFile(path.join(project,'tools/build-brain-candidate-files.json'),'utf8')));
  for(const item of manifest.files){
    if(/^revit-addin\/bin\/|^licenses\/webview2\//.test(item.path))continue;
    const source=item.path==='BuildX-Setup.cmd'?'tools/buildx-package-entry.cmd':item.path;
    assert.ok(files.has(source),'runtime resource is absent from the independent source snapshot: '+source);
  }
});
