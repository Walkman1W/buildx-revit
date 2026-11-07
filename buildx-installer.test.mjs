import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildCandidate,planInstall,applyInstall,inspectDataLayout,validateRuntimeVersionOutputs} from './tools/buildx-installer.mjs';
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
  const options={packageRoot:pkg,installRoot:path.join(base,'installed'),dataRoot:path.join(base,'data'),addinDirectory:addin,nodeExecutable:path.join(runtimes,'node.exe'),pythonExecutable:path.join(runtimes,'python.exe'),codexExecutable:path.join(runtimes,'codex.exe'),allowTestFixture:true,checkRevit:async()=>false,probeRuntimes:async()=>({node:'v22.17.0',python:'3.11.0',codex:'1.0.0'})};
  return {base,pkg,addin,manifest,options};
}
test('sandbox install plans before writing, copies only verified files and publishes one addin',async t=>{
  const f=await fixture(t);const plan=await planInstall(f.options);assert.equal(plan.readyToApply,true);await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
  assert.equal(plan.dataLayout.schemaVersion,2);assert.equal(plan.dataLayout.dataRoot,f.options.dataRoot);assert.equal(plan.dataLayout.chatHistory.path,path.join(f.options.dataRoot,'runtime-history'));assert.equal(plan.dataLayout.workbench.path,path.join(f.options.dataRoot,'workbench'));assert.equal(plan.dataLayout.chatHistory.location,'separate_data_root');assert.equal(plan.dataLayout.privateRuntime.status,'not_bundled');
  const result=await applyInstall(f.options);assert.equal(result.releaseReady,false);assert.match(result.installationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const config=JSON.parse(await fs.readFile(path.join(f.options.installRoot,'buildx-installation.json'),'utf8'));assert.equal(config.schemaVersion,2);assert.equal(config.dataRoot,f.options.dataRoot);assert.equal(config.installationId,result.installationId);assert.equal(config.nodeExecutable,f.options.nodeExecutable);assert.equal(config.pythonExecutable,f.options.pythonExecutable);assert.equal(config.codexExecutable,f.options.codexExecutable);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.options.dataRoot,'buildx-data-owner.json'),'utf8')).installationId,result.installationId);
  await assert.rejects(fs.stat(path.join(f.options.installRoot,'workbench')),{code:'ENOENT'});
  assert.match(await fs.readFile(result.addin,'utf8'),/LocalCodexRevit\.dll/);await assert.rejects(applyInstall(f.options),{code:'INSTALL_EXISTS'});
});
test('internal test requires a hashed native-readonly marker and cannot promote a test fixture',async t=>{
  const f=await fixture(t),options={...f.options,installationScope:'cross-pc-test',probeEnvironment:async()=>({ok:true,webView2:{},revit2024:{}}),probeRuntimes:async()=>({pypdfAvailable:true})};
  await assert.rejects(planInstall(options),{code:'TEST_SCOPE_INVALID'});
  const marker=Buffer.from('{"schemaVersion":1,"scope":"native-readonly"}\n');
  await fs.writeFile(path.join(f.pkg,'buildx-test-scope.json'),marker);
  f.manifest.files.push({path:'buildx-test-scope.json',sha256:hash(marker)});
  await fs.writeFile(path.join(f.pkg,'buildx-package.json'),JSON.stringify(f.manifest));
  await assert.rejects(planInstall(options),{code:'TEST_HOST_UNVERIFIED'});
  f.manifest.buildEvidence={dllSha256:f.manifest.files.find(x=>x.path==='revit-addin/bin/LocalCodexRevit.dll').sha256,compilerOptions:['/define:BUILDX_NATIVE_READONLY_TEST']};
  await fs.writeFile(path.join(f.pkg,'buildx-package.json'),JSON.stringify(f.manifest));
  assert.equal((await planInstall(options)).readyToApply,false);
  await fs.writeFile(path.join(f.pkg,'buildx-test-scope.json'),'{}');
  await assert.rejects(planInstall(options),{code:'PACKAGE_CHANGED'});
});
test('internal CLI refuses an Addins directory outside the current Revit user profile', {skip:process.platform!=='win32'},()=>{
  const result=spawnSync(process.execPath,[path.join(process.cwd(),'tools','buildx-installer.mjs'),'--plan-internal-test','C:\\package','C:\\program','C:\\wrong-addins','C:\\node.exe','C:\\python.exe','C:\\codex.exe','C:\\data'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.equal(JSON.parse(result.stderr).code,'ADDINS_DIRECTORY_INVALID');
});
test('data layout inspection is read-only and exposes overlap and unknowns',async t=>{
  const f=await fixture(t),data=path.join(f.base,'existing-project-history');await fs.mkdir(data);const marker=path.join(data,'preserve.txt');await fs.writeFile(marker,'original');
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

test('new data roots are explicit, separate, unowned and free of linked ancestors',async t=>{
  const f=await fixture(t);let probes=0;const options={...f.options,probeRuntimes:async()=>{probes++;return {};}};
  await assert.rejects(planInstall({...options,dataRoot:undefined}),{code:'DATA_ROOT_REQUIRED'});
  for(const dataRoot of [f.pkg,path.join(f.pkg,'child'),f.options.installRoot,path.join(f.options.installRoot,'child'),f.addin,f.base])await assert.rejects(planInstall({...options,dataRoot}),{code:'DATA_ROOT_OVERLAP'});
  const sentinel=path.join(f.base,'existing');await fs.mkdir(sentinel);await fs.writeFile(path.join(sentinel,'keep.txt'),'keep');
  await assert.rejects(planInstall({...options,dataRoot:sentinel}),{code:'DATA_ROOT_EXISTS'});
  const alias=path.join(f.base,'alias');await fs.symlink(sentinel,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(planInstall({...options,dataRoot:path.join(alias,'new-data')}),{code:'UNSAFE_DIRECTORY'});
  assert.equal(probes,0);assert.equal(await fs.readFile(path.join(sentinel,'keep.txt'),'utf8'),'keep');await assert.rejects(fs.stat(f.options.installRoot),{code:'ENOENT'});
});

test('runtime version admission matches the validated Node 22.17 floor and keeps Python/Codex requirements',()=>{
  const supported={node:'v22.17.0',python:'Python 3.11.0',codex:'codex-cli 1.0.0'};
  assert.deepEqual(validateRuntimeVersionOutputs(supported),{node:'v22.17.0',python:'3.11.0',codex:'1.0.0'});
  for(const change of [{node:'v22.16.9'},{node:'v20.19.0'},{python:'Python 3.10.11'},{codex:'wrapper.cmd'}])assert.throws(()=>validateRuntimeVersionOutputs({...supported,...change}),{code:'RUNTIME_VERSION'});
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

test('a data directory appearing after preflight is retained without adoption or addin publication',async t=>{
  const f=await fixture(t);f.options.probeRuntimes=async()=>{await fs.mkdir(f.options.dataRoot);await fs.writeFile(path.join(f.options.dataRoot,'keep.txt'),'another owner');return {};};
  await assert.rejects(applyInstall(f.options),error=>error.code==='EEXIST'&&error.manifestPublished===false&&error.retainedDataRoot===f.options.dataRoot);
  assert.equal(await fs.readFile(path.join(f.options.dataRoot,'keep.txt'),'utf8'),'another owner');
  await assert.rejects(fs.stat(path.join(f.options.dataRoot,'buildx-data-owner.json')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.addin,'BuildX.addin')),{code:'ENOENT'});
});

test('candidate records only bounded relative build provenance and rejects stale source evidence',async t=>{
  const f=await fixture(t),plugin=path.join(f.base,'plugin');await fs.mkdir(path.join(plugin,'runtimes','win-x64','native'),{recursive:true});
  for(const name of ['LocalCodexRevit.dll','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','runtimes/win-x64/native/WebView2Loader.dll'])await fs.writeFile(path.join(plugin,...name.split('/')),'fixture plugin');
  const source=path.join(process.cwd(),'revit-addin','NativeModelQueries.cs');
  const record={compiler_exit_code:0,output_sha256:hash('fixture plugin'),output:'PRIVATE_DEVELOPMENT_PATH',sources:[{path:source,sha256:hash(await fs.readFile(source))}],
    webview2_sdk:{package_id:'Microsoft.Web.WebView2',version:'1.0.2478.35',source:'https://api.nuget.org/v3/index.json',package_sha256:'b1df2d7fe955a3378603735f910b126647e43033213b5cc071b8d6f0168a3b96',payload_verified_against_package:true},privateEnvironment:'PRIVATE_ENVIRONMENT'};
  await fs.writeFile(path.join(plugin,'build-record.json'),JSON.stringify(record));
  const out=path.join(f.base,'provenance');await buildCandidate({output:out,pluginDirectory:plugin});
  const raw=await fs.readFile(path.join(out,'buildx-package.json'),'utf8'),manifest=JSON.parse(raw);
  assert.deepEqual(manifest.buildEvidence.sources,[{path:'revit-addin/NativeModelQueries.cs',sha256:record.sources[0].sha256}]);assert.equal(raw.includes('PRIVATE_'),false);assert.equal(raw.includes(process.cwd().replaceAll('\\','\\\\')),false);
  assert.equal(manifest.buildEvidence.realRevitLoadVerified,false);assert.equal(manifest.runtimePolicy.codex.bundled,false);assert.equal(manifest.releaseReady,false);
  record.sources[0].sha256='a'.repeat(64);await fs.writeFile(path.join(plugin,'build-record.json'),JSON.stringify(record));
  const stale=await buildCandidate({output:path.join(f.base,'stale-provenance'),pluginDirectory:plugin});assert.ok(stale.missing.some(item=>item.reason==='plugin_build_provenance_unverified'));
});
test('candidate build excludes runtime state and cannot authorize actual install',async t=>{
  const f=await fixture(t),plugin=path.join(f.base,'plugin');await fs.mkdir(path.join(plugin,'runtimes','win-x64','native'),{recursive:true});
  for(const name of ['LocalCodexRevit.dll','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','runtimes/win-x64/native/WebView2Loader.dll'])await fs.writeFile(path.join(plugin,...name.split('/')),'placeholder');
  await fs.mkdir(path.join(plugin,'licenses','webview2'),{recursive:true});for(const name of ['LICENSE.txt','NOTICE.txt'])await fs.writeFile(path.join(plugin,'licenses','webview2',name),'fixture notice');
  const out=path.join(f.base,'candidate'),built=await buildCandidate({output:out,pluginDirectory:plugin});assert.equal(built.releaseReady,false);assert.ok(!built.missing.some(x=>String(x.file??'').includes('aec-')||String(x.reason).startsWith('aec_')));assert.ok(built.missing.some(x=>x.reason==='external_compiler_not_packaged'));
  const packageManifest=JSON.parse(await fs.readFile(path.join(out,'buildx-package.json'),'utf8'));assert.ok(packageManifest.files.every(x=>sha.test(x.sha256)&&!x.path.startsWith('runtime/')&&!x.path.startsWith('runtime-history/')));
  const packaged=JSON.parse(await fs.readFile(path.join(out,'package.json'),'utf8')),lock=JSON.parse(await fs.readFile(path.join(out,'package-lock.json'),'utf8'));
  assert.deepEqual(Object.keys(packaged.scripts),['start','check']);assert.deepEqual(packaged.dependencies,{});assert.equal(lock.version,packaged.version);assert.deepEqual(Object.keys(lock.packages),['']);
  assert.equal(packageManifest.nodeModuleClosure.builtinOnly,true);assert.equal(packageManifest.nodeModuleClosure.testingDependenciesBundled,false);
  for(const asset of ['public/register.html','public/register.css'])assert.ok(packageManifest.files.some(item=>item.path===asset),asset);
  assert.match(await fs.readFile(path.join(out,'public','register.html'),'utf8'),/href="\/register\.css"/);
  assert.ok(packageManifest.files.some(x=>x.path==='lib/native-model-queries.mjs'));
  for(const old of ['lib/aec-model-adapter.mjs','lib/aec-read-relay.py','lib/aec-read-contracts.json','tools/refresh-aec-contracts.mjs'])assert.ok(!packageManifest.files.some(x=>x.path===old));
  for(const filename of ['package-lock.json','THIRD-PARTY-NOTICES.md','buildx-installation.example.json','BuildX-Setup.cmd','tools/buildx-setup.cmd','tools/buildx-setup.ps1','tools/buildx-installer.mjs','lib/project-knowledge-parser.py','lib/access-lock-recovery.mjs','lib/access-lock-recovery.cs','lib/project-knowledge.mjs','lib/project-history.mjs','lib/project-agent-bridge.mjs','lib/buildx-skills.mjs','.agents/skills/buildx-project-research/SKILL.md','lib/command-sequence.mjs','lib/model-viewer-service.mjs','public/project-knowledge-ui.mjs','public/model-viewer.mjs','public/model-viewer-ui.mjs','public/model-viewer.css','public/account-license.mjs','public/command-form-source.mjs','public/personal-command-fields.mjs','public/command-fields.mjs','public/command-choice-field.mjs','public/parameter-change-field.mjs','licenses/webview2/LICENSE.txt','licenses/webview2/NOTICE.txt'])assert.ok(packageManifest.files.some(item=>item.path===filename),`candidate includes ${filename}`);
  const plan=await planInstall({...f.options,packageRoot:out});assert.equal(plan.readyToApply,false);await assert.rejects(applyInstall({...f.options,packageRoot:out}),{code:'NOT_READY'});
  // Removing a package's self-declared missing list must never make the 37-tool
  // product eligible without its independently checked owners and assets.
  packageManifest.missing=[];await fs.writeFile(path.join(out,'buildx-package.json'),JSON.stringify(packageManifest));
  const tamperedPlan=await planInstall({...f.options,packageRoot:out});assert.equal(tamperedPlan.readyToApply,false);assert.ok(tamperedPlan.blockers.some(x=>x.reason==='script_compiler_portable_layout_unverified'));assert.ok(tamperedPlan.blockers.some(x=>x.reason==='argus_runtime_distribution_rights_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='python_pypdf_unavailable_or_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='customer_data_root_and_upgrade_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='license_backend_and_customer_configuration_unverified'));
  assert.ok(tamperedPlan.blockers.some(x=>x.reason==='plugin_distribution_rights_unverified'));
  assert.equal(tamperedPlan.blockers.some(x=>x.reason==='external_mcp_sdk_and_distribution_unverified'),false);
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

test('new runtime npm imports remain explicit blockers and cannot use the built-in-only projection',async t=>{
  const f=await fixture(t),source=path.join(f.base,'npm-source'),plugin=path.join(f.base,'npm-plugin');
  await fs.mkdir(source);await fs.mkdir(plugin);
  await fs.writeFile(path.join(source,'server.mjs'),"import 'fixture-runtime-module';\n");
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'fixture-runtime-module':'1.0.0'}}));
  await fs.writeFile(path.join(source,'package-lock.json'),'{}');
  const output=path.join(f.base,'npm-candidate'),built=await buildCandidate({sourceRoot:source,pluginDirectory:plugin,output});
  assert.ok(built.missing.some(item=>item.reason==='runtime_npm_dependency_not_bundled'&&item.module==='fixture-runtime-module'));
  const manifest=JSON.parse(await fs.readFile(path.join(output,'buildx-package.json'),'utf8'));
  assert.equal(manifest.nodeModuleClosure.builtinOnly,false);assert.equal(manifest.releaseReady,false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'package.json'),'utf8')).dependencies,{'fixture-runtime-module':'1.0.0'});
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
