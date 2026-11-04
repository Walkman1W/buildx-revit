import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const listFile=path.join(ROOT,'tools/build-brain-candidate-files.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
function safe(p){return typeof p==='string' && /^(?:[\w.-]+\/)*[\w.-]+$/.test(p) && !p.split('/').some(x=>x==='.'||x==='..');}
async function regular(root,rel){
  let cur=root;
  for(const part of rel.split('/')) {cur=path.join(cur,part);const s=await fs.lstat(cur);if(s.isSymbolicLink())throw new Error(`link rejected: ${rel}`);}
  const s=await fs.lstat(cur);if(!s.isFile())throw new Error(`not a file: ${rel}`);
  return fs.readFile(cur);
}
async function fileList(file=listFile){const data=await fs.readFile(file);return {files:JSON.parse(data),sha256:hash(data),data};}
export async function buildSnapshot({sourceRoot=ROOT,output,files,whitelistSha256}={}){
  if(!path.isAbsolute(output)||path.parse(output).root===path.resolve(output))throw new Error('output must be an absolute non-root path');
  let whitelistData;
  if(!files){({files,sha256:whitelistSha256,data:whitelistData}=await fileList());}
  if(!Array.isArray(files)||!files.length||files.some(p=>!safe(p))||new Set(files.map(p=>p.toLowerCase())).size!==files.length)throw new Error('invalid whitelist');
  const parent=await fs.lstat(path.dirname(output));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('invalid output parent');
  const entries=[];
  for(const rel of files){const bytes=await regular(sourceRoot,rel);entries.push({path:rel,bytes,sha256:hash(bytes)});}
  await fs.mkdir(output);if(whitelistData)await fs.writeFile(path.join(output,'whitelist.json'),whitelistData,{flag:'wx'});const target=path.join(output,'source');await fs.mkdir(target);
  for(const entry of entries){const dest=path.join(target,...entry.path.split('/'));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,entry.bytes,{flag:'wx'});}
  for(const entry of entries)if(hash(await regular(sourceRoot,entry.path))!==entry.sha256)throw new Error(`source changed during snapshot: ${entry.path}; discard this candidate`);
  const manifest={schemaVersion:1,kind:'review-only-source-snapshot',installable:false,releaseReady:false,createdUtc:new Date().toISOString(),productVersion:'unassigned',whitelistSha256,files:entries.map(({path,bytes,sha256})=>({path,size:bytes.length,sha256}))};
  await fs.writeFile(path.join(output,'snapshot-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
async function walk(root,relative=''){
  const results=[];for(const d of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const rel=relative?`${relative}/${d.name}`:d.name;if(d.isSymbolicLink())throw new Error(`link rejected: ${rel}`);if(d.isDirectory())results.push(...await walk(root,rel));else if(d.isFile())results.push(rel);else throw new Error(`unsupported entry: ${rel}`);}return results;
}
export async function verifySnapshot(output,{expectedFiles,expectedWhitelistSha256}={}){
  if(!expectedFiles){({files:expectedFiles,sha256:expectedWhitelistSha256}=await fileList(path.join(output,'whitelist.json')));}
  const manifest=JSON.parse(await fs.readFile(path.join(output,'snapshot-manifest.json'),'utf8'));
  if(manifest.kind!=='review-only-source-snapshot'||manifest.installable!==false||!Array.isArray(manifest.files))throw new Error('invalid manifest');
  const expected=manifest.files.map(x=>x.path);if(expected.some(p=>!safe(p))||new Set(expected).size!==expected.length)throw new Error('invalid manifest paths');
  if(manifest.whitelistSha256!==expectedWhitelistSha256||JSON.stringify(expected)!==JSON.stringify(expectedFiles))throw new Error('snapshot does not match trusted whitelist');
  const actual=await walk(path.join(output,'source'));if(JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort()))throw new Error('snapshot file inventory differs from manifest');
  for(const e of manifest.files){const b=await regular(path.join(output,'source'),e.path);if(b.length!==e.size||hash(b)!==e.sha256)throw new Error(`snapshot mismatch: ${e.path}`);}
  return {ok:true,files:actual.length,manifestSha256:hash(await fs.readFile(path.join(output,'snapshot-manifest.json')))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [action,output]=process.argv.slice(2);if(!['build','verify'].includes(action)||!output||process.argv.length!==4)throw new Error('use build|verify <absolute new candidate directory>');const result=action==='build'?await buildSnapshot({output}):await verifySnapshot(output);console.log(JSON.stringify(result,null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
