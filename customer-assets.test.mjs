import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {planCustomerAssets,buildCustomerAssets,verifyCustomerAssets,cleanupCustomerAssetReads} from './lib/customer-assets.mjs';

const metricsStarted=performance.now(),metricsCpu=process.cpuUsage();
test.after(()=>{const cpu=process.cpuUsage(metricsCpu),usage=process.resourceUsage();
  console.log('CUSTOMER_ASSETS_TEST_METRICS '+JSON.stringify({scope:'test-file-process-only; includes all temporary fixtures and cleanup',
    wallMs:performance.now()-metricsStarted,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,
    lifetimePeakRssKiB:usage.maxRSS,processFamilyPeakRss:null,tokens:null,coldWarmCacheControlled:false}));});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=value=>Buffer.from(value,'utf8');
const definitions=[
  ['public/index.html','entry','<!doctype html><title>BuildX测试</title><script src="/app.js"></script>', ['public/app.js','public/style.css']],
  ['public/app.js','script','import "./chat-view.mjs"; import "./account.js";\n', ['public/chat-view.mjs','public/account.js']],
  ['public/account.js','script','export const account="fixture";\n', []],
  ['public/chat-view.mjs','module','export const view="fixture";\n', []],
  ['public/style.css','style','body { color: #123; }\n', []],
  ['public/codex-account.js','script','export const codex="fixture";\n', []],
];
function reject(result){assert.equal(result.ok,false);assert.equal(typeof result.error?.code,'string');assert.ok(result.error.code.length>0);assert.equal(typeof result.error.message,'string');}
async function exists(name){try{await fs.lstat(name);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function fixture(t){
  const temp=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'buildx-assets-test-'));
  t.after(async()=>{
    const target=path.resolve(root);
    assert.equal(path.dirname(target),temp);assert.ok(path.basename(target).startsWith('buildx-assets-test-'));
    await fs.rm(target,{recursive:true,force:true});
  });
  await fs.mkdir(path.join(root,'release'));await fs.mkdir(path.join(root,'public'));
  const manifest={schemaVersion:1,component:'buildx-customer-web-assets',releaseReady:false,entries:[]};
  for(const [name,role,body,dependencies] of definitions){const content=bytes(body);await fs.writeFile(path.join(root,name),content);
    manifest.entries.push({path:name,sha256:sha(content),byteLength:content.length,role,dependencies:[...dependencies],provenance:'BuildX application source'});}
  const manifestPath=path.join(root,'release','customer-web-assets.json');
  const save=()=>fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');await save();
  const output=id=>path.join(root,'artifacts','customer-web-assets',id);
  const setSource=async(name,content)=>{const value=typeof content==='string'?bytes(content):content;await fs.writeFile(path.join(root,name),value);
    const entry=manifest.entries.find(item=>item.path===name);Object.assign(entry,{sha256:sha(value),byteLength:value.length});};
  return {root,manifest,manifestPath,save,output,setSource};
}
async function tree(root){
  const result={};
  async function visit(relative){for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const name=relative?relative+'/'+entry.name:entry.name;
    if(entry.isDirectory())await visit(name);else result[name]=await fs.readFile(path.join(root,name));
  }}
  await visit('');return result;
}
async function linked(t,target,link,type){
  try{await fs.symlink(target,link,type);return true;}catch(error){
    if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Host cannot create requested symlink: '+error.code);return false;}throw error;
  }
}

test('plan uses the hash-bound manifest and remains a frontend-only non-release component',async t=>{
  const f=await fixture(t),result=await planCustomerAssets({root:f.root});assert.equal(result.ok,true);
  assert.equal(result.value.component,f.manifest.component);assert.equal(result.value.releaseReady,false);
  assert.equal(result.value.inputManifestSha256,sha(await fs.readFile(f.manifestPath)));
  assert.equal(result.value.entries.length,6);assert.equal(result.value.totalBytes,f.manifest.entries.reduce((n,e)=>n+e.byteLength,0));
  assert.equal(await exists(path.join(f.root,'artifacts')),false);
});

test('build and independent verify preserve exactly six declared files plus deterministic build metadata',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'backend.mjs'),'fixture backend that must not be packaged');
  await fs.writeFile(path.join(f.root,'public','not-declared.js'),'fixture unlisted file');
  const first=await buildCustomerAssets({root:f.root,output:f.output('one')}),second=await buildCustomerAssets({root:f.root,output:f.output('two')});
  assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(first.value.verified,true);assert.equal(first.value.releaseReady,false);
  const firstTree=await tree(f.output('one')),secondTree=await tree(f.output('two'));
  assert.deepEqual(Object.keys(firstTree).sort(),['BUILD-MANIFEST.json',...f.manifest.entries.map(e=>e.path)].sort());
  assert.deepEqual(firstTree,secondTree);
  for(const entry of f.manifest.entries)assert.deepEqual(firstTree[entry.path],await fs.readFile(path.join(f.root,entry.path)));
  const checked=await verifyCustomerAssets({root:f.root,output:f.output('one')});assert.equal(checked.ok,true);assert.equal(checked.value.fileCount,7);assert.equal(checked.value.verified,true);
});

test('changed source bytes refuse construction before creating the output directory',async t=>{
  const f=await fixture(t);await fs.appendFile(path.join(f.root,'public','app.js'),'\nchanged');
  reject(await buildCustomerAssets({root:f.root,output:f.output('changed')}));assert.equal(await exists(f.output('changed')),false);
});

test('changed source size with an otherwise valid digest is rejected against declared byteLength',async t=>{
  const f=await fixture(t);f.manifest.entries[0].byteLength++;await f.save();
  reject(await planCustomerAssets({root:f.root}));
});

test('existing output is never overwritten or deleted',async t=>{
  const f=await fixture(t),output=f.output('existing');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'keep.txt'),'keep exact fixture');
  const before=await tree(output);reject(await buildCustomerAssets({root:f.root,output}));assert.deepEqual(await tree(output),before);
});

test('verify rejects a renamed research DLL even when its new name looks like a script',async t=>{
  const f=await fixture(t),output=f.output('extra-dll');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  await fs.writeFile(path.join(output,'public','innocent.js'),Buffer.from('MZ fixture research DLL payload'));
  reject(await verifyCustomerAssets({root:f.root,output}));
});

test('exact artifact tree rejects extra root files and nested directories',async t=>{
  for(const [id,extra,directory] of [['extra-root','backend.dll',false],['extra-directory','public/nested',true]]){
    const f=await fixture(t),output=f.output(id);assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
    if(directory)await fs.mkdir(path.join(output,extra));else await fs.writeFile(path.join(output,extra),'fixture');
    reject(await verifyCustomerAssets({root:f.root,output}));
  }
});

test('missing or altered artifact files fail independent verification',async t=>{
  for(const mutation of ['missing','changed']){
    const f=await fixture(t),output=f.output(mutation);assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
    const file=path.join(output,'public','app.js');
    if(mutation==='missing')await fs.unlink(file);else await fs.appendFile(file,'\nmutated');
    reject(await verifyCustomerAssets({root:f.root,output}));
  }
});

test('output metadata is not an alternate authority for changed payloads',async t=>{
  const f=await fixture(t),output=f.output('forged-metadata');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  const replacement=bytes('fixture forged script');await fs.writeFile(path.join(output,'public','app.js'),replacement);
  const forged={...f.manifest,entries:f.manifest.entries.map(entry=>entry.path==='public/app.js'?{...entry,sha256:sha(replacement),byteLength:replacement.length}:entry)};
  await fs.writeFile(path.join(output,'BUILD-MANIFEST.json'),JSON.stringify(forged,null,2)+'\n');
  reject(await verifyCustomerAssets({root:f.root,output}));
});

test('manifest path traversal and absolute source aliases are rejected',async t=>{
  for(const source of ['public/../backend.js','../outside.js','/public/app.js','public/subdir/app.js','public\\app.js','public/App.js']){
    const f=await fixture(t);f.manifest.entries[1].path=source;await f.save();
    reject(await buildCustomerAssets({root:f.root,output:f.output('bad-path')}));assert.equal(await exists(f.output('bad-path')),false);
  }
});

test('manifest hash alteration cannot substitute unreviewed source bytes',async t=>{
  const f=await fixture(t);f.manifest.entries[1].sha256='0'.repeat(64);await f.save();reject(await planCustomerAssets({root:f.root}));
});

test('unknown manifest fields, unknown entry fields, duplicate entries and dangling dependencies fail closed',async t=>{
  for(const mutate of [f=>{f.manifest.extra=true;},f=>{f.manifest.entries[0].approved=true;},
    f=>{f.manifest.entries.push({...f.manifest.entries[0]});},f=>{f.manifest.entries[0].dependencies.push('public/missing.js');}]){
    const f=await fixture(t);mutate(f);await f.save();reject(await planCustomerAssets({root:f.root}));
  }
});

test('file, aggregate and entry budgets are enforced on otherwise hash-valid fixtures',async t=>{
  const single=await fixture(t);await single.setSource('public/app.js',Buffer.alloc(256*1024+1,97));await single.save();reject(await planCustomerAssets({root:single.root}));
  const total=await fixture(t);for(const entry of total.manifest.entries.slice(0,4))await total.setSource(entry.path,Buffer.alloc(256*1024,97));await total.save();reject(await planCustomerAssets({root:total.root}));
  const count=await fixture(t);for(let i=0;i<27;i++){
    const name='public/extra-'+i+'.mjs',content=bytes('export {};\n');await fs.writeFile(path.join(count.root,name),content);
    count.manifest.entries.push({path:name,sha256:sha(content),byteLength:content.length,role:'module',dependencies:[],provenance:'BuildX application source'});
  }
  await count.save();assert.equal(count.manifest.entries.length,33);reject(await planCustomerAssets({root:count.root}));
});

test('output is restricted to one new lowercase named child of the fixed artifacts directory',async t=>{
  const f=await fixture(t);
  for(const output of [path.join(f.root,'outside'),f.output('UPPER'),f.output('bad_name'),f.output('x'.repeat(81)),path.join(f.output('nested'),'child')]){
    reject(await buildCustomerAssets({root:f.root,output}));assert.equal(await exists(output),false);
  }
});

test('source hardlinks are rejected even when the declared digest and bytes match',async t=>{
  const f=await fixture(t);await fs.link(path.join(f.root,'public','app.js'),path.join(f.root,'same-app.js'));
  reject(await planCustomerAssets({root:f.root}));reject(await buildCustomerAssets({root:f.root,output:f.output('hardlink-source')}));
  assert.equal(await exists(f.output('hardlink-source')),false);
});

test('source symlinks are rejected instead of following hash-matching targets',async t=>{
  const f=await fixture(t),source=path.join(f.root,'public','app.js'),target=path.join(f.root,'real-app.js');await fs.rename(source,target);
  if(!await linked(t,target,source,'file'))return;
  reject(await planCustomerAssets({root:f.root}));
});

test('output hardlinks are not valid verified files',async t=>{
  const f=await fixture(t),output=f.output('hardlink-output');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  await fs.link(path.join(output,'public','app.js'),path.join(f.root,'output-alias.js'));reject(await verifyCustomerAssets({root:f.root,output}));
});

test('output directory symlink or junction is rejected by independent verification',async t=>{
  const f=await fixture(t),output=f.output('junction-output');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  const original=path.join(output,'public'),target=path.join(f.root,'relocated-public');await fs.rename(original,target);
  if(!await linked(t,target,original,process.platform==='win32'?'junction':'dir'))return;
  reject(await verifyCustomerAssets({root:f.root,output}));
});

test('changed trusted input manifest invalidates an otherwise unchanged previous output',async t=>{
  const f=await fixture(t),output=f.output('old-manifest');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  f.manifest.entries[0].dependencies.reverse();await f.save();
  reject(await verifyCustomerAssets({root:f.root,output}));
});

test('large real public and top-level directories are rejected and remain removable after bounded verification',async t=>{
  for(const location of ['public','top']){
    const f=await fixture(t),output=f.output('large-'+location);assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
    const directory=location==='public'?path.join(output,'public'):output;
    const extras=[];
    for(let i=0;i<200;i++){const name=path.join(directory,'unlisted-'+i+'.js');await fs.writeFile(name,'fixture extra');extras.push(name);}
    reject(await verifyCustomerAssets({root:f.root,output}));
    for(const name of extras)await fs.unlink(name);
    // Re-read the surviving exact tree through the same public verifier. The
    // finally-close path is inspected in production code, not mocked here.
    assert.equal((await verifyCustomerAssets({root:f.root,output})).ok,true);
  }
});

test('failed real directory close and failed cleanup retry retain the same handle until confirmed close',async t=>{
  const f=await fixture(t),output=f.output('close-retry');assert.equal((await buildCustomerAssets({root:f.root,output})).ok,true);
  const original=fs.opendir;let retainedDirectory=null,realClose=null,closeCalls=0,openCalls=0,cleanupId=null;
  fs.opendir=async function(directory,options){
    openCalls++;const handle=await original.call(fs,directory,options);
    if(!retainedDirectory&&path.resolve(directory)===path.join(output,'public')){
      retainedDirectory=handle;realClose=handle.close.bind(handle);
      handle.close=async()=>{closeCalls++;if(closeCalls<=2)throw new Error('fixture close not yet confirmed');return realClose();};
    }
    return handle;
  };
  try{
    const failed=await verifyCustomerAssets({root:f.root,output});cleanupId=failed.error?.cleanupIds?.[0];
    reject(failed);assert.equal(failed.error.code,'CLEANUP_PENDING');assert.equal(failed.error.cleanupPending,true);
    assert.equal(typeof cleanupId,'string');assert.ok(cleanupId);assert.equal(closeCalls,1);assert.ok(retainedDirectory);
    const before=openCalls;
    reject(await planCustomerAssets({root:f.root}));reject(await buildCustomerAssets({root:f.root,output:f.output('must-not-start')}));
    reject(await verifyCustomerAssets({root:f.root,output}));assert.equal(openCalls,before);assert.equal(await exists(f.output('must-not-start')),false);
    const wrong=await cleanupCustomerAssetReads({cleanupId:'unowned-fixture-id'});reject(wrong);assert.equal(closeCalls,1);
    reject(await planCustomerAssets({root:f.root}));assert.equal(openCalls,before);
    const unconfirmed=await cleanupCustomerAssetReads({cleanupId});reject(unconfirmed);assert.equal(unconfirmed.error.code,'CLEANUP_PENDING');
    assert.deepEqual(unconfirmed.error.cleanupIds,[cleanupId]);assert.equal(closeCalls,2);
    reject(await planCustomerAssets({root:f.root}));assert.equal(openCalls,before);
    const cleaned=await cleanupCustomerAssetReads({cleanupId});assert.equal(cleaned.ok,true);assert.equal(cleaned.value.closed,true);
    assert.equal(cleaned.value.cleanupId,cleanupId);assert.equal(cleaned.value.kind,'directory');assert.equal(cleaned.value.remaining,0);
    assert.equal(closeCalls,3);cleanupId=null;
    reject(await cleanupCustomerAssetReads({cleanupId:cleaned.value.cleanupId}));
    assert.equal((await verifyCustomerAssets({root:f.root,output})).ok,true);
  }finally{
    fs.opendir=original;
    if(cleanupId){const cleanup=await cleanupCustomerAssetReads({cleanupId});assert.equal(cleanup.ok,true);assert.equal(cleanup.value.closed,true);}
  }
});
