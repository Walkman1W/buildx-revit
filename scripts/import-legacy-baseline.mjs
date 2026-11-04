import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const target=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.argv[2]??'D:/code/REA/local-codex-panel');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowed=new Set(['.mjs','.js','.cs','.ps1','.py','.json','.md','.css','.html','.png','.svg','.cmd','.sql','.txt']);
const directoryNames=['lib','public','prompts','revit-addin','family-core','tools','test','test-support','release','docs','sql','.agents'];
const excluded=new Set(['node_modules','artifacts','runtime','runtime-history','workbench','backups','obj','bin','.git','__pycache__','.cache']);
const paths=[];
async function collect(relative){
  const full=path.join(source,relative),stat=await fs.lstat(full);
  if(stat.isSymbolicLink())throw new Error(`Source link is not accepted: ${relative}`);
  if(stat.isDirectory()){
    for(const entry of await fs.readdir(full,{withFileTypes:true})){
      if(excluded.has(entry.name)||entry.name.startsWith('bin-'))continue;
      await collect(path.join(relative,entry.name));
    }
  }else if(stat.isFile()&&allowed.has(path.extname(relative))&&relative.replaceAll('\\','/')!=='lib/aec-read-contracts.json')paths.push(relative);
}
for(const directory of directoryNames)await collect(directory);
for(const entry of await fs.readdir(source,{withFileTypes:true})){
  if(entry.isFile()&&(entry.name.endsWith('.mjs')||['package.json','package-lock.json'].includes(entry.name)))paths.push(entry.name);
}
for(const filename of ['PLAN.zh-CN.md','NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md']){
  paths.push(path.join('planning','buildx-projectization',filename));
}
const records=[];
for(const relative of paths.sort()){
  const destinationRelative=relative.startsWith('planning'+path.sep)?path.join('docs','migration',path.basename(relative)):relative;
  const destination=path.resolve(target,destinationRelative);
  if(!destination.startsWith(target+path.sep))throw new Error('Target escaped project root');
  const bytes=await fs.readFile(path.join(source,relative));
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,bytes,{flag:'wx'});
  records.push({source:relative.replaceAll('\\','/'),path:destinationRelative.replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});
}
const changed=[];
for(const record of records){
  if(hash(await fs.readFile(path.join(source,record.source)))!==record.sha256)changed.push(record.source);
  if(hash(await fs.readFile(path.join(target,record.path)))!==record.sha256)throw new Error(`Destination differs: ${record.path}`);
}
const manifest={schemaVersion:1,createdAt:new Date().toISOString(),sourceRoot:source,sourceStableDuringCopy:changed.length===0,changed,releaseReady:false,
  omitted:['node_modules','runtime','runtime-history','workbench','artifacts','ui-preview','plugin binaries and build records','lib/aec-read-contracts.json'],files:records};
await fs.mkdir(path.join(target,'docs','migration'),{recursive:true});
await fs.writeFile(path.join(target,'docs','migration','source-baseline.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({files:records.length,bytes:records.reduce((sum,item)=>sum+item.bytes,0),sourceStableDuringCopy:manifest.sourceStableDuringCopy,changed}));
if(changed.length)process.exitCode=1;
