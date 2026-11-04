import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {buildCandidate,planInstall,applyInstall,inspectDataLayout} from './tools/buildx-installer.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const sha=/^[a-f0-9]{64}$/;
async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-installer-test-'));
  t.after(async()=>{const parent=path.resolve(os.tmpdir()),target=path.resolve(base);assert.equal(path.dirname(target),parent);assert.match(path.basename(target),/^buildx-installer-test-/);await fs.rm(target,{recursive:true,force:true});});
  const pkg=path.join(base,'package'),addin=path.join(base,'Addins'),runtimes=path.join(base,'runtimes');await Promise.all([pkg,addin,runtimes].map(x=>fs.mkdir(x)));
  const filenames=['server.mjs','workbench-mcp.mjs','package.json','revit-addin/bin/LocalCodexRevit.dll','revit-addin/bin/Microsoft.Web.WebView2.Core.dll','revit-addin/bin/Microsoft.Web.WebView2.Wpf.dll','revit-addin/bin/runtimes/win-x64/native/WebView2Loader.dll'];
  const files=[];for(const f of filenames){const p=path.join(pkg,...f.split('/'));await fs.mkdir(path.dirname(p),{recursive:true});const data=Buffer.from('fixture '+f);await fs.writeFile(p,data);files.push({path:f,sha256:hash(data)});}
  const manifest={schemaVersion:1,stage:'test_fixture',releaseReady:false,files,missing:[]};await fs.writeFile(path.join(pkg,'buildx-package.json'),JSON.stringify(manifest));
  for(const name of ['node.exe','python.exe','codex.exe'])await fs.writeFile(path.join(runtimes,name),'fixture');
  const options={packageRoot:pkg,installRoot:path.join(base,'installed'),addinDirectory:addin,nodeExecutable:path.join(runtimes,'node.exe'),pythonExecutable:path.join(runtimes,'python.exe'),codexExecutable:path.join(runtimes,'codex.exe'),allowTestFixture:true,checkRevit:async()=>false,probeRuntimes:async()=>({node:'v24.0.0',python:'3.11.0',codex:'1.0.0'})};
  return {base,pkg,addin,manifest,options};
}
test('sandbox install plans before writing, copies only verified files and publishes one addin',async t=>{
  const f=await fixture(t);const plan=await planInstall(f.options);assert.equal(plan.readyToApply,true);await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
  assert.deepEqual(plan.dataLayout,{chatHistory:{path:path.join(f.options.installRoot,'runtime-history'),location:'inside_install_root'},workbench:{path:path.join(f.options.installRoot,'workbench'),location:'inside_install_root'},projectHistory:{status:'not_provided'},upgradeSupported:false,restoreVerified:false});
  const result=await applyInstall(f.options);assert.equal(result.releaseReady,false);assert.match(result.installationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const config=JSON.parse(await fs.readFile(path.join(f.options.installRoot,'buildx-installation.json'),'utf8'));assert.equal(config.installationId,result.installationId);assert.equal(config.nodeExecutable,f.options.nodeExecutable);assert.equal(config.pythonExecutable,f.options.pythonExecutable);assert.equal(config.codexExecutable,f.options.codexExecutable);
  assert.match(await fs.readFile(result.addin,'utf8'),/LocalCodexRevit\.dll/);await assert.rejects(applyInstall(f.options),{code:'INSTALL_EXISTS'});
});
test('data layout inspection is read-only and exposes overlap and unknowns',async t=>{
  const f=await fixture(t),data=path.join(f.base,'data');await fs.mkdir(data);const marker=path.join(data,'preserve.txt');await fs.writeFile(marker,'original');
  const args={installRoot:f.options.installRoot,packageRoot:f.pkg,addinDirectory:f.addin};
  const separate=await inspectDataLayout({...args,projectHistoryRoot:data});
  assert.deepEqual(separate.projectHistory,{path:data,status:'separate_location_unverified'});
  assert.equal(separate.upgradeSupported,false);assert.equal(separate.restoreVerified,false);
  for(const overlap of [f.base,f.pkg,f.addin])assert.equal((await inspectDataLayout({...args,projectHistoryRoot:overlap})).projectHistory.status,'overlaps_install_or_package');
  await assert.rejects(inspectDataLayout({...args,projectHistoryRoot:path.join(f.base,'missing')}),{code:'ENOENT'});
  await assert.rejects(inspectDataLayout({...args,projectHistoryRoot:'relative'}),{code:'DATA_LAYOUT_INVALID'});
  const plan=await planInstall({...f.options,projectHistoryRoot:data});assert.deepEqual(plan.dataLayout.projectHistory,separate.projectHistory);
  assert.equal(await fs.readFile(marker,'utf8'),'original');await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
});
test('existing addin and changed package are rejected without installation',async t=>{
  const f=await fixture(t);const existing=path.join(f.addin,'BuildX.addin');await fs.writeFile(existing,'keep');await assert.rejects(applyInstall(f.options),{code:'MANIFEST_EXISTS'});assert.equal(await fs.readFile(existing,'utf8'),'keep');await fs.unlink(existing);
  await fs.writeFile(path.join(f.pkg,'server.mjs'),'changed');await assert.rejects(applyInstall(f.options),{code:'PACKAGE_CHANGED'});await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
});
test('another addin filename with BuildX identity also blocks duplicate registration',async t=>{
  const f=await fixture(t);const content='<RevitAddIns><AddIn><AddInId>62680901-6718-4cbc-a115-9383f35b782c</AddInId></AddIn></RevitAddIns>';await fs.writeFile(path.join(f.addin,'LocalCodexRevit.addin'),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(content,'utf16le')]));await assert.rejects(applyInstall(f.options),{code:'MANIFEST_EXISTS'});await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
});
test('if Revit appears before publication retain owned files and publish no manifest',async t=>{
  const f=await fixture(t);let checks=0;f.options.checkRevit=async()=>++checks===2;
  await assert.rejects(applyInstall(f.options),e=>e.code==='REVIT_RUNNING'&&e.manifestPublished===false&&e.retainedInstallRoot===f.options.installRoot);
  assert.equal((await fs.stat(path.join(f.options.installRoot,'buildx-installation.json'))).isFile(),true);await assert.rejects(fs.stat(path.join(f.addin,'BuildX.addin')),{code:'ENOENT'});
});
test('candidate build excludes runtime state and cannot authorize actual install',async t=>{
  const f=await fixture(t),plugin=path.join(f.base,'plugin');await fs.mkdir(path.join(plugin,'runtimes','win-x64','native'),{recursive:true});
  for(const name of ['LocalCodexRevit.dll','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','runtimes/win-x64/native/WebView2Loader.dll'])await fs.writeFile(path.join(plugin,...name.split('/')),'placeholder');
  await fs.mkdir(path.join(plugin,'licenses','webview2'),{recursive:true});for(const name of ['LICENSE.txt','NOTICE.txt'])await fs.writeFile(path.join(plugin,'licenses','webview2',name),'fixture notice');
  const out=path.join(f.base,'candidate'),built=await buildCandidate({output:out,pluginDirectory:plugin});assert.equal(built.releaseReady,false);assert.ok(!built.missing.some(x=>String(x.file??'').includes('aec-')||String(x.reason).startsWith('aec_')));assert.ok(built.missing.some(x=>x.reason==='external_compiler_not_packaged'));
  const packageManifest=JSON.parse(await fs.readFile(path.join(out,'buildx-package.json'),'utf8'));assert.ok(packageManifest.files.every(x=>sha.test(x.sha256)&&!x.path.startsWith('runtime/')&&!x.path.startsWith('runtime-history/')));
  assert.ok(packageManifest.files.some(x=>x.path==='lib/native-model-queries.mjs'));
  for(const old of ['lib/aec-model-adapter.mjs','lib/aec-read-relay.py','lib/aec-read-contracts.json','tools/refresh-aec-contracts.mjs'])assert.ok(!packageManifest.files.some(x=>x.path===old));
  for(const filename of ['BuildX-Setup.cmd','tools/buildx-setup.cmd','tools/buildx-setup.ps1','tools/buildx-installer.mjs','lib/project-knowledge-parser.py','lib/access-lock-recovery.mjs','lib/access-lock-recovery.cs','lib/project-knowledge.mjs','lib/project-history.mjs','lib/project-agent-bridge.mjs','lib/buildx-skills.mjs','.agents/skills/buildx-project-research/SKILL.md','lib/command-sequence.mjs','lib/model-viewer-service.mjs','public/project-knowledge-ui.mjs','public/model-viewer.mjs','public/model-viewer-ui.mjs','public/model-viewer.css','public/account-license.mjs','public/command-form-source.mjs','public/personal-command-fields.mjs','public/command-fields.mjs','public/command-choice-field.mjs','public/parameter-change-field.mjs','licenses/webview2/LICENSE.txt','licenses/webview2/NOTICE.txt'])assert.ok(packageManifest.files.some(item=>item.path===filename),`candidate includes ${filename}`);
  const plan=await planInstall({...f.options,packageRoot:out});assert.equal(plan.readyToApply,false);await assert.rejects(applyInstall({...f.options,packageRoot:out}),{code:'NOT_READY'});
  // Removing a package's self-declared missing list must never make the 37-tool
  // product eligible without its independently checked owners and assets.
  packageManifest.missing=[];await fs.writeFile(path.join(out,'buildx-package.json'),JSON.stringify(packageManifest));
  const tamperedPlan=await planInstall({...f.options,packageRoot:out});assert.equal(tamperedPlan.readyToApply,false);assert.ok(tamperedPlan.blockers.some(x=>x.reason==='script_compiler_portable_layout_unverified'));assert.ok(tamperedPlan.blockers.some(x=>x.reason==='argus_runtime_distribution_rights_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='python_pypdf_unavailable_or_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='customer_data_root_and_upgrade_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='license_backend_and_customer_configuration_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='plugin_distribution_rights_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='external_mcp_sdk_and_distribution_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='installer_bootstrap_requires_external_node'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='private_node_python_runtime_distribution_unverified'));
  // A tampered list cannot turn an omitted non-JS parser or UI asset into a complete package.
  packageManifest.files=packageManifest.files.filter(x=>!['lib/project-knowledge-parser.py','lib/access-lock-recovery.cs','public/model-viewer.css','public/command-form-source.mjs','licenses/webview2/LICENSE.txt','.agents/skills/buildx-project-research/SKILL.md'].includes(x.path));
  await fs.writeFile(path.join(out,'buildx-package.json'),JSON.stringify(packageManifest));
  const omitted=await planInstall({...f.options,packageRoot:out,probeRuntimes:async()=>({pypdfAvailable:true})});
  for(const file of ['lib/project-knowledge-parser.py','lib/access-lock-recovery.cs','public/model-viewer.css','public/command-form-source.mjs','licenses/webview2/LICENSE.txt','.agents/skills/buildx-project-research/SKILL.md'])assert.ok(omitted.blockers.some(x=>x.file===file&&x.reason==='required_asset_not_in_package'));
  assert.ok(!omitted.blockers.some(x=>x.reason==='python_pypdf_unavailable_or_unverified'));
  assert.equal(omitted.readyToApply,false);
});

test('candidate refuses files reached through linked source directories',async t=>{
  const f=await fixture(t),source=path.join(f.base,'source'),outside=path.join(f.base,'outside'),plugin=path.join(f.base,'plugin');
  await Promise.all([source,outside,plugin].map(p=>fs.mkdir(p)));
  await fs.writeFile(path.join(outside,'index.html'),'private sentinel');
  await fs.symlink(outside,path.join(source,'public'),process.platform==='win32'?'junction':'dir');
  const output=path.join(f.base,'candidate-linked');
  const result=await buildCandidate({sourceRoot:source,pluginDirectory:plugin,output});
  assert.ok(result.missing.some(item=>item.file==='public/index.html'&&item.reason==='not_readable_or_invalid'));
  await assert.rejects(fs.stat(path.join(output,'public','index.html')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(outside,'index.html'),'utf8'),'private sentinel');
});
