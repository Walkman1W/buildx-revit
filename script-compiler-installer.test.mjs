import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project=path.dirname(fileURLToPath(import.meta.url));
const compilerDirectory=process.env.BUILDX_SCRIPT_COMPILER_DIR;
const selected={skip:compilerDirectory?false:'Set BUILDX_SCRIPT_COMPILER_DIR to an independently provisioned real compiler payload; no compiler is executed by these tests.'};
const prefix='private-runtime/script-compiler/';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const compilerBlockers=new Set(['external_compiler_not_packaged','script_compiler_portable_layout_unverified']);
const buildCandidate=async options=>(await import('./tools/buildx-installer.mjs')).buildCandidate(options);
const planInstall=async options=>(await import('./tools/buildx-installer.mjs')).planInstall(options);

async function fixture(t){
  assert.ok(path.isAbsolute(compilerDirectory),'BUILDX_SCRIPT_COMPILER_DIR must be absolute');
  const {inspectScriptCompilerPackage}=await import('./lib/script-compiler-package.mjs');
  const observed=await inspectScriptCompilerPackage(compilerDirectory);
  assert.equal(observed.ok,true,'select an intact, pinned compiler package');
  const expected=structuredClone(observed.value.files);
  const temporary=await fs.realpath(os.tmpdir());
  const base=await fs.mkdtemp(path.join(temporary,'buildx-compiler-installer-'));
  const original=await fs.lstat(base,{bigint:true});
  t.after(async()=>{
    // This owner may remove only the exact temporary tree it created. The
    // independently provisioned compiler source is inspected and preserved.
    const target=path.resolve(base),current=await fs.lstat(target,{bigint:true});
    assert.equal(path.dirname(target),temporary);assert.match(path.basename(target),/^buildx-compiler-installer-/);
    assert.equal(current.isDirectory(),true);assert.equal(current.isSymbolicLink(),false);
    assert.deepEqual([current.dev,current.ino,current.birthtimeNs],[original.dev,original.ino,original.birthtimeNs]);
    assert.equal((await fs.realpath(target)).toLowerCase(),target.toLowerCase());
    const relative=path.relative(target,path.resolve(compilerDirectory));
    assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'source compiler must stay outside the owned temporary tree');
    const after=await inspectScriptCompilerPackage(compilerDirectory);assert.equal(after.ok,true);assert.deepEqual(after.value.files,expected);
    await fs.rm(target,{recursive:true,force:true});
  });
  const plugin=path.join(base,'plugin'),addins=path.join(base,'controlled-addins'),runtimes=path.join(base,'controlled-runtimes');
  for(const directory of [plugin,addins,runtimes])await fs.mkdir(directory);
  const pluginFiles=['LocalCodexRevit.dll','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','runtimes/win-x64/native/WebView2Loader.dll'];
  for(const file of pluginFiles){const destination=path.join(plugin,...file.split('/'));await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,'controlled placeholder; never loaded');}
  await fs.mkdir(path.join(plugin,'licenses','webview2'),{recursive:true});
  for(const file of ['LICENSE.txt','NOTICE.txt'])await fs.writeFile(path.join(plugin,'licenses','webview2',file),'controlled placeholder notice');
  for(const file of ['node.exe','python.exe','codex.exe'])await fs.writeFile(path.join(runtimes,file),'controlled placeholder; never executed');
  const options={sourceRoot:project,pluginDirectory:plugin};
  const planOptions=packageRoot=>({packageRoot,installRoot:path.join(base,'not-installed'),dataRoot:path.join(base,'not-created-data'),addinDirectory:addins,
    nodeExecutable:path.join(runtimes,'node.exe'),pythonExecutable:path.join(runtimes,'python.exe'),codexExecutable:path.join(runtimes,'codex.exe'),
    checkRevit:async()=>false,probeRuntimes:async()=>({node:'v22.17.0',python:'3.11.0',codex:'1.0.0',pypdfAvailable:true})});
  return {base,options,expected,inspect:inspectScriptCompilerPackage,planOptions};
}

test('a verified compiler payload, license and stamp enter the candidate with their exact owner hashes',selected,async t=>{
  const f=await fixture(t),output=path.join(f.base,'candidate');
  const result=await buildCandidate({...f.options,output,scriptCompilerDirectory:compilerDirectory});
  assert.equal(result.releaseReady,false);assert.equal(result.missing.some(item=>compilerBlockers.has(item.reason)),false);
  const manifest=JSON.parse(await fs.readFile(path.join(output,'buildx-package.json'),'utf8'));
  const included=manifest.files.filter(item=>item.path.startsWith(prefix));
  assert.equal(included.length,f.expected.length);
  for(const file of f.expected){
    const item=included.find(item=>item.path===prefix+file.path);assert.ok(item,file.path);assert.equal(item.sha256,file.sha256);
    const bytes=await fs.readFile(path.join(output,...item.path.split('/')));assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);
  }
  for(const file of ['csc.exe','csc.exe.config','License.txt','ThirdPartyNotices.rtf','compiler-package.json'])assert.ok(included.some(item=>item.path===prefix+file),file);
  const checked=await f.inspect(path.join(output,'private-runtime','script-compiler'));assert.equal(checked.ok,true);
  const plan=await planInstall(f.planOptions(output));assert.equal(plan.readyToApply,false);
  assert.equal(plan.blockers.some(item=>compilerBlockers.has(item.reason)),false);
  assert.ok(plan.blockers.some(item=>item.reason==='argus_runtime_distribution_rights_unverified'));
  assert.ok(plan.blockers.some(item=>item.reason==='private_node_python_runtime_distribution_unverified'));
  assert.ok(plan.blockers.some(item=>item.reason==='customer_data_root_and_upgrade_unverified'));
});

test('an omitted compiler remains a blocker even after the candidate clears its own missing report',selected,async t=>{
  const f=await fixture(t),output=path.join(f.base,'without-compiler');
  const built=await buildCandidate({...f.options,output});assert.ok(built.missing.some(item=>item.reason==='external_compiler_not_packaged'));
  const filename=path.join(output,'buildx-package.json'),manifest=JSON.parse(await fs.readFile(filename,'utf8'));
  manifest.missing=[];await fs.writeFile(filename,JSON.stringify(manifest));
  const plan=await planInstall(f.planOptions(output));assert.equal(plan.readyToApply,false);
  assert.ok(plan.blockers.some(item=>item.reason==='script_compiler_portable_layout_unverified'));
});

test('invalid real compiler copies are rejected before a candidate output is created',selected,async t=>{
  const f=await fixture(t);
  const cases=[
    ['modified compiler',async directory=>fs.appendFile(path.join(directory,'csc.exe'),'controlled mutation')],
    ['missing stamp',async directory=>fs.unlink(path.join(directory,'compiler-package.json'))],
    ['missing dependency',async directory=>fs.unlink(path.join(directory,'System.Memory.dll'))],
    ['self-authorized replacement',async directory=>{
      const compiler=path.join(directory,'csc.exe');await fs.appendFile(compiler,'controlled replacement');
      const filename=path.join(directory,'compiler-package.json'),stamp=JSON.parse(await fs.readFile(filename,'utf8'));
      const record=stamp.files.find(item=>item.path==='csc.exe');assert.ok(record,'real provision stamp must identify csc.exe');
      const bytes=await fs.readFile(compiler);record.sha256=sha(bytes);record.bytes=bytes.length;await fs.writeFile(filename,JSON.stringify(stamp));
    }],
  ];
  for(let i=0;i<cases.length;i++){
    const [name,change]=cases[i],copy=path.join(f.base,'invalid-compiler-'+i),output=path.join(f.base,'rejected-candidate-'+i);
    await fs.cp(compilerDirectory,copy,{recursive:true,errorOnExist:true,force:false});await change(copy);
    assert.equal((await f.inspect(copy)).ok,false,name);
    await assert.rejects(buildCandidate({...f.options,output,scriptCompilerDirectory:copy}),undefined,name);
    await assert.rejects(fs.stat(output),{code:'ENOENT'},name);
  }
  const racing=path.join(f.base,'compiler-changing-after-inspection'),racingOutput=path.join(f.base,'rejected-racing-candidate');
  await fs.cp(compilerDirectory,racing,{recursive:true,errorOnExist:true,force:false});
  const target=path.join(racing,'csc.exe'),originalRead=fs.readFile;let changed=false;
  // The package owner hashes through opened handles. This controlled mutation
  // occurs only when the installer subsequently reads the selected copy bytes.
  fs.readFile=async function(filename,...args){
    if(!changed&&typeof filename==='string'&&path.resolve(filename)===target){changed=true;await fs.appendFile(target,'controlled post-inspection mutation');}
    return originalRead.call(this,filename,...args);
  };
  try{await assert.rejects(buildCandidate({...f.options,output:racingOutput,scriptCompilerDirectory:racing}),{code:'SCRIPT_COMPILER_PACKAGE_INVALID'});}
  finally{fs.readFile=originalRead;}
  assert.equal(changed,true,'the copy-time mutation must actually run');await assert.rejects(fs.stat(racingOutput),{code:'ENOENT'});
});

test('candidate file lists cannot omit a verified compiler or substitute the hashes that installation would copy',selected,async t=>{
  const f=await fixture(t),output=path.join(f.base,'omitted-compiler-files');
  await buildCandidate({...f.options,output,scriptCompilerDirectory:compilerDirectory});
  const filename=path.join(output,'buildx-package.json'),manifest=JSON.parse(await fs.readFile(filename,'utf8'));
  const complete=structuredClone(manifest);
  manifest.files=manifest.files.filter(item=>!item.path.startsWith(prefix));manifest.missing=[];
  await fs.writeFile(filename,JSON.stringify(manifest));
  const plan=await planInstall(f.planOptions(output));assert.equal(plan.readyToApply,false);
  for(const file of f.expected)assert.ok(plan.blockers.some(item=>item.reason==='script_compiler_asset_not_in_package'&&item.file===prefix+file.path),file.path);

  // packageFiles first sees replacement bytes matching the replacement hash.
  // The process-check seam then restores the pinned payload before its owner
  // inspects it. Both independent reads pass, so their hashes must be bound.
  const compiler=path.join(output,'private-runtime','script-compiler','csc.exe');
  const original=await fs.readFile(compiler),replacement=Buffer.concat([original,Buffer.from('controlled manifest hash substitution')]);
  const originalHash=sha(original),replacementHash=sha(replacement);
  assert.notEqual(replacementHash,originalHash);
  const record=complete.files.find(item=>item.path===prefix+'csc.exe');assert.ok(record);
  record.sha256=replacementHash;complete.missing=[];
  await fs.writeFile(compiler,replacement);await fs.writeFile(filename,JSON.stringify(complete));
  let restored=false;
  const switched=await planInstall({...f.planOptions(output),checkRevit:async()=>{
    assert.equal(restored,false,'the controlled switch occurs exactly once after package hashing');
    await fs.writeFile(compiler,original);restored=true;return false;
  }});
  assert.equal(restored,true,'package hashing must complete before the pinned payload is restored');
  assert.equal((await f.inspect(path.dirname(compiler))).ok,true,'the independent compiler owner sees the intact payload');
  assert.equal(switched.files.find(item=>item.path===prefix+'csc.exe')?.sha256,replacementHash);
  assert.equal(switched.readyToApply,false);
  assert.ok(switched.blockers.some(item=>item.reason==='script_compiler_manifest_hash_mismatch'&&item.file===prefix+'csc.exe'));
  assert.equal(switched.blockers.some(item=>item.reason==='script_compiler_portable_layout_unverified'||item.reason==='script_compiler_asset_not_in_package'),false);
  await assert.rejects(fs.stat(path.join(f.base,'not-installed')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.base,'not-created-data')),{code:'ENOENT'});
});
