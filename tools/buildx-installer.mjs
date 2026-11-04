import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {detectLocalRuntimes,inspectPythonExecutable} from '../lib/local-runtimes.mjs';

// This is a development candidate, not a commercial release authority. Only
// runtime files named here can enter the package; no state or user environment
// is copied. Missing capabilities deliberately block installation.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ENTRY=['server.mjs','workbench-mcp.mjs','package.json'];
const SETUP=['tools/buildx-installer.mjs','tools/buildx-setup.ps1','tools/buildx-setup.cmd','tools/buildx-setup-readme.md'];
// Include the HTTP-served assets explicitly, including modules that are
// currently imported by another asset: the route itself remains public even
// if an import changes. This list is independently checked during planning.
const WEB=['index.html','style.css','app.js','chat-view.mjs','account.js','codex-account.js','model-picker.css','model-picker.mjs','model-workspace.css','model-workspace.mjs','command-form-source.mjs','personal-command-fields.mjs','command-fields.mjs','command-parameter-options.mjs','command-choice-field.mjs','parameter-change-field.mjs','account-license.mjs','project-knowledge-ui.mjs','project-files.css','model-viewer.mjs','model-viewer.css','model-viewer-ui.mjs'];
const MODULES=['native-model-queries.mjs','assistant-instructions.mjs','buildx-auth.mjs','buildx-runtime-config.mjs','cad-candidates.mjs','cad-document-path.mjs','cad-dxf-reader.mjs','cad-inventory.mjs','cad-read-report.mjs','cad-tools.mjs','chat-context.mjs','chat-session.mjs','chat-store.mjs','codex-client-core.mjs','codex-client.mjs','codex-confirmation.mjs','codex-profile.mjs','command-sequence.mjs','command-store.mjs','family-template-preflight.mjs','family-tools.mjs','installation-identity.mjs','local-runtimes.mjs','model-command-catalog.mjs','model-tool-dispatch.mjs','model-viewer-service.mjs','modelling-tools.mjs','native-schematic-tools.mjs','panel-accounts.mjs','panel-audit.mjs','panel-chat-format.mjs','panel-profile.mjs','panel-server-core.mjs','panel-server.mjs','panel-tools.mjs','parse-project-document.mjs','project-agent-bridge.mjs','project-files.mjs','project-files-picker.mjs','project-files-store.mjs','project-history.mjs','project-knowledge.mjs','source-tools.mjs','turn-attachments.mjs','workbench-client.mjs','workbench-contracts.mjs','workbench-receipt.mjs'];
const NON_JS_ASSETS=['lib/project-knowledge-parser.py','lib/chat-lock-recovery.ps1','lib/project-files-lock-recovery.ps1','lib/access-lock-recovery.cs','prompts/buildx-assistant.zh-CN.md','.agents/skills/buildx-project-research/SKILL.md'];
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
export async function inspectDataLayout({installRoot,packageRoot,addinDirectory,projectHistoryRoot}={}){
  if (![installRoot,packageRoot,addinDirectory].every(p=>typeof p==='string'&&path.isAbsolute(p)) ||
      projectHistoryRoot!==undefined&&(typeof projectHistoryRoot!=='string'||!path.isAbsolute(projectHistoryRoot)))
    throw fail('DATA_LAYOUT_INVALID','数据位置检查需要绝对路径。');
  const program=path.resolve(installRoot),pkg=path.resolve(packageRoot),addin=path.resolve(addinDirectory);
  const report={chatHistory:{path:path.join(program,'runtime-history'),location:'inside_install_root'},
    workbench:{path:path.join(program,'workbench'),location:'inside_install_root'},
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
  const queue=[...initial],seen=new Set(),missing=[];
  while(queue.length){
    const rel=queue.shift();if(seen.has(rel))continue;seen.add(rel);
    try{
      const file=path.join(sourceRoot,...rel.split('/'));await checkedDirectory(path.dirname(file));const info=await plainFile(file);if(info.size>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');const text=await fs.readFile(file,'utf8');
      // Static ES imports and literal dynamic imports used by this application.
      const imports=/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;let match;
      while((match=imports.exec(text))){const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(rel),match[2]));if(!safeRelative(resolved)||!resolved.endsWith('.mjs'))throw fail('IMPORT_INVALID','模块导入越界或格式未知。');if(!seen.has(resolved))queue.push(resolved);}
    }catch(error){missing.push({file:rel,reason:error.code==='ENOENT'?'missing_module':'unverified_module'});}
  }
  return {files:[...seen],missing};
}
// The complete 37-tool product has additional owners outside the JS import
// graph. These cannot be proven by a package's own missing/ready flags. Keep
// the checks here until each producer has a portable, distributable contract.
async function verifyCompleteToolDependencies(root,present){
  const issues=[];
  if(!present.has('workbench/runtime/2024/arguslearning.core.dll'))issues.push({file:'workbench/runtime/2024/ArgusLearning.Core.dll',reason:'argus_runtime_missing'});
  issues.push({reason:'argus_runtime_distribution_rights_unverified'},
    {reason:'script_compiler_portable_layout_unverified'},
    {reason:'plugin_distribution_rights_unverified'},
    {reason:'external_mcp_sdk_and_distribution_unverified'},
    {reason:'installer_bootstrap_requires_external_node'},
    {reason:'private_node_python_runtime_distribution_unverified'},
    {reason:'customer_data_root_and_upgrade_unverified'},
    {reason:'license_backend_and_customer_configuration_unverified'});
  return issues;
}
export async function buildCandidate({output,pluginDirectory,sourceRoot=ROOT}){
  await checkedDirectory(path.dirname(output));await checkedDirectory(pluginDirectory);await checkedDirectory(sourceRoot);if(!path.isAbsolute(output)||!await absent(output))throw fail('OUTPUT_EXISTS','候选目录必须是新的绝对路径。');
  const graph=await importClosure(sourceRoot,['server.mjs','workbench-mcp.mjs','tools/buildx-installer.mjs',...MODULES.map(p=>'lib/'+p),...WEB.filter(p=>/\.(mjs|js)$/.test(p)).map(p=>'public/'+p)]);
  const runtimeFiles=[...new Set([...ENTRY,...SETUP,...graph.files,...WEB.map(p=>'public/'+p),...NON_JS_ASSETS])];
  const specs=[...runtimeFiles.map(p=>[p,p]),['tools/buildx-package-entry.cmd','BuildX-Setup.cmd'],...PLUGIN.map(p=>[p,'revit-addin/bin/'+p]),...THIRD_PARTY_NOTICES.map(p=>[p,p])];
  const checked=[],missing=[...graph.missing];
  for(const [src,dst] of specs){const base=dst.startsWith('revit-addin/')||dst.startsWith('licenses/webview2/')?pluginDirectory:sourceRoot;try{const f=path.join(base,...src.split('/'));await checkedDirectory(path.dirname(f));const info=await plainFile(f);if(info.size>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');const data=await fs.readFile(f);if(data.length>20*1024*1024)throw fail('SOURCE_LIMIT','单个文件超限。');checked.push({src:f,dst,data,sha256:sha(data)});}catch(e){missing.push({file:dst,reason:e.code==='ENOENT'?'missing':'not_readable_or_invalid'});}}
  // Reconstructed third-party components and the external compiler have not
  // been cleared for distribution; native query migration does not clear them.
  missing.push({file:'workbench/runtime/2024/ArgusLearning.Core.dll',reason:'distribution_and_runtime_not_verified'},{file:'revit-script-compiler',reason:'external_compiler_not_packaged'},{reason:'external_mcp_sdk_and_distribution_unverified'},{reason:'installer_bootstrap_requires_external_node'},{reason:'private_node_python_runtime_distribution_unverified'});
  await fs.mkdir(output);for(const x of checked){const target=path.join(output,...x.dst.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,x.data,{flag:'wx'});}
  const manifest={schemaVersion:1,stage:'candidate',releaseReady:false,files:checked.map(x=>({path:x.dst,sha256:x.sha256})),missing};
  await fs.writeFile(path.join(output,'buildx-package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {ok:true,output,releaseReady:false,missing};
}
export async function planInstall({packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable,projectHistoryRoot,allowTestFixture=false,checkRevit=windowsRevitCheck,probeRuntimes=probeRuntimeVersions}){
  await checkedDirectory(packageRoot);await checkedDirectory(path.dirname(installRoot));await checkedDirectory(addinDirectory);
  if(!path.isAbsolute(installRoot)||!await absent(installRoot))throw fail('INSTALL_EXISTS','安装目录已存在，不会覆盖。');
  const root=path.resolve(installRoot),pkg=path.resolve(packageRoot),addin=path.join(path.resolve(addinDirectory),'BuildX.addin');
  if(root===pkg||inside(root,pkg)||inside(pkg,root)||root===path.resolve(addinDirectory)||inside(root,path.resolve(addinDirectory))||inside(path.resolve(addinDirectory),root))throw fail('PATH_OVERLAP','组件、安装目录和插件目录不能重叠。');
  await assertNoBuildxManifest(path.dirname(addin),addin);
  const runtimes={nodeExecutable:await exe(nodeExecutable,'node.exe'),pythonExecutable:await exe(pythonExecutable,'python.exe'),codexExecutable:await exe(codexExecutable,'codex.exe')};
  const runtimeVersions=await probeRuntimes(runtimes);
  const dataLayout=await inspectDataLayout({installRoot:root,packageRoot:pkg,addinDirectory:path.dirname(addin),projectHistoryRoot});
  const manifest=JSON.parse(await fs.readFile(path.join(pkg,'buildx-package.json'),'utf8'));const present=await packageFiles(pkg,manifest);
  if(await checkRevit())throw fail('REVIT_RUNNING','Revit 正在运行；不会切换插件入口。');
  const blockers=Array.isArray(manifest.missing)?[...manifest.missing]:[{reason:'missing_report_invalid'}];
  if(manifest.stage==='candidate'){
    const graph=await importClosure(pkg,['server.mjs','workbench-mcp.mjs','tools/buildx-installer.mjs',...MODULES.map(p=>'lib/'+p),...WEB.filter(p=>/\.(mjs|js)$/.test(p)).map(p=>'public/'+p)]);
    blockers.push(...graph.missing);
    for(const file of [...graph.files,...SETUP,'BuildX-Setup.cmd',...WEB.map(p=>'public/'+p),...NON_JS_ASSETS,...THIRD_PARTY_NOTICES])if(!present.has(file.toLowerCase()))blockers.push({file,reason:'required_asset_not_in_package'});
    blockers.push(...await verifyCompleteToolDependencies(pkg,present));
    if(runtimeVersions.pypdfAvailable!==true)blockers.push({reason:'python_pypdf_unavailable_or_unverified'});
  }
  // Even an installable candidate remains explicitly experimental; self-
  // declared metadata never implies commercial or real-provider acceptance.
  const ready=manifest.stage==='candidate'&&manifest.releaseReady===false&&blockers.length===0;
  const testReady=allowTestFixture&&manifest.stage==='test_fixture'&&manifest.releaseReady===false&&Array.isArray(manifest.missing)&&manifest.missing.length===0;
  return {ok:true,readyToApply:ready||testReady,experimental:true,installRoot:root,addin,packageRoot:pkg,runtimes,runtimeVersions,dataLayout,files:manifest.files,blockers,reason:ready||testReady?null:'候选组件仍有未验证的运行依赖，不能安装。'};
}
async function probeRuntimeVersions(runtimes){
  const run=async(file)=>{try{const result=await promisify(execFile)(file,['--version'],{windowsHide:true,timeout:10000,maxBuffer:4096});return (result.stdout||result.stderr||'').trim();}catch{throw fail('RUNTIME_UNAVAILABLE','运行程序版本检查失败；请检查安装。');}};
  const [node,python,codex]=await Promise.all([run(runtimes.nodeExecutable),run(runtimes.pythonExecutable),run(runtimes.codexExecutable)]);
  const n=/^v(\d+)\.(\d+)\.(\d+)$/.exec(node),p=/^Python (\d+)\.(\d+)\.(\d+)(?:\s.*)?$/i.exec(python);
  const c=/^codex(?:-cli)?\s+(\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?)$/i.exec(codex);
  if(!n||Number(n[1])<24||!p||Number(p[1])<3||(Number(p[1])===3&&Number(p[2])<11)||!c)throw fail('RUNTIME_VERSION','需要 Node 24 或更新版、Python 3.11 或更新版，以及可运行的 Codex。');
  // PDF parsing is an external dependency, not bundled or installed here.
  let pypdfAvailable=false;
  try{await promisify(execFile)(runtimes.pythonExecutable,['-c','from pypdf import PdfReader'],{windowsHide:true,timeout:10000,maxBuffer:4096});pypdfAvailable=true;}catch{/* Unknown and unavailable both block the candidate. */}
  return {node:'v'+n.slice(1).join('.'),python:p.slice(1,4).join('.'),codex:c[1],pypdfAvailable};
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
export async function applyInstall(options){
  const plan=await planInstall(options);if(!plan.readyToApply)throw fail('NOT_READY',plan.reason);
  // Recheck immediately before publication. A failure retains only our new
  // installation directory; it never removes an existing tree or user data.
  await fs.mkdir(plan.installRoot);let published=false,temp=null;
  try{
    for(const item of plan.files){const src=path.join(plan.packageRoot,...item.path.split('/')),dest=path.join(plan.installRoot,...item.path.split('/'));await plainFile(src);const data=await fs.readFile(src);if(sha(data)!==item.sha256)throw fail('PACKAGE_CHANGED','组件在安装期间发生变化。');await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,data,{flag:'wx'});}
    await fs.mkdir(path.join(plan.installRoot,'workbench'));
    const config={schemaVersion:1,installationId:randomUUID(),...plan.runtimes};
    await fs.writeFile(path.join(plan.installRoot,'buildx-installation.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
    if(await (options.checkRevit??windowsRevitCheck)())throw fail('REVIT_RUNNING','Revit 在安装期间启动；未发布插件清单。');
    await assertNoBuildxManifest(path.dirname(plan.addin),plan.addin);
    const assembly=path.join(plan.installRoot,'revit-addin','bin','LocalCodexRevit.dll');
    const body='<?xml version="1.0" encoding="utf-8"?>\n<RevitAddIns><AddIn Type="Application"><Name>BuildX</Name><Assembly>'+xml(assembly)+'</Assembly><AddInId>62680901-6718-4cbc-a115-9383f35b782c</AddInId><FullClassName>RevitLocalCodex.App</FullClassName><VendorId>LCLX</VendorId><VendorDescription>BuildX</VendorDescription></AddIn></RevitAddIns>\n';
    temp=path.join(path.dirname(plan.addin),'.buildx-'+randomUUID()+'.tmp');await fs.writeFile(temp,body,{flag:'wx'});await fs.link(temp,plan.addin);published=true;await fs.unlink(temp);temp=null;
    return {ok:true,installRoot:plan.installRoot,addin:plan.addin,installationId:config.installationId,releaseReady:!plan.experimental};
  }catch(error){error.retainedInstallRoot=plan.installRoot;error.manifestPublished=published;throw error;}
  finally{if(temp)await fs.unlink(temp).catch(()=>{});}
}

async function main(){
  const [action,...args]=process.argv.slice(2);let result;
  if(action==='--detect'&&args.length===0)result=detectLocalRuntimes();
  else if(action==='--build-candidate'&&args.length===2)result=await buildCandidate({output:args[0],pluginDirectory:args[1]});
  else if(['--plan','--apply'].includes(action)&&args.length===6){const [packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable]=args;const options={packageRoot,installRoot,addinDirectory,nodeExecutable,pythonExecutable,codexExecutable};result=action==='--plan'?await planInstall(options):await applyInstall(options);}
  else throw fail('ARGUMENTS','用法：--detect；--build-candidate <新组件目录> <已构建插件目录>；--plan 或 --apply <组件> <新安装目录> <Revit Addins目录> <node.exe> <python.exe> <codex.exe>。');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(JSON.stringify({ok:false,code:e.code??'INSTALL_ERROR',message:e.message,...e.retainedInstallRoot?{retainedInstallRoot:e.retainedInstallRoot,manifestPublished:e.manifestPublished}:{}})+'\n');process.exitCode=1;});
