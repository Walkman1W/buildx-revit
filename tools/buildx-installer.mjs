import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {detectLocalRuntimes,inspectPythonExecutable} from '../lib/local-runtimes.mjs';
import {normalizeInstallationConfiguration} from '../lib/buildx-paths.mjs';
import {inspectScriptCompilerPackage} from '../lib/script-compiler-package.mjs';
import {isNativeReadonlyTest} from '../lib/native-readonly-test-scope.mjs';

// This is a development candidate, not a commercial release authority. Only
// runtime files named here can enter the package; no state or user environment
// is copied. Missing capabilities deliberately block installation.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ENTRY=['server.mjs','workbench-mcp.mjs','package.json','package-lock.json','THIRD-PARTY-NOTICES.md','buildx-installation.example.json'];
const SETUP=['tools/buildx-installer.mjs','tools/buildx-setup.ps1','tools/buildx-setup.cmd','tools/buildx-setup-readme.md'];
// Include the HTTP-served assets explicitly, including modules that are
// currently imported by another asset: the route itself remains public even
// if an import changes. This list is independently checked during planning.
const WEB=['index.html','style.css','register.html','register.css','app.js','chat-view.mjs','account.js','codex-account.js','model-picker.css','model-picker.mjs','model-workspace.css','model-workspace.mjs','command-form-source.mjs','personal-command-fields.mjs','command-fields.mjs','command-parameter-options.mjs','command-choice-field.mjs','parameter-change-field.mjs','account-license.mjs','project-knowledge-ui.mjs','project-files.css','model-viewer.mjs','model-viewer.css','model-viewer-ui.mjs'];
const MODULES=['native-model-queries.mjs','assistant-instructions.mjs','buildx-auth.mjs','buildx-runtime-config.mjs','cad-candidates.mjs','cad-document-path.mjs','cad-dxf-reader.mjs','cad-inventory.mjs','cad-read-report.mjs','cad-tools.mjs','chat-context.mjs','chat-read-receipts.mjs','chat-session.mjs','chat-store.mjs','codex-client-core.mjs','codex-client.mjs','codex-confirmation.mjs','codex-profile.mjs','command-sequence.mjs','command-store.mjs','family-template-preflight.mjs','family-tools.mjs','installation-identity.mjs','local-runtimes.mjs','model-command-catalog.mjs','model-tool-dispatch.mjs','model-viewer-service.mjs','modelling-tools.mjs','native-schematic-tools.mjs','panel-accounts.mjs','panel-audit.mjs','panel-chat-format.mjs','panel-profile.mjs','panel-server-core.mjs','panel-server.mjs','panel-tools.mjs','parse-project-document.mjs','project-agent-bridge.mjs','project-files.mjs','project-files-picker.mjs','project-files-store.mjs','project-history.mjs','project-knowledge.mjs','source-tools.mjs','turn-attachments.mjs','workbench-client.mjs','workbench-contracts.mjs','workbench-receipt.mjs'];
const NON_JS_ASSETS=['lib/project-knowledge-parser.py','lib/chat-lock-recovery.ps1','lib/project-files-lock-recovery.ps1','lib/access-lock-recovery.cs','manifests/script-compiler-5.0.0.json','prompts/buildx-assistant.zh-CN.md','.agents/skills/buildx-project-research/SKILL.md'];
const THIRD_PARTY_NOTICES=['licenses/webview2/LICENSE.txt','licenses/webview2/NOTICE.txt'];
const PLUGIN=['LocalCodexRevit.dll','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','runtimes/win-x64/native/WebView2Loader.dll'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeRelative=p=>typeof p==='string'&&p.length<500&&!p.includes('\\')&&!p.startsWith('/')&&!/[\x00-\x1f<>:"|?*]/.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..'||/[ .]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
const fail=(code,message)=>Object.assign(new Error(message),{code});
async function plainFile(file){const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('UNSAFE_SOURCE','源文件不是普通文件。');return info;}
async function absent(file){try{await fs.lstat(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
async function checkedDirectory(dir){
  if(!path.isAbsolute(dir)||path.parse(dir).root===path.resolve(dir))throw fail('INVALID_PATH','需要非根目录的绝对路径。');
  let current=path.parse(dir).root;
  for(const piece of path.resolve(dir).slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,piece);const info=await fs.lstat(current);
    if(!info.isDirectory()||info.isSymbolicLink())throw fail('UNSAFE_DIRECTORY','安装路径必须是已存在的普通目录，不能包含链接。');
  }
}
async function exe(file,name){if(!path.isAbsolute(file)||path.basename(file).toLowerCase()!==name)throw fail('RUNTIME_INVALID','请提供正确的运行程序绝对路径。');await checkedDirectory(path.dirname(file));await plainFile(file);if(name==='python.exe'&&!inspectPythonExecutable(file))throw fail('RUNTIME_INVALID','请选择已安装的 Python。');return path.resolve(file);}
function inside(parent,child){const rel=path.relative(parent,child);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
// Read-only facts for reviewers. This does not configure a data root, grant
// access, inspect its contents, or establish an upgrade/restore procedure.
export async function inspectDataLayout({installRoot,packageRoot,addinDirectory,dataRoot,projectHistoryRoot}={}){
  if (![installRoot,packageRoot,addinDirectory].every(p=>typeof p==='string'&&path.isAbsolute(p)) ||
      dataRoot!==undefined&&(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)) ||
      projectHistoryRoot!==undefined&&(typeof projectHistoryRoot!=='string'||!path.isAbsolute(projectHistoryRoot)))
    throw fail('DATA_LAYOUT_INVALID','数据位置检查需要绝对路径。');
  const program=path.resolve(installRoot),pkg=path.resolve(packageRoot),addin=path.resolve(addinDirectory);
  const state=dataRoot===undefined?program:path.resolve(dataRoot),location=dataRoot===undefined?'inside_install_root':'separate_data_root';
  const report={schemaVersion:dataRoot===undefined?1:2,programRoot:program,dataRoot:state,
    privateRuntime:{path:path.join(program,'private-runtime'),status:'not_bundled'},
    chatHistory:{path:path.join(state,'runtime-history'),location},
    workbench:{path:path.join(state,'workbench'),location},
    projectHistory:{status:'not_provided'},upgradeSupported:false,restoreVerified:false};
  if(projectHistoryRoot!==undefined){
    const data=path.resolve(projectHistoryRoot);
    await checkedDirectory(data);
    const overlaps=[program,pkg,addin].some(other=>path.relative(data,other)===''||inside(data,other)||inside(other,data));
    report.projectHistory={path:data,status:overlaps?'overlaps_install_or_package':'separate_location_unverified'};
  }
  return report;
}
async function packageFiles(root,manifest){
  if(!manifest||manifest.schemaVersion!==1||!['candidate','test_fixture','verified'].includes(manifest.stage)||!Array.isArray(manifest.files)||manifest.files.length>200)throw fail('PACKAGE_INVALID','组件清单无效。');
  const seen=new Set();for(const item of manifest.files){
    if(!safeRelative(item.path)||seen.has(item.path.toLowerCase())||/^(runtime|runtime-history|artifacts|planning)\//i.test(item.path)||/(^|\/)(\.env[^/]*|auth\.json|credentials[^/]*)$/i.test(item.path)||!/^[a-f0-9]{64}$/.test(item.sha256))throw fail('PACKAGE_INVALID','组件文件清单无效。');seen.add(item.path.toLowerCase());
    const file=path.join(root,...item.path.split('/'));await checkedDirectory(path.dirname(file));await plainFile(file);const data=await fs.readFile(file);if(sha(data)!==item.sha256)throw fail('PACKAGE_CHANGED','组件文件发生变化。');
  }
  for(const required of ['server.mjs','workbench-mcp.mjs','package.json',...PLUGIN.map(p=>'revit-addin/bin/'+p)])if(!seen.has(required.toLowerCase()))throw fail('PACKAGE_INCOMPLETE','组件缺少关键文件。');
  return seen;
}
async function importClosure(sourceRoot,initial){
  const queue=[...initial],seen=new Set(),missing=[],externalDependencies=new Set();
  while(queue.length){
    const rel=queue.shift();if(seen.has(rel))continue;seen.add(rel);
    try{
      const file=path.join(sourceRoot,...rel.split('/'));await checkedDirectory(path.dirname(file));const info=await plainFile(file);if(info.size>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');const text=await fs.readFile(file,'utf8');
      // Static ES imports and literal dynamic imports used by this application.
      const imports=[...text.matchAll(/(?:^|\n)[\t ]*(?:import\s+(?:[\w*$,{}\s]+?\s+from\s*)?|export\s+[\w*$,{}\s]+?\s+from\s*)(['"])([^'"]+)\1/g),...text.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)];
      for(const match of imports){
        if(match[2].startsWith('node:'))continue;
        if(!match[2].startsWith('.')){externalDependencies.add(match[2]);continue;}
        const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(rel),match[2]));if(!safeRelative(resolved)||!resolved.endsWith('.mjs'))throw fail('IMPORT_INVALID','模块导入越界或格式未知。');if(!seen.has(resolved))queue.push(resolved);
      }
      if(/\bimport\s*\(\s*[^'"\s]/.test(text)||/\brequire\s*\(|\bcreateRequire\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/.test(text))missing.push({file:rel,reason:'dynamic_module_loading_unverified'});
    }catch(error){missing.push({file:rel,reason:error.code==='ENOENT'?'missing_module':'unverified_module'});}
  }
  return {files:[...seen],missing,externalDependencies:[...externalDependencies].sort()};
}
// The complete 37-tool product has additional owners outside the JS import
// graph. These cannot be proven by a package's own missing/ready flags. Keep
// the checks here until each producer has a portable, distributable contract.
async function verifyCompleteToolDependencies(root,present,manifestFiles){
  const issues=[];
  if(!present.has('private-runtime/argus/2024/arguslearning.core.dll'))issues.push({file:'private-runtime/argus/2024/ArgusLearning.Core.dll',reason:'argus_runtime_missing'});
  const compiler=await inspectScriptCompilerPackage(path.join(root,'private-runtime','script-compiler'));
  if(!compiler.ok)issues.push({file:'private-runtime/script-compiler/csc.exe',reason:'script_compiler_portable_layout_unverified'});
  else for(const file of compiler.value.files){
    const filename='private-runtime/script-compiler/'+file.path;
    if(!present.has(filename.toLowerCase()))issues.push({file:filename,reason:'script_compiler_asset_not_in_package'});
    else if(manifestFiles.find(item=>item.path.toLowerCase()===filename.toLowerCase())?.sha256!==file.sha256)issues.push({file:filename,reason:'script_compiler_manifest_hash_mismatch'});
  }
  issues.push({reason:'argus_runtime_distribution_rights_unverified'},
    {reason:'plugin_distribution_rights_unverified'},
    {reason:'installer_bootstrap_requires_external_node'},
    {reason:'private_node_python_runtime_distribution_unverified'},
    {reason:'webview2_runtime_presence_unverified'},
    {reason:'customer_data_root_and_upgrade_unverified'},
    {reason:'license_backend_and_customer_configuration_unverified'});
  return issues;
}
async function pluginBuildEvidence(pluginDirectory,sourceRoot,checked,missing,testScope,revitVersion){
  const filename=path.join(pluginDirectory,'build-record.json');
  try{
    const info=await plainFile(filename);if(info.size<1||info.size>1024*1024)throw new Error();const bytes=await fs.readFile(filename);if(bytes.length>1024*1024)throw new Error();
    const record=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    const plugin=checked.find(item=>item.dst==='revit-addin/bin/LocalCodexRevit.dll');
    const requiredFlag=revitVersion==='2025'?'BUILDX_NATIVE_READONLY_TEST':'/define:BUILDX_NATIVE_READONLY_TEST';
    if(record.compiler_exit_code!==0||!plugin||record.output_sha256!==plugin.sha256||!Array.isArray(record.sources)||!record.sources.length||testScope==='native-readonly'&&!record.compiler_options?.includes(requiredFlag))throw new Error();
    const sources=[];
    for(const item of record.sources){
      const relative=path.relative(sourceRoot,item.path).split(path.sep).join('/');
      if(!safeRelative(relative)||!/^(?:revit-addin|family-core)\/.*\.(?:cs|csproj)$/.test(relative)||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error();
      await checkedDirectory(path.dirname(item.path));await plainFile(item.path);
      if(sha(await fs.readFile(item.path))!==item.sha256)throw new Error();
      sources.push({path:relative,sha256:item.sha256});
    }
    const sdk=record.webview2_sdk;
    if(sdk?.package_id!=='Microsoft.Web.WebView2'||sdk.version!=='1.0.2478.35'||sdk.package_sha256!=='b1df2d7fe955a3378603735f910b126647e43033213b5cc071b8d6f0168a3b96'||(revitVersion==='2024'?sdk.source!=='https://api.nuget.org/v3/index.json':sdk.source!=='pinned package SHA256')||sdk.payload_verified_against_package!==true)throw new Error();
    let revitEvidence;
    if(revitVersion==='2025'){
      if(!record.compiler_options.includes('net8.0-windows')||!record.compiler_options.includes('x64')||!Array.isArray(record.dependencies))throw new Error();
      const api=record.dependencies.find(x=>path.basename(x.path).toLowerCase()==='revitapi.dll'),ui=record.dependencies.find(x=>path.basename(x.path).toLowerCase()==='revitapiui.dll');
      if(!api||!ui||path.dirname(api.path).toLowerCase()!==path.dirname(ui.path).toLowerCase())throw new Error();
      for(const item of [api,ui]){await plainFile(item.path);if(sha(await fs.readFile(item.path))!==item.sha256)throw new Error();}
      const facts=await inspect2025ApiDirectory(path.dirname(api.path));
      if(!facts.ok||record.revit_api_file_version!==facts.apiFileVersion||record.revit_api_ui_file_version!==facts.uiFileVersion)throw new Error();
      revitEvidence={version:'2025',runtime:'net8.0-windows',apiFileVersion:facts.apiFileVersion,uiFileVersion:facts.uiFileVersion,apiSha256:api.sha256,uiSha256:ui.sha256,apiUiAutodeskSignatureVerified:true};
    }
    return {compilerExit:0,dllSha256:plugin.sha256,sources,
      ...(Array.isArray(record.compiler_options)?{compilerOptions:record.compiler_options.filter(value=>['/target:library','/platform:x64','/langversion:5','/optimize+','/debug-','/define:BUILDX_NATIVE_READONLY_TEST','BUILDX_NATIVE_READONLY_TEST','net8.0-windows','x64'].includes(value))}:{}),
      ...revitEvidence?{revitEvidence}:{},
      webView2Sdk:{id:sdk.package_id,version:sdk.version,packageSha256:sdk.package_sha256,source:sdk.source,payloadVerifiedAgainstPackage:true},
      realRevitLoadVerified:false,realModelExecutionVerified:false};
  }catch(error){missing.push({file:'revit-addin/build-evidence',reason:error.code==='ENOENT'?'plugin_build_provenance_missing':'plugin_build_provenance_unverified'});return null;}
}
export async function buildCandidate({output,pluginDirectory,sourceRoot=ROOT,productVersion='0.8.8-internal',scriptCompilerDirectory,testScope,revitVersion='2024'}={}){
  if(!['2024','2025'].includes(revitVersion)||revitVersion==='2025'&&testScope!=='native-readonly')throw fail('REVIT_TARGET_INVALID','无效的 Revit 构建目标。');
  if(testScope!==undefined&&testScope!=='native-readonly')throw fail('TEST_SCOPE_INVALID','未知的内部测试范围。');
  if(typeof productVersion!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(productVersion))throw fail('VERSION_INVALID','候选版本无效。');
  await checkedDirectory(path.dirname(output));await checkedDirectory(pluginDirectory);await checkedDirectory(sourceRoot);if(!path.isAbsolute(output)||!await absent(output))throw fail('OUTPUT_EXISTS','候选目录必须是新的绝对路径。');
  let compiler=null;
  if(scriptCompilerDirectory!==undefined){
    const checked=await inspectScriptCompilerPackage(scriptCompilerDirectory);
    if(!checked.ok)throw fail('SCRIPT_COMPILER_PACKAGE_INVALID','私有脚本编译器未通过固定来源与载荷核验，候选未生成。');
    compiler=checked.value;
  }
  const graph=await importClosure(sourceRoot,['server.mjs','workbench-mcp.mjs','tools/buildx-installer.mjs',...MODULES.map(p=>'lib/'+p),...WEB.filter(p=>/\.(mjs|js)$/.test(p)).map(p=>'public/'+p)]);
  const runtimeFiles=[...new Set([...ENTRY,...SETUP,...graph.files,...WEB.map(p=>'public/'+p),...NON_JS_ASSETS])];
  const specs=[...runtimeFiles.map(p=>[p,p]),['tools/buildx-package-entry.cmd','BuildX-Setup.cmd'],...PLUGIN.map(p=>[p,'revit-addin/bin/'+p]),...THIRD_PARTY_NOTICES.map(p=>[p,p]),...(compiler?compiler.files.map(file=>[file.path,'private-runtime/script-compiler/'+file.path,scriptCompilerDirectory]):[])];
  const checked=[],missing=[...graph.missing,...graph.externalDependencies.map(module=>({module,reason:'runtime_npm_dependency_not_bundled'}))];
  for(const [src,dst,selectedBase] of specs){
    const base=selectedBase??(dst.startsWith('revit-addin/')||dst.startsWith('licenses/webview2/')?pluginDirectory:sourceRoot);
    try{
      const f=path.join(base,...src.split('/'));await checkedDirectory(path.dirname(f));const info=await plainFile(f);
      if(info.size>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');
      const data=await fs.readFile(f);if(data.length>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');
      const digest=sha(data);
      if(selectedBase!==undefined){
        const expected=compiler.files.find(file=>file.path===src);
        if(!expected||data.length!==expected.bytes||digest!==expected.sha256)throw fail('SCRIPT_COMPILER_PACKAGE_INVALID','编译器在核验后发生变化。');
      }
      checked.push({src:f,dst,data,sha256:digest});
    }catch(e){
      if(selectedBase!==undefined)throw fail('SCRIPT_COMPILER_PACKAGE_INVALID','私有编译器在整理期间发生变化，候选未生成。');
      missing.push({file:dst,reason:e.code==='ENOENT'?'missing':'not_readable_or_invalid'});
    }
  }
  // Native query migration does not clear the remaining distribution/runtime
  // checks. The compiler has its own pinned payload owner, when selected.
  missing.push({file:'private-runtime/argus/2024/ArgusLearning.Core.dll',reason:'distribution_and_runtime_not_verified'},...compiler?[]:[{file:'private-runtime/script-compiler/csc.exe',reason:'external_compiler_not_packaged'}],{reason:'installer_bootstrap_requires_external_node'},{reason:'private_node_python_runtime_distribution_unverified'},{reason:'webview2_runtime_presence_unverified'});
  const buildEvidence=await pluginBuildEvidence(pluginDirectory,sourceRoot,checked,missing,testScope,revitVersion);
  if(revitVersion==='2025'&&!buildEvidence)throw fail('TEST_HOST_UNVERIFIED','2025 宿主构建或 API 证据不完整，未生成候选。');
  for(const item of checked){await checkedDirectory(path.dirname(item.src));await plainFile(item.src);if(sha(await fs.readFile(item.src))!==item.sha256)throw fail('SOURCE_CHANGED','源文件在候选整理期间变化，未确认本次候选。');}
  // The runtime graph currently uses Node built-ins only. The source lock and
  // tests stay in the source snapshot; do not publish scripts for absent tests,
  // source/customer entry points, or npm dependencies with no runtime consumer.
  const builtinOnly=graph.externalDependencies.length===0&&graph.missing.length===0;
  const packageMetadata={name:'buildx-revit',version:productVersion,private:true,type:'module',engines:{node:'>=22.17.0'},scripts:{start:'node server.mjs',check:'node --check server.mjs && node --check workbench-mcp.mjs && node --check public/app.js'},dependencies:{}};
  const packageLock={name:packageMetadata.name,version:productVersion,lockfileVersion:3,requires:true,packages:{'':{name:packageMetadata.name,version:productVersion,engines:packageMetadata.engines}}};
  const sourcePackageHashes={};
  for(const item of checked)if(['package.json','package-lock.json'].includes(item.dst)){
    sourcePackageHashes[item.dst]=item.sha256;
    if(builtinOnly){item.data=Buffer.from(JSON.stringify(item.dst==='package.json'?packageMetadata:packageLock,null,2)+'\n');item.sha256=sha(item.data);}
  }
  if(testScope){const data=Buffer.from(JSON.stringify({schemaVersion:1,scope:testScope},null,2)+'\n');checked.push({dst:'buildx-test-scope.json',data,sha256:sha(data)});}
  await fs.mkdir(output);for(const x of checked){const target=path.join(output,...x.dst.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,x.data,{flag:'wx'});}
  const manifest={schemaVersion:1,stage:'candidate',releaseReady:false,productVersion,target:{platform:'win32',architecture:'x64',revit:revitVersion},
    installationSchemaVersion:2,runtimePolicy:{node:{minimumVersion:'22.17.0',bundled:false},python:{minimumVersion:'3.11.0',bundled:false},codex:{bundled:false,upgrade:false},privateRuntimeDirectory:'private-runtime',webView2Runtime:{bundled:false,required:true,verified:false}},
    buildEvidence,...compiler?{scriptCompilerEvidence:{id:compiler.id,version:compiler.version,sourceUrl:compiler.sourceUrl,packageSha256:compiler.packageSha256,files:compiler.files.length,scope:'internal-candidate',realModelExecutionVerified:false}}:{},nodeModuleClosure:{builtinOnly,externalDependencies:graph.externalDependencies,sourcePackageHashes,testingDependenciesBundled:false},files:checked.map(x=>({path:x.dst,sha256:x.sha256})),missing};
  await fs.writeFile(path.join(output,'buildx-package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {ok:true,output,releaseReady:false,missing};
}
export async function planInstall({packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,dataRoot,projectHistoryRoot,allowTestFixture=false,installationScope,revitVersion='2024',checkRevit=windowsRevitCheck,probeRuntimes=probeRuntimeVersions,probeEnvironment=probeWindowsEnvironment,inspectRevit2025=inspect2025ApiDirectory}){
  if(installationScope!==undefined&&installationScope!=='cross-pc-test')throw fail('TEST_SCOPE_INVALID','未知的安装范围。');
  if(!['2024','2025'].includes(revitVersion)||revitVersion==='2025'&&installationScope!=='cross-pc-test')throw fail('REVIT_TARGET_INVALID','此安装范围不支持所选 Revit 版本。');
  await checkedDirectory(packageRoot);await checkedDirectory(path.dirname(installRoot));await checkedDirectory(addinDirectory);
  if(!path.isAbsolute(installRoot)||!await absent(installRoot))throw fail('INSTALL_EXISTS','安装目录已存在，不会覆盖。');
  const root=path.resolve(installRoot),pkg=path.resolve(packageRoot),addin=path.join(path.resolve(addinDirectory),'BuildX.addin');
  if(root===pkg||inside(root,pkg)||inside(pkg,root)||root===path.resolve(addinDirectory)||inside(root,path.resolve(addinDirectory))||inside(path.resolve(addinDirectory),root))throw fail('PATH_OVERLAP','组件、安装目录和插件目录不能重叠。');
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||path.resolve(dataRoot)!==dataRoot||path.parse(dataRoot).root===dataRoot)throw fail('DATA_ROOT_REQUIRED','请选择独立、规范的绝对数据目录。');
  const state=path.resolve(dataRoot);
  if([root,pkg,path.resolve(addinDirectory)].some(other=>state===other||inside(state,other)||inside(other,state)))throw fail('DATA_ROOT_OVERLAP','数据目录不能与程序、组件或 Revit Addins 目录重叠。');
  await checkedDirectory(path.dirname(dataRoot));
  if(!await absent(state))throw fail('DATA_ROOT_EXISTS','数据目录已存在；不会自动接管或迁移历史数据。');
  await assertNoBuildxManifest(path.dirname(addin),addin);
  const runtimes={nodeExecutable:await exe(nodeExecutable,'node.exe'),pythonExecutable:await exe(pythonExecutable,'python.exe'),codexExecutable:await exe(codexExecutable,'codex.exe')};
  if(process.platform==='win32')normalizeInstallationConfiguration({schemaVersion:2,installationId:'00000000-0000-4000-8000-000000000000',...runtimes,dataRoot:state},{programRoot:root});
  const runtimeVersions=await probeRuntimes(runtimes);
  const dataLayout=await inspectDataLayout({installRoot:root,packageRoot:pkg,addinDirectory:path.dirname(addin),dataRoot:state,projectHistoryRoot});
  const manifest=JSON.parse(await fs.readFile(path.join(pkg,'buildx-package.json'),'utf8'));const present=await packageFiles(pkg,manifest);
  if(manifest.stage==='candidate'&&manifest.target?.revit!==revitVersion)throw fail('REVIT_TARGET_MISMATCH','组件包与所选 Revit 版本不匹配。');
  if(await checkRevit())throw fail('REVIT_RUNNING','Revit 正在运行；不会切换插件入口。');
  const blockers=Array.isArray(manifest.missing)?[...manifest.missing]:[{reason:'missing_report_invalid'}];
  if(manifest.stage==='candidate'){
    const graph=await importClosure(pkg,['server.mjs','workbench-mcp.mjs','tools/buildx-installer.mjs',...MODULES.map(p=>'lib/'+p),...WEB.filter(p=>/\.(mjs|js)$/.test(p)).map(p=>'public/'+p)]);
    blockers.push(...graph.missing);
    blockers.push(...graph.externalDependencies.map(module=>({module,reason:'runtime_npm_dependency_not_bundled'})));
    for(const file of [...ENTRY,...graph.files,...SETUP,'BuildX-Setup.cmd',...WEB.map(p=>'public/'+p),...NON_JS_ASSETS,...THIRD_PARTY_NOTICES])if(!present.has(file.toLowerCase()))blockers.push({file,reason:'required_asset_not_in_package'});
    blockers.push(...await verifyCompleteToolDependencies(pkg,present,manifest.files));
    if(runtimeVersions.pypdfAvailable!==true)blockers.push({reason:'python_pypdf_unavailable_or_unverified'});
  }
  // Even an installable candidate remains explicitly experimental; self-
  // declared metadata never implies commercial or real-provider acceptance.
  const ready=manifest.stage==='candidate'&&manifest.releaseReady===false&&blockers.length===0;
  let internalReady=false,environment=null,internalBlockers=blockers;
  if(installationScope==='cross-pc-test'){
    const marker=manifest.files.find(item=>item.path==='buildx-test-scope.json');
    const validScope=marker&&await isNativeReadonlyTest(pkg).catch(()=>false);
    if(!validScope)throw fail('TEST_SCOPE_INVALID','内部测试范围标记缺失或无效。');
    const dll=manifest.files.find(item=>item.path==='revit-addin/bin/LocalCodexRevit.dll');
    const expectedFlag=revitVersion==='2025'?'BUILDX_NATIVE_READONLY_TEST':'/define:BUILDX_NATIVE_READONLY_TEST';
    if(!dll||manifest.buildEvidence?.dllSha256!==dll.sha256||!manifest.buildEvidence?.compilerOptions?.includes(expectedFlag))throw fail('TEST_HOST_UNVERIFIED','内部测试宿主编译证据缺失或与程序集不一致。');
    environment=await probeEnvironment();
    const accepted=new Set(['|installer_bootstrap_requires_external_node','|private_node_python_runtime_distribution_unverified','|webview2_runtime_presence_unverified','|argus_runtime_distribution_rights_unverified','|plugin_distribution_rights_unverified','|customer_data_root_and_upgrade_unverified','|license_backend_and_customer_configuration_unverified','private-runtime/argus/2024/ArgusLearning.Core.dll|distribution_and_runtime_not_verified','private-runtime/argus/2024/ArgusLearning.Core.dll|argus_runtime_missing','private-runtime/script-compiler/csc.exe|external_compiler_not_packaged','private-runtime/script-compiler/csc.exe|script_compiler_portable_layout_unverified']);
    internalBlockers=blockers.filter(item=>!accepted.has((item.file??'')+'|'+item.reason)||Object.keys(item).some(key=>key!=='file'&&key!=='reason'));
    if(revitVersion==='2024'&&(!environment?.ok||!environment.webView2||!environment.revit2024))internalBlockers.push({reason:'windows_environment_unverified'});
    if(revitVersion==='2025'){
      const target=environment?.revitTargets?.find(item=>item.version==='2025'&&item.detected),evidence=manifest.buildEvidence?.revitEvidence;
      const facts=target?.executable?await inspectRevit2025(path.dirname(target.executable)):null;
      if(!environment?.webView2||!facts?.ok||evidence?.version!=='2025'||evidence?.runtime!=='net8.0-windows'||evidence?.apiUiAutodeskSignatureVerified!==true||evidence?.apiFileVersion!==facts.apiFileVersion||evidence?.uiFileVersion!==facts.uiFileVersion||evidence?.apiSha256!==facts.apiSha256||evidence?.uiSha256!==facts.uiSha256)internalBlockers.push({reason:'revit2025_host_runtime_evidence_unverified'});
    }
    if(runtimeVersions.nodePlatform!=='win32'||runtimeVersions.nodeArchitecture!=='x64')internalBlockers.push({reason:'selected_node_not_windows_x64'});
    internalReady=manifest.stage==='candidate'&&manifest.releaseReady===false&&runtimeVersions.pypdfAvailable===true&&internalBlockers.length===0;
  }
  const testReady=allowTestFixture&&manifest.stage==='test_fixture'&&manifest.releaseReady===false&&Array.isArray(manifest.missing)&&manifest.missing.length===0;
  const permitted=installationScope==='cross-pc-test'?internalReady:ready||testReady;
  return {ok:true,readyToApply:permitted,experimental:true,installationScope:installationScope??null,revitVersion,environment,installRoot:root,dataRoot:state,addin,packageRoot:pkg,runtimes,runtimeVersions,dataLayout,files:manifest.files,blockers,internalBlockers,reason:permitted?null:'候选组件仍有未验证的运行依赖，不能安装。'};
}
async function probeRuntimeVersions(runtimes){
  const run=async(file)=>{try{const result=await promisify(execFile)(file,['--version'],{windowsHide:true,timeout:10000,maxBuffer:4096});return (result.stdout||result.stderr||'').trim();}catch{throw fail('RUNTIME_UNAVAILABLE','运行程序版本检查失败；请检查安装。');}};
  const [node,python,codex]=await Promise.all([run(runtimes.nodeExecutable),run(runtimes.pythonExecutable),run(runtimes.codexExecutable)]);
  const versions=validateRuntimeVersionOutputs({node,python,codex});
  let nodePlatform=null,nodeArchitecture=null;
  try{const result=await promisify(execFile)(runtimes.nodeExecutable,['-p','JSON.stringify({platform:process.platform,arch:process.arch})'],{windowsHide:true,timeout:10000,maxBuffer:4096});const info=JSON.parse(result.stdout.trim());nodePlatform=info.platform;nodeArchitecture=info.arch;}catch{/* Unknown platform or architecture cannot pass the internal check. */}
  // PDF parsing is an external dependency, not bundled or installed here.
  let pypdfAvailable=false;
  try{await promisify(execFile)(runtimes.pythonExecutable,['-c','from pypdf import PdfReader'],{windowsHide:true,timeout:10000,maxBuffer:4096});pypdfAvailable=true;}catch{/* Unknown and unavailable both block the candidate. */}
  return {...versions,pypdfAvailable,nodePlatform,nodeArchitecture};
}
// This read-only check is deliberately separate from the commercial release
// gate. Registry registration alone does not establish that the x64 payload is
// present, so inspect the PE machine type as well.
async function x64Executable(file){
  try{
    const handle=await fs.open(file,'r');
    try{
      const header=Buffer.alloc(64);if((await handle.read(header,0,64,0)).bytesRead!==64||header.readUInt16LE(0)!==0x5a4d)return false;
      const offset=header.readUInt32LE(60);if(offset<64||offset>16*1024*1024)return false;
      const pe=Buffer.alloc(6);return (await handle.read(pe,0,6,offset)).bytesRead===6&&pe.readUInt32LE(0)===0x4550&&pe.readUInt16LE(4)===0x8664;
    }finally{await handle.close();}
  }catch{return false;}
}
export async function inspect2025ApiDirectory(directory){
  if(process.platform!=='win32'||!path.isAbsolute(directory))return {ok:false};
  try{
    const encodedPath=Buffer.from(directory,'utf8').toString('base64');
    const script=`$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $a=Join-Path $d 'RevitAPI.dll'; $u=Join-Path $d 'RevitAPIUI.dll'; $av=(Get-Item -LiteralPath $a).VersionInfo; $uv=(Get-Item -LiteralPath $u).VersionInfo; $as=Get-AuthenticodeSignature -LiteralPath $a; $us=Get-AuthenticodeSignature -LiteralPath $u; @{apiFileVersion=$av.FileVersion;uiFileVersion=$uv.FileVersion;apiProductVersion=$av.ProductVersion;uiProductVersion=$uv.ProductVersion;apiSignatureValid=($as.Status -eq 'Valid' -and $as.SignerCertificate.Subject -match 'CN="?Autodesk, Inc\\."?');uiSignatureValid=($us.Status -eq 'Valid' -and $us.SignerCertificate.Subject -match 'CN="?Autodesk, Inc\\."?');apiSha256=(Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash.ToLowerInvariant();uiSha256=(Get-FileHash -LiteralPath $u -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress`;
    const encoded=Buffer.from(script,'utf16le').toString('base64');
    const env={...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:20000,maxBuffer:65536,env});
    const v=JSON.parse(stdout.trim());return {...v,ok:v.apiFileVersion==='25.0.2.419'&&v.uiFileVersion==='25.0.2.419'&&v.apiProductVersion==='20240307_1300(x64)'&&v.uiProductVersion==='20240307_1300(x64)'&&v.apiSignatureValid===true&&v.uiSignatureValid===true};
  }catch{return {ok:false};}
}
// Version discovery is read-only. A registered executable is not proof of a
// loadable BuildX plugin or a completed installation preflight.
export async function detectRevitTargets({platform=process.platform,appData=process.env.APPDATA,run=promisify(execFile),inspectExecutable=x64Executable}={}){
  const versions=['2024','2025'], candidates=new Map(versions.map(version=>[version,new Map()]));
  if(platform==='win32')try{
    const script=String.raw`$ErrorActionPreference='Stop'
$versions=@{'Autodesk Revit 2024'='2024';'Autodesk Revit 2025'='2025'}
$rows=@(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | ForEach-Object {
  if (-not $_.DisplayName -or -not $_.InstallLocation -or -not $versions.ContainsKey($_.DisplayName)) { return }
  $version=$versions[$_.DisplayName]
  $item=Get-Item -LiteralPath (Join-Path $_.InstallLocation 'Revit.exe') -ErrorAction SilentlyContinue
  if (-not $item -or $item.PSIsContainer) { return }
  $build=$item.VersionInfo
  if ($build.FileMajorPart -eq ([int]$version-2000)) {
    [pscustomobject]@{version=$version;executable=$item.FullName;fileVersion=('{0}.{1}.{2}.{3}' -f $build.FileMajorPart,$build.FileMinorPart,$build.FileBuildPart,$build.FilePrivatePart)}
  }
})
ConvertTo-Json -InputObject $rows -Compress`;
    const encoded=Buffer.from(script,'utf16le').toString('base64');
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:15000,maxBuffer:65536});
    const entries=JSON.parse(stdout.trim());
    if(Array.isArray(entries))for(const row of entries){
      const group=candidates.get(row?.version);
      if(!group||typeof row.executable!=='string'||!path.win32.isAbsolute(row.executable)||path.win32.basename(row.executable).toLowerCase()!=='revit.exe'||
        typeof row.fileVersion!=='string'||!/^\d{2}(\.\d+){3}$/.test(row.fileVersion)||Number(row.fileVersion.split('.')[0])!==Number(row.version)-2000||
        !await inspectExecutable(row.executable))continue;
      group.set(path.win32.normalize(row.executable).toLowerCase(),row);
    }
  }catch{/* Inaccessible, missing or malformed registration is unverified. */}
  return versions.map(version=>{
    const group=candidates.get(version),record=group.size===1?group.values().next().value:null,detected=record!==null;
    return {version,detected,executable:record?.executable??null,fileVersion:record?.fileVersion??null,
      addinDirectory:platform==='win32'&&typeof appData==='string'&&path.win32.isAbsolute(appData)?path.win32.join(appData,'Autodesk','Revit','Addins',version):null,
      supportedByPackage:version==='2024',installable:false,
      reason:group.size>1?'revit_ambiguous':!detected?'revit_unverified':version==='2025'?'plugin_build_unavailable':'installation_preflight_required'};
  });
}
export async function probeWindowsEnvironment(){
  if(process.platform!=='win32'||process.arch!=='x64')throw fail('WINDOWS_X64_REQUIRED','需要 Windows x64 和 x64 Node。');
  const run=promisify(execFile),versions=[];
  for(const root of ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}']){
    try{const {stdout}=await run('reg.exe',['query',root,'/v','pv'],{windowsHide:true,timeout:10000,maxBuffer:4096});const match=/\bpv\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/i.exec(stdout);if(match&&match[1]!=='0.0.0.0')versions.push(match[1]);}catch{/* Missing or inaccessible registration remains unverified. */}
  }
  let webView2=null;
  for(const base of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean))for(const version of versions){
    const file=path.join(base,'Microsoft','EdgeWebView','Application',version,'msedgewebview2.exe');
    if(await x64Executable(file)){webView2={version,architecture:'x64',executable:file};break;}
  }
  const revitTargets=await detectRevitTargets();
  const selected=revitTargets.find(item=>item.version==='2024');
  const revit2024=selected.detected?{executable:selected.executable,architecture:'x64',majorVersion:24}:null;
  return {ok:!!webView2&&!!revit2024,webView2,revit2024,revitTargets,limitations:['Requires Revit 2024 uninstall registration','Presence does not verify application launch or WebView loading']};
}
export function validateRuntimeVersionOutputs({node,python,codex}){
  const n=/^v(\d+)\.(\d+)\.(\d+)$/.exec(node),p=/^Python (\d+)\.(\d+)\.(\d+)(?:\s.*)?$/i.exec(python);
  const c=/^codex(?:-cli)?\s+(\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?)$/i.exec(codex);
  if(!n||Number(n[1])<22||Number(n[1])===22&&Number(n[2])<17||!p||Number(p[1])<3||(Number(p[1])===3&&Number(p[2])<11)||!c)throw fail('RUNTIME_VERSION','需要 Node 22.17 或更新版、Python 3.11 或更新版，以及可运行的 Codex。');
  return {node:'v'+n.slice(1).join('.'),python:p.slice(1,4).join('.'),codex:c[1]};
}
async function assertNoBuildxManifest(directory,target){
  if(!await absent(target))throw fail('MANIFEST_EXISTS','Revit 已有 BuildX 清单，不会覆盖。');
  for(const item of await fs.readdir(directory,{withFileTypes:true})){
    if(!item.name.toLowerCase().endsWith('.addin'))continue;
    if(!item.isFile()||item.isSymbolicLink())throw fail('MANIFEST_UNVERIFIED','插件清单无法核实。');
    const file=path.join(directory,item.name),info=await plainFile(file);if(info.size>262144)throw fail('MANIFEST_UNVERIFIED','插件清单过大，无法核实。');
    const bytes=await fs.readFile(file);let content;
    try{
      const le=bytes[0]===0xff&&bytes[1]===0xfe||bytes[0]===0x3c&&bytes[1]===0;
      const be=bytes[0]===0xfe&&bytes[1]===0xff||bytes[0]===0&&bytes[1]===0x3c;
      content=new TextDecoder(le?'utf-16le':be?'utf-16be':'utf-8',{fatal:true}).decode(bytes);
      if(content.includes('\0')||!/<\s*RevitAddIns(?:\s|>)/i.test(content))throw new Error();
    }catch{throw fail('MANIFEST_UNVERIFIED','插件清单编码或内容无法核实。');}
    if(content.toLowerCase().includes('62680901-6718-4cbc-a115-9383f35b782c'))throw fail('MANIFEST_EXISTS','检测到相同 BuildX 插件 ID，不会重复安装。');
  }
}
async function windowsRevitCheck(){
  if(process.platform!=='win32')throw fail('WINDOWS_REQUIRED','该安装器只支持 Windows。');
  const {stdout}=await promisify(execFile)('tasklist.exe',['/FO','CSV','/NH'],{windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
  const lines=stdout.split(/\r?\n/).filter(Boolean);if(!lines.length||lines.some(line=>!/^"(?:[^"]|"")*",/.test(line)))throw fail('PROCESS_CHECK_UNKNOWN','无法确认 Revit 进程状态。');
  return lines.some(line=>/^"Revit\.exe",/i.test(line));
}
function xml(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
const sameInstallIdentity=(first,second)=>first.dev===second.dev&&first.ino===second.ino&&first.birthtimeNs===second.birthtimeNs;
async function rememberInstallDirectory(directory,owners){
  const absolute=path.resolve(directory),volume=path.parse(absolute).root;
  let current=volume;
  for(const component of [null,...absolute.slice(volume.length).split(path.sep).filter(Boolean)]){
    if(component!==null)current=path.join(current,component);
    let observed;try{observed=await fs.lstat(current,{bigint:true});}catch{throw fail('INSTALL_DIRECTORY_CHANGED','安装目录或其上级目录已变化，未继续写入。');}
    const prior=owners.get(current);
    if(!observed.isDirectory()||observed.isSymbolicLink()||observed.ino===0n||prior&&!sameInstallIdentity(prior,observed))throw fail('INSTALL_DIRECTORY_CHANGED','安装目录或其上级目录已变化，未继续写入。');
    if(!prior)owners.set(current,{dev:observed.dev,ino:observed.ino,birthtimeNs:observed.birthtimeNs});
  }
}
async function verifyInstallDirectories(owners){
  for(const [directory,prior] of owners){
    let observed;try{observed=await fs.lstat(directory,{bigint:true});}catch{throw fail('INSTALL_DIRECTORY_CHANGED','安装目录或其上级目录已变化，未继续写入。');}
    if(!observed.isDirectory()||observed.isSymbolicLink()||!sameInstallIdentity(prior,observed))throw fail('INSTALL_DIRECTORY_CHANGED','安装目录或其上级目录已变化，未继续写入。');
  }
}
export async function applyInstall(options){
  const plan=await planInstall(options);if(!plan.readyToApply)throw fail('NOT_READY',plan.reason);
  // Capture plain directory identities, then recheck around every mutation.
  // These checks detect replacement; portable JS cannot remove every OS race.
  // A failure retains the generated trees and never deletes a replaced root.
  let published=false,temp=null,tempIdentity=null;
  const owners=new Map(),created=new Set();
  const verify=()=>verifyInstallDirectories(owners);
  const create=async directory=>{await verify();await fs.mkdir(directory);await rememberInstallDirectory(directory,owners);created.add(directory);await verify();};
  const createProgramDirectories=async directory=>{
    const relative=path.relative(plan.installRoot,directory);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fail('INSTALL_DIRECTORY_CHANGED','目标目录不属于本次安装。');
    let current=plan.installRoot;
    for(const component of relative.split(path.sep).filter(Boolean)){
      current=path.join(current,component);
      if(!created.has(current))await create(current);else await verify();
    }
  };
  const write=async(filename,bytes)=>{await verify();await fs.writeFile(filename,bytes,{flag:'wx'});await verify();};
  try{
    for(const directory of [path.dirname(plan.installRoot),path.dirname(plan.dataRoot),path.dirname(plan.addin)])await rememberInstallDirectory(directory,owners);
    await create(plan.installRoot);
    for(const item of plan.files){
      const src=path.join(plan.packageRoot,...item.path.split('/')),dest=path.join(plan.installRoot,...item.path.split('/'));
      await verify();await plainFile(src);const data=await fs.readFile(src);if(sha(data)!==item.sha256)throw fail('PACKAGE_CHANGED','组件在安装期间发生变化。');
      await verify();await createProgramDirectories(path.dirname(dest));await write(dest,data);
    }
    // This exact directory was selected for the new installation. Never adopt
    // a directory created by another process while the program was copied.
    await create(plan.dataRoot);
    const config={schemaVersion:2,installationId:randomUUID(),...plan.runtimes,dataRoot:plan.dataRoot,...plan.revitVersion==='2025'?{panelPort:41875}:{}};
    await write(path.join(plan.dataRoot,'buildx-data-owner.json'),JSON.stringify({schemaVersion:1,installationId:config.installationId},null,2)+'\n');
    await write(path.join(plan.installRoot,'buildx-installation.json'),JSON.stringify(config,null,2)+'\n');
    if(await (options.checkRevit??windowsRevitCheck)())throw fail('REVIT_RUNNING','Revit 在安装期间启动；未发布插件清单。');
    await verify();await assertNoBuildxManifest(path.dirname(plan.addin),plan.addin);await verify();
    const assembly=path.join(plan.installRoot,'revit-addin','bin','LocalCodexRevit.dll');
    const body='<?xml version="1.0" encoding="utf-8"?>\n<RevitAddIns><AddIn Type="Application"><Name>BuildX</Name><Assembly>'+xml(assembly)+'</Assembly><AddInId>62680901-6718-4cbc-a115-9383f35b782c</AddInId><FullClassName>RevitLocalCodex.App</FullClassName><VendorId>LCLX</VendorId><VendorDescription>BuildX</VendorDescription></AddIn></RevitAddIns>\n';
    temp=path.join(path.dirname(plan.addin),'.buildx-'+randomUUID()+'.tmp');await write(temp,body);
    tempIdentity=await fs.lstat(temp,{bigint:true});if(!tempIdentity.isFile()||tempIdentity.isSymbolicLink()||tempIdentity.ino===0n)throw fail('INSTALL_DIRECTORY_CHANGED','插件清单临时文件身份已变化。');
    await verify();await fs.link(temp,plan.addin);published=true;await verify();
    const named=await fs.lstat(temp,{bigint:true});if(!named.isFile()||named.isSymbolicLink()||!sameInstallIdentity(tempIdentity,named))throw fail('INSTALL_DIRECTORY_CHANGED','插件清单临时文件身份已变化。');
    await verify();await fs.unlink(temp);temp=null;
    return {ok:true,installRoot:plan.installRoot,dataRoot:plan.dataRoot,addin:plan.addin,installationId:config.installationId,releaseReady:!plan.experimental};
  }catch(error){error.retainedInstallRoot=plan.installRoot;error.retainedDataRoot=plan.dataRoot;error.manifestPublished=published;throw error;}
  finally{
    if(temp&&tempIdentity)try{
      await verify();const named=await fs.lstat(temp,{bigint:true});
      if(named.isFile()&&!named.isSymbolicLink()&&sameInstallIdentity(tempIdentity,named))await fs.unlink(temp);
    }catch{/* A replaced path or uncertain temporary is retained, never adopted. */}
  }
}

async function main(){
  const [action,...args]=process.argv.slice(2);let result;
  if(action==='--detect'&&args.length===0)result={...detectLocalRuntimes(),revitTargets:await detectRevitTargets()};
  else if(action==='--preflight-environment'&&args.length===0)result=await probeWindowsEnvironment();
  else if(action==='--build-candidate'&&[2,3,4].includes(args.length))result=await buildCandidate({output:args[0],pluginDirectory:args[1],...args[2]?{productVersion:args[2]}:{},...args[3]?{scriptCompilerDirectory:args[3]}:{}});
  else if(action==='--build-native-readonly-candidate'&&[2,3,4].includes(args.length))result=await buildCandidate({output:args[0],pluginDirectory:args[1],testScope:'native-readonly',...args[2]?{productVersion:args[2]}:{},...args[3]?{scriptCompilerDirectory:args[3]}:{}});
  else if(action==='--build-revit2025-readonly-candidate'&&[2,3].includes(args.length))result=await buildCandidate({output:args[0],pluginDirectory:args[1],testScope:'native-readonly',revitVersion:'2025',...args[2]?{productVersion:args[2]}:{}});
  else if(['--plan','--apply'].includes(action)&&args.length===7){const [packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,dataRoot]=args;const options={packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,dataRoot};result=action==='--plan'?await planInstall(options):await applyInstall(options);}
  else if(['--plan-internal-test','--apply-internal-test','--plan-revit2025-internal-test','--apply-revit2025-internal-test'].includes(action)&&args.length===7){
    const [packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,dataRoot]=args;
    const revitVersion=action.includes('revit2025')?'2025':'2024';
    if(process.platform!=='win32'||!process.env.APPDATA)throw fail('ADDINS_DIRECTORY_UNVERIFIED','无法确定当前用户的 Revit '+revitVersion+' Addins 目录。');
    const expected=path.resolve(process.env.APPDATA,'Autodesk','Revit','Addins',revitVersion);
    if(!path.isAbsolute(addinDirectory)||path.resolve(addinDirectory).toLowerCase()!==expected.toLowerCase())throw fail('ADDINS_DIRECTORY_INVALID','请选择当前用户的 Revit '+revitVersion+' Addins 目录：'+expected+'。');
    if(await absent(expected))throw fail('ADDINS_DIRECTORY_MISSING','当前用户的 Revit '+revitVersion+' Addins 目录尚不存在：'+expected+'。请先启动一次 Revit '+revitVersion+'，确认目录存在后重新检查。');
    const options={packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,dataRoot,installationScope:'cross-pc-test',revitVersion};result=action.startsWith('--plan-')?await planInstall(options):await applyInstall(options);
  }
  else throw fail('ARGUMENTS','用法：--detect；--build-candidate <新组件目录> <已构建插件目录> [版本] [已核验私有编译器目录]；--plan 或 --apply <组件> <新安装目录> <Revit Addins目录> <node.exe> <python.exe> <codex.exe> <新独立数据目录>。');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(JSON.stringify({ok:false,code:e.code??'INSTALL_ERROR',message:e.message,...e.retainedInstallRoot?{retainedInstallRoot:e.retainedInstallRoot,retainedDataRoot:e.retainedDataRoot,manifestPublished:e.manifestPublished}:{}})+'\n');process.exitCode=1;});
