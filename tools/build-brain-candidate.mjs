import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const listFile=path.join(ROOT,'tools/build-brain-candidate-files.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
function safe(p){return typeof p==='string' && /^(?:[\w.-]+\/)*[\w.-]+$/.test(p) && !p.split('/').some(x=>x==='.'||x==='..');}
const runtimePath=file=>/^(?:node_modules|runtime|runtime-history|workbench|artifacts|outputs|private-runtime|\.git)(?:\/|$)/i.test(file);
const sourceFile=file=>safe(file)&&!runtimePath(file)&&!/\.(?:dll|exe|pdb|rvt|rfa|rte|rft|log|tmp|bak)$/i.test(file)&&!/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*)$/i.test(file);
async function regular(root,rel){
  let cur=root;
  for(const part of rel.split('/')) {cur=path.join(cur,part);const s=await fs.lstat(cur);if(s.isSymbolicLink())throw new Error(`link rejected: ${rel}`);}
  const s=await fs.lstat(cur);if(!s.isFile())throw new Error(`not a file: ${rel}`);
  return fs.readFile(cur);
}
async function fileList(file=listFile){const data=await fs.readFile(file);return {files:JSON.parse(data),sha256:hash(data),data};}

// Tokenize only the boundaries needed for literal import()/new URL(...,
// import.meta.url). Strings, comments, regular expressions and template text
// cannot invent dependencies; actual modules are parsed separately by V8.
function literalTokens(source){
  const out=[];let i=0;
  function scan(stopAtBrace=false){let depth=0;
  while(i<source.length){
    const c=source[i],next=source[i+1];
    if(stopAtBrace&&c==='}'&&depth===0){i++;return;}
    if(/\s/.test(c)){i++;continue;}
    if(c==='/'&&next==='/'){i+=2;while(i<source.length&&source[i]!=='\n')i++;continue;}
    if(c==='/'&&next==='*'){const end=source.indexOf('*/',i+2);if(end<0)throw new Error('Unclosed source comment');i=end+2;continue;}
    if(c==='"'||c==="'"){
      const start=++i;let escaped=false;
      while(i<source.length&&source[i]!==c){if(source[i]==='\\'){escaped=true;i+=2;}else i++;}
      if(i>=source.length)throw new Error('Unclosed source string at '+start);
      out.push({type:'string',value:escaped?null:source.slice(start,i)});i++;continue;
    }
    if(c==='`'){
      i++;while(i<source.length){
        if(source[i]==='\\'){i+=2;continue;}
        if(source[i]==='$'&&source[i+1]==='{'){i+=2;scan(true);continue;}
        if(source[i++]==='`')break;
      }
      out.push({type:'template',value:null});continue;
    }
    const previousToken=out.at(-1),previous=previousToken?.value;
    if(c==='/'&&(!previousToken||['=','(', '[','{',',',':',';','!','return','=>','?','|','&','~','case','throw','yield','await'].includes(previous))){
      i++;let characterClass=false;
      while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source[i]==='[')characterClass=true;else if(source[i]===']')characterClass=false;else if(source[i]==='/'&&!characterClass){i++;break;}i++;}
      while(/[a-z]/i.test(source[i]??'')&&i<source.length)i++;
      out.push({type:'regex',value:null});continue;
    }
    if(/[A-Za-z_$]/.test(c)){const start=i++;while(/[A-Za-z0-9_$]/.test(source[i]??'')&&i<source.length)i++;out.push({type:'word',value:source.slice(start,i)});continue;}
    if(c==='='&&next==='>'){out.push({type:'punctuation',value:'=>'});i+=2;continue;}
    if(c==='{')depth++;else if(c==='}')depth--;
    out.push({type:'punctuation',value:c});i++;
  }
  }
  scan();
  return out;
}
export function inspectLiteralModuleReferences(source){
  const tokens=literalTokens(source),imports=[],resources=[],nonLiteralImports=[];
  const at=(i,value)=>tokens[i]?.value===value;
  for(let i=0;i<tokens.length;i++){
    if(at(i,'import')&&at(i+1,'(')){
      if(tokens[i+2]?.type==='string'&&tokens[i+2].value!==null&&at(i+3,')'))imports.push(tokens[i+2].value);
      else nonLiteralImports.push(i);
    }
    if(at(i,'new')&&at(i+1,'URL')&&at(i+2,'(')&&tokens[i+3]?.type==='string'&&tokens[i+3].value!==null&&
      [',','import','.','meta','.','url',')'].every((value,index)=>at(i+4+index,value)))resources.push(tokens[i+3].value);
  }
  return {imports,resources,nonLiteralImports};
}
async function staticSpecifiers(modules){
  // SourceTextModule parsing is non-executing. A short owned Node child makes
  // the checker available without requiring callers to remember VM flags.
  const program="import vm from 'node:vm';import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(input.map(item=>({path:item.path,imports:new vm.SourceTextModule(item.source,{identifier:item.path}).dependencySpecifiers}))));";
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--experimental-vm-modules','--input-type=module','-e',program],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',error='',done=false;
    const finish=(failure,result)=>{if(done)return;done=true;clearTimeout(timer);failure?reject(failure):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Source parser exceeded its bounded deadline'));},15000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{output+=part;if(output.length>4*1024*1024){child.kill();finish(new Error('Source parser output exceeded budget'));}});
    child.stderr.on('data',part=>{if(error.length<8192)error+=part;});
    child.on('error',failure=>finish(failure));child.stdin.on('error',failure=>finish(failure));
    child.on('close',code=>{if(code!==0)return finish(new Error('Source parsing failed: '+error.slice(0,1000)));try{finish(null,JSON.parse(output));}catch{finish(new Error('Invalid source parser response'));}});
    child.stdin.end(JSON.stringify(modules));
  });
}
function stringArray(source,name){
  const tokens=literalTokens(source),start=tokens.findIndex((token,i)=>token.value==='const'&&tokens[i+1]?.value===name&&tokens[i+2]?.value==='='&&tokens[i+3]?.value==='[');
  if(start<0)throw new Error('Missing product resource owner: '+name);
  const values=[];
  for(let i=start+4;i<tokens.length;i++){const token=tokens[i];if(token.value===']')return values;if(token.value===',')continue;if(token.type!=='string'||token.value===null)throw new Error('Nonliteral product resource owner: '+name);values.push(token.value);}
  throw new Error('Unclosed product resource owner: '+name);
}
export async function inspectSnapshotClosure({sourceRoot=ROOT,files}={}){
  if(!files)({files}=await fileList());
  const selected=new Set(files),modules=[],missing=[],bare=new Set(),runtimeReferences=[],directoryReferences=[];let references=0;
  for(const file of files.filter(file=>/\.(?:mjs|js)$/.test(file)))modules.push({path:file,source:(await regular(sourceRoot,file)).toString('utf8')});
  const parsed=await staticSpecifiers(modules),lookup=new Map(modules.map(item=>[item.path,item.source]));
  const requireFile=(owner,target,kind)=>{references++;if(!safe(target)||!selected.has(target))missing.push({owner,target,kind});};
  for(const item of parsed){
    let literal;try{literal=inspectLiteralModuleReferences(lookup.get(item.path));}catch(error){throw new Error(item.path+': '+error.message);}
    for(const specifier of [...item.imports,...literal.imports]){
      if(specifier.startsWith('.'))requireFile(item.path,path.posix.normalize(path.posix.join(path.posix.dirname(item.path),specifier)),'module');
      else if(!specifier.startsWith('node:'))bare.add(specifier);
    }
    for(const specifier of literal.resources)if(specifier.startsWith('.')){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(item.path),specifier));
      if(runtimePath(target))runtimeReferences.push({owner:item.path,target});
      else if(specifier.endsWith('/')||specifier==='.'||specifier==='..')directoryReferences.push({owner:item.path,target});
      else requireFile(item.path,target,'url-resource');
    }
    if(literal.nonLiteralImports.length)missing.push({owner:item.path,target:null,kind:'nonliteral-import-requires-explicit-owner'});
    if(item.path.startsWith('public/'))for(const token of literalTokens(lookup.get(item.path))){
      if(token.type==='string'&&/^\/[\w./-]+\.(?:html|css|mjs|js|png|svg|webp)$/.test(token.value??''))requireFile(item.path,'public/'+token.value.slice(1),'public-link');
    }
  }
  if(selected.has('lib/panel-server-core.mjs'))for(const token of literalTokens(lookup.get('lib/panel-server-core.mjs'))){
    if(token.type==='string'&&/^[\w.-]+\.(?:html|css|mjs|js|png|svg|webp)$/.test(token.value??''))requireFile('lib/panel-server-core.mjs','public/'+token.value,'served-route');
  }
  for(const file of files.filter(file=>/\.(?:html|css)$/.test(file))){
    const source=(await regular(sourceRoot,file)).toString('utf8'),links=[];
    if(file.endsWith('.html'))for(const match of source.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi))links.push(match[2]);
    else{
      for(const match of source.matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi))links.push(match[2]);
      for(const match of source.matchAll(/@import\s+(["'])([^"']+)\1/gi))links.push(match[2]);
    }
    for(const link of links){
      if(/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link))continue;
      const pathname=link.split(/[?#]/)[0];if(!/\.(?:html|css|mjs|js|png|svg|webp|woff2?)$/i.test(pathname))continue;
      requireFile(file,pathname.startsWith('/')?'public/'+pathname.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(file),pathname)),'markup-resource');
    }
  }
  if(selected.has('tools/buildx-installer.mjs')){
    const source=lookup.get('tools/buildx-installer.mjs');
    for(const name of ['ENTRY','SETUP','NON_JS_ASSETS'])for(const file of stringArray(source,name))requireFile('tools/buildx-installer.mjs',file,'product-resource');
    for(const file of stringArray(source,'WEB'))requireFile('tools/buildx-installer.mjs','public/'+file,'public-resource');
    requireFile('tools/buildx-installer.mjs','tools/buildx-package-entry.cmd','package-entry-source');
  }
  if(selected.has('package.json')){
    const manifest=JSON.parse((await regular(sourceRoot,'package.json')).toString('utf8'));
    for(const command of Object.values(manifest.scripts??{}))for(const match of command.matchAll(/(?:^|\s)([\w./-]+\.(?:mjs|js))(?=\s|$)/g))requireFile('package.json',match[1],'package-script');
  }
  if(selected.has('revit-addin/build.ps1')){
    for(const directory of ['revit-addin','family-core','family-core/revit'])for(const item of await fs.readdir(path.join(sourceRoot,directory),{withFileTypes:true}))if(item.isFile()&&item.name.endsWith('.cs'))requireFile('revit-addin/build.ps1',directory+'/'+item.name,'compiled-source');
    requireFile('revit-addin/build.ps1','public/bim-x-logo.png','assembly-resource');
  }
  if(selected.has('lib/customer-component-definitions.mjs')){
    for(const token of literalTokens(lookup.get('lib/customer-component-definitions.mjs'))){
      const value=token.type==='string'?token.value:null;
      if(value&&/^(?:(?:lib|public|prompts|release)\/[^\s]+\.(?:mjs|js|css|html|md|json)|customer-[\w.-]+\.(?:mjs|md))$/.test(value))requireFile('lib/customer-component-definitions.mjs',value,'component-resource');
    }
  }
  return {ok:missing.length===0,modules:modules.length,references,bareImports:[...bare].sort(),runtimeReferences,directoryReferences,missing};
}
async function requireClosure(sourceRoot,files){const result=await inspectSnapshotClosure({sourceRoot,files});if(!result.ok)throw new Error('Source snapshot dependency closure is incomplete: '+JSON.stringify(result.missing));return result;}
export async function buildSnapshot({sourceRoot=ROOT,output,files,whitelistSha256}={}){
  if(!path.isAbsolute(output)||path.parse(output).root===path.resolve(output))throw new Error('output must be an absolute non-root path');
  let whitelistData;
  if(!files){({files,sha256:whitelistSha256,data:whitelistData}=await fileList());}
  if(!Array.isArray(files)||!files.length||files.some(p=>!sourceFile(p))||new Set(files.map(p=>p.toLowerCase())).size!==files.length)throw new Error('invalid whitelist');
  const closure=await requireClosure(sourceRoot,files);
  const parent=await fs.lstat(path.dirname(output));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('invalid output parent');
  const entries=[];
  for(const rel of files){const bytes=await regular(sourceRoot,rel);entries.push({path:rel,bytes,sha256:hash(bytes)});}
  await fs.mkdir(output);if(whitelistData)await fs.writeFile(path.join(output,'whitelist.json'),whitelistData,{flag:'wx'});const target=path.join(output,'source');await fs.mkdir(target);
  for(const entry of entries){const dest=path.join(target,...entry.path.split('/'));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,entry.bytes,{flag:'wx'});}
  for(const entry of entries)if(hash(await regular(sourceRoot,entry.path))!==entry.sha256)throw new Error(`source changed during snapshot: ${entry.path}; discard this candidate`);
  const manifest={schemaVersion:1,kind:'review-only-source-snapshot',installable:false,releaseReady:false,createdUtc:new Date().toISOString(),productVersion:'unassigned',whitelistSha256,closure,files:entries.map(({path,bytes,sha256})=>({path,size:bytes.length,sha256}))};
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
  const expected=manifest.files.map(x=>x.path);if(expected.some(p=>!sourceFile(p))||new Set(expected).size!==expected.length)throw new Error('invalid manifest paths');
  if(manifest.whitelistSha256!==expectedWhitelistSha256||JSON.stringify(expected)!==JSON.stringify(expectedFiles))throw new Error('snapshot does not match trusted whitelist');
  const actual=await walk(path.join(output,'source'));if(JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort()))throw new Error('snapshot file inventory differs from manifest');
  for(const e of manifest.files){const b=await regular(path.join(output,'source'),e.path);if(b.length!==e.size||hash(b)!==e.sha256)throw new Error(`snapshot mismatch: ${e.path}`);}
  const closure=await requireClosure(path.join(output,'source'),expected);
  return {ok:true,files:actual.length,closure,manifestSha256:hash(await fs.readFile(path.join(output,'snapshot-manifest.json')))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [action,output]=process.argv.slice(2);if(!['build','verify'].includes(action)||!output||process.argv.length!==4)throw new Error('use build|verify <absolute new candidate directory>');const result=action==='build'?await buildSnapshot({output}):await verifySnapshot(output);console.log(JSON.stringify(result,null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
