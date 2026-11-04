import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {planCustomerChatPackage,buildCustomerChatPackage,verifyCustomerChatPackage,cleanupCustomerChatPackageReads} from './lib/customer-chat-package.mjs';
import {verifyCustomerAssets,cleanupCustomerAssetReads} from './lib/customer-assets.mjs';
import {CUSTOMER_CHAT_COMPONENT_DEFINITION as definition} from './lib/customer-component-definitions.mjs';

const manifestTemplate=JSON.parse(await fs.readFile(new URL('./release/customer-chat-component.json',import.meta.url),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const started=performance.now(),cpuStarted=process.cpuUsage();
test.after(()=>{const cpu=process.cpuUsage(cpuStarted);console.log('CUSTOMER_CHAT_PACKAGE_TEST_METRICS '+JSON.stringify({
  scope:'new-package-test-file process only; includes temporary filesystem fixtures and cleanup',wallMs:performance.now()-started,
  cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,lifetimePeakRssKiB:process.resourceUsage().maxRSS,
  processFamilyPeakRss:null,tokens:null,coldWarmCacheControlled:false}));});
function rejected(result){assert.equal(result.ok,false);assert.ok(result.error?.code);assert.equal(typeof result.error.message,'string');}
async function exists(name){try{await fs.lstat(name);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function temporary(t){
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-chat-package-test-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),parent);assert.ok(path.basename(root).startsWith('buildx-chat-package-test-'));
    await fs.rm(root,{recursive:true,force:true});});return root;
}
async function fixture(t){
  const root=await temporary(t),manifest=structuredClone(manifestTemplate);
  const sourceBytes=new Map();
  await fs.mkdir(path.join(root,'release'));
  for(const entry of manifest.entries){
    const bytes=Buffer.from('Independent packaging fixture: '+entry.path+'\n');
    await fs.mkdir(path.dirname(path.join(root,entry.path)),{recursive:true});
    await fs.writeFile(path.join(root,entry.path),bytes);sourceBytes.set(entry.path,bytes);
    entry.sha256=sha(bytes);entry.byteLength=bytes.length;
  }
  const manifestPath=path.join(root,...definition.manifest.split('/'));
  const save=()=>fs.writeFile(manifestPath,canonical(manifest));await save();
  return {root,manifest,manifestPath,sourceBytes,save,output:id=>path.join(root,'artifacts',definition.outputBase,id)};
}
async function tree(root){
  const result={};
  async function visit(relative){for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await visit(name);else result[name]=await fs.readFile(path.join(root,name));
  }}await visit('');return result;
}
async function link(t,target,destination,type){
  try{await fs.symlink(target,destination,type);return true;}catch(error){
    if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Host cannot create requested link: '+error.code);return false;}throw error;
  }
}

test('chat plan preserves the exact declared raw inputs and separately describes canonical generated package metadata',async t=>{
  const f=await fixture(t),result=await planCustomerChatPackage({root:f.root});assert.equal(result.ok,true);
  const plan=result.value;assert.equal(plan.component,'buildx-customer-chat-component');assert.equal(plan.stage,'customer-chat-component-only');
  assert.equal(plan.releaseReady,false);assert.equal(plan.entries.length,definition.exactPaths.length);
  assert.deepEqual(plan.entries.map(entry=>entry.path).sort(),[...definition.exactPaths].sort());
  assert.equal(plan.entries.find(entry=>entry.role==='entry').path,'customer-server.mjs');
  assert.equal(plan.inputManifestSha256,sha(await fs.readFile(f.manifestPath)));
  assert.deepEqual(plan.generatedFiles,[{path:'package.json',sha256:sha(Buffer.from(definition.generatedFiles['package.json'])),
    byteLength:Buffer.byteLength(definition.generatedFiles['package.json'])}]);
  assert.equal(plan.totalBytes,f.manifest.entries.reduce((total,entry)=>total+entry.byteLength,0)+Buffer.byteLength(definition.generatedFiles['package.json']));
  for(const entry of plan.entries){assert.equal(entry.sha256,sha(f.sourceBytes.get(entry.path)));assert.equal(entry.byteLength,f.sourceBytes.get(entry.path).length);}
  assert.equal(await exists(path.join(f.root,'artifacts')),false);
});

test('two builds contain identical exact declared nested trees and independently verify',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'vendor.dll'),'MZ undeclared research fixture');
  await fs.writeFile(path.join(f.root,'lib','not-declared.mjs'),'unlisted input fixture');
  const first=await buildCustomerChatPackage({root:f.root,output:f.output('one')}),second=await buildCustomerChatPackage({root:f.root,output:f.output('two')});
  assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(first.value.fileCount,definition.exactPaths.length+Object.keys(definition.generatedFiles).length+1);
  const bytes=await tree(f.output('one'));assert.deepEqual(bytes,await tree(f.output('two')));
  assert.deepEqual(Object.keys(bytes).sort(),[...definition.exactPaths,'package.json','BUILD-MANIFEST.json'].sort());
  for(const [name,content] of f.sourceBytes)assert.deepEqual(bytes[name],content);
  assert.deepEqual(bytes['package.json'],Buffer.from(definition.generatedFiles['package.json']));
  assert.equal((await verifyCustomerChatPackage({root:f.root,output:f.output('one')})).ok,true);
});

test('source changed from its declared hash rejects before creating an output',async t=>{
  const f=await fixture(t);await fs.appendFile(path.join(f.root,'lib','chat-session.mjs'),'changed');
  rejected(await buildCustomerChatPackage({root:f.root,output:f.output('changed')}));assert.equal(await exists(f.output('changed')),false);
});

test('unknown manifest fields, missing exact paths and undeclared dependencies fail closed',async t=>{
  for(const mutation of ['unknown-field','missing-path','outside-path','unknown-dependency','wrong-entry']){
    const f=await fixture(t);
    if(mutation==='unknown-field')f.manifest.extra=true;
    if(mutation==='missing-path')f.manifest.entries.pop();
    if(mutation==='outside-path')f.manifest.entries[0].path='../vendor.dll';
    if(mutation==='unknown-dependency')f.manifest.entries[0].dependencies.push('lib/not-declared.mjs');
    if(mutation==='wrong-entry'){f.manifest.entries.find(entry=>entry.role==='entry').role='module';f.manifest.entries.find(entry=>entry.path==='public/index.html').role='entry';}
    await f.save();rejected(await buildCustomerChatPackage({root:f.root,output:f.output(mutation)}));assert.equal(await exists(f.output(mutation)),false);
  }
});

test('per-file and total budgets include generated content and reject oversized manifests',async t=>{
  for(const mutation of ['large-file','large-total','large-manifest']){
    const f=await fixture(t);
    if(mutation==='large-file')f.manifest.entries[0].byteLength=256*1024+1;
    if(mutation==='large-total')for(let i=0;i<4;i++)f.manifest.entries[i].byteLength=256*1024;
    if(mutation==='large-manifest'){await fs.writeFile(f.manifestPath,Buffer.alloc(64*1024+1,32));}
    else await f.save();
    rejected(await planCustomerChatPackage({root:f.root}));
  }
});

test('existing outputs and paths outside the fixed output base are not replaced',async t=>{
  const f=await fixture(t),output=f.output('existing');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'keep.txt'),'keep');
  const before=await tree(output);rejected(await buildCustomerChatPackage({root:f.root,output}));assert.deepEqual(await tree(output),before);
  const outside=path.join(f.root,'artifacts','customer-web-assets','wrong-component');
  rejected(await buildCustomerChatPackage({root:f.root,output:outside}));assert.equal(await exists(outside),false);
});

test('missing, altered or renamed vendor artifact files cannot pass the trusted verifier',async t=>{
  for(const mutation of ['missing','altered','renamed-vendor']){
    const f=await fixture(t),output=f.output(mutation);assert.equal((await buildCustomerChatPackage({root:f.root,output})).ok,true);
    const entry=path.join(output,'lib','chat-session.mjs');
    if(mutation==='missing')await fs.unlink(entry);
    if(mutation==='altered')await fs.appendFile(entry,'tampered');
    if(mutation==='renamed-vendor')await fs.writeFile(path.join(output,'lib','innocent.mjs'),'MZ vendor DLL fixture');
    rejected(await verifyCustomerChatPackage({root:f.root,output}));
  }
});

test('generated package and output build metadata cannot redefine trusted inputs',async t=>{
  for(const mutation of ['package','metadata']){
    const f=await fixture(t),output=f.output(mutation);assert.equal((await buildCustomerChatPackage({root:f.root,output})).ok,true);
    if(mutation==='package')await fs.writeFile(path.join(output,'package.json'),'{}\n');
    else{const filename=path.join(output,'BUILD-MANIFEST.json'),value=JSON.parse(await fs.readFile(filename,'utf8'));value.releaseReady=true;await fs.writeFile(filename,canonical(value));}
    rejected(await verifyCustomerChatPackage({root:f.root,output}));
  }
});

test('extra nested directories and large nested listings are bounded rejections with reusable resources',async t=>{
  for(const mutation of ['directory','many-files']){
    const f=await fixture(t),output=f.output(mutation);assert.equal((await buildCustomerChatPackage({root:f.root,output})).ok,true);
    const added=[];
    if(mutation==='directory'){const directory=path.join(output,'lib','unexpected');await fs.mkdir(directory);added.push(directory);}
    else for(let i=0;i<200;i++){const filename=path.join(output,'lib','unlisted-'+i+'.mjs');await fs.writeFile(filename,'extra');added.push(filename);}
    rejected(await verifyCustomerChatPackage({root:f.root,output}));
    for(const filename of added)if(mutation==='directory')await fs.rmdir(filename);else await fs.unlink(filename);
    assert.equal((await verifyCustomerChatPackage({root:f.root,output})).ok,true);
  }
});

test('source symlinks and hardlinks are rejected instead of copied',async t=>{
  for(const mutation of ['symlink','hardlink']){
    const f=await fixture(t),source=path.join(f.root,'lib','chat-session.mjs'),alias=path.join(f.root,'source-alias.mjs');
    if(mutation==='hardlink')await fs.link(source,alias);
    else{await fs.rename(source,alias);if(!await link(t,alias,source,'file'))return;}
    rejected(await buildCustomerChatPackage({root:f.root,output:f.output(mutation)}));assert.equal(await exists(f.output(mutation)),false);
  }
});

test('nested output junctions and linked files never verify',async t=>{
  for(const mutation of ['junction','hardlink']){
    const f=await fixture(t),output=f.output(mutation);assert.equal((await buildCustomerChatPackage({root:f.root,output})).ok,true);
    if(mutation==='hardlink')await fs.link(path.join(output,'lib','chat-session.mjs'),path.join(f.root,'output-alias.mjs'));
    else{const source=path.join(output,'prompts'),target=path.join(f.root,'relocated-prompts');await fs.rename(source,target);
      if(!await link(t,target,source,process.platform==='win32'?'junction':'dir'))return;}
    rejected(await verifyCustomerChatPackage({root:f.root,output}));
  }
});

test('failed exact file close remains owned across failed cleanup and cannot be released by the frontend owner',async t=>{
  const f=await fixture(t),output=f.output('file-close-retry');assert.equal((await buildCustomerChatPackage({root:f.root,output})).ok,true);
  const target=path.join(output,'customer-server.mjs'),original=fs.open;let handle=null,realClose=null,closeCalls=0,openCalls=0,cleanupId=null;
  fs.open=async function(name,...args){openCalls++;const opened=await original.call(fs,name,...args);
    if(handle===null&&path.resolve(name)===target){handle=opened;realClose=opened.close.bind(opened);
      opened.close=async()=>{closeCalls++;if(closeCalls<=2)throw new Error('Fixture file close not yet confirmed');return realClose();};}
    return opened;
  };
  try{
    const failed=await verifyCustomerChatPackage({root:f.root,output});rejected(failed);assert.equal(failed.error.code,'CLEANUP_PENDING');
    cleanupId=failed.error.cleanupIds[0];assert.equal(closeCalls,1);assert.ok(handle);const openedBefore=openCalls;
    rejected(await planCustomerChatPackage({root:f.root}));rejected(await buildCustomerChatPackage({root:f.root,output:f.output('blocked')}));
    rejected(await verifyCustomerChatPackage({root:f.root,output}));assert.equal(openCalls,openedBefore);assert.equal(await exists(f.output('blocked')),false);
    rejected(await cleanupCustomerAssetReads({cleanupId}));rejected(await cleanupCustomerChatPackageReads({cleanupId:'foreign-id'}));assert.equal(closeCalls,1);
    const still=await cleanupCustomerChatPackageReads({cleanupId});rejected(still);assert.deepEqual(still.error.cleanupIds,[cleanupId]);assert.equal(closeCalls,2);
    rejected(await planCustomerChatPackage({root:f.root}));assert.equal(openCalls,openedBefore);
    const closed=await cleanupCustomerChatPackageReads({cleanupId});assert.equal(closed.ok,true);assert.deepEqual(closed.value,{cleanupId,closed:true,kind:'file',remaining:0});
    assert.equal(closeCalls,3);cleanupId=null;rejected(await cleanupCustomerChatPackageReads({cleanupId:closed.value.cleanupId}));
    assert.equal((await verifyCustomerChatPackage({root:f.root,output})).ok,true);
  }finally{
    fs.open=original;if(cleanupId){const closed=await cleanupCustomerChatPackageReads({cleanupId});assert.equal(closed.ok,true);assert.equal(closed.value.closed,true);}
  }
});

test('legacy frontend metadata bytes remain accepted without a generatedFiles field',async t=>{
  const root=await temporary(t),source=Buffer.from('<title>legacy frontend fixture</title>\n');
  await fs.mkdir(path.join(root,'release'));await fs.mkdir(path.join(root,'public'));await fs.writeFile(path.join(root,'public','index.html'),source);
  const entry={path:'public/index.html',sha256:sha(source),byteLength:source.length,role:'entry',dependencies:[],provenance:'BuildX application source'};
  const manifest=canonical({schemaVersion:1,component:'buildx-customer-web-assets',releaseReady:false,entries:[entry]});
  await fs.writeFile(path.join(root,'release','customer-web-assets.json'),manifest);
  const output=path.join(root,'artifacts','customer-web-assets','legacy');await fs.mkdir(path.join(output,'public'),{recursive:true});
  await fs.writeFile(path.join(output,'public','index.html'),source);
  const metadata=canonical({schemaVersion:1,component:'buildx-customer-web-assets',releaseReady:false,stage:'frontend-component-only',inputManifestSha256:sha(manifest),entries:[entry],totalBytes:source.length});
  await fs.writeFile(path.join(output,'BUILD-MANIFEST.json'),metadata);
  const checked=await verifyCustomerAssets({root,output});assert.equal(checked.ok,true);assert.equal(checked.value.fileCount,2);
  assert.equal(Object.hasOwn(checked.value,'generatedFiles'),false);assert.deepEqual(await fs.readFile(path.join(output,'BUILD-MANIFEST.json')),metadata);
});
