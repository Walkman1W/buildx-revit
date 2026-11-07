import fs from 'node:fs';
import path from 'node:path';

const invalid=()=>new Error('BuildX installation configuration is invalid or unavailable.');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const windowsPath=value=>typeof value==='string'&&value.length<=1024&&/^[A-Za-z]:\\/.test(value)&&!/[\x00-\x1f<>"|?*]/.test(value)&&!value.slice(2).includes(':')&&!value.slice(3).split('\\').some(part=>!part||/[ .]$/.test(part))&&path.win32.normalize(value).toLowerCase()===value.toLowerCase();
const executable=(value,name)=>windowsPath(value)&&path.win32.basename(value).toLowerCase()===name;
const overlaps=(a,b)=>{const relative=path.win32.relative(a,b);return relative===''||relative!=='..'&&!relative.startsWith('..\\')&&!path.win32.isAbsolute(relative);};

// A version-2 installation may select a separate loopback listener. Revit reads
// the same explicit value; environment overrides cannot redirect its pane.
export function resolveBuildxPanelPort(configuration){
  if(configuration===null||configuration===undefined)return 41873;
  if(!plain(configuration))throw invalid();
  if(!Object.hasOwn(configuration,'panelPort'))return 41873;
  const port=configuration.panelPort;
  if(configuration.schemaVersion!==2||!Number.isInteger(port)||port<1024||port>65535)throw invalid();
  return port;
}

// Inspect existing ancestors without creating anything. A configuration cannot
// redirect model queues or user history through a junction/symlink.
export function assertBuildxDataPath(dataRoot,programRoot){
  if(!windowsPath(dataRoot)||dataRoot.endsWith('\\')||path.win32.parse(dataRoot).root.toLowerCase()===dataRoot.toLowerCase()||
    overlaps(programRoot,dataRoot)||overlaps(dataRoot,programRoot))throw invalid();
  if(process.platform==='win32'){
    let current=path.parse(dataRoot).root;
    for(const part of dataRoot.slice(current.length).split(path.sep)){
      current=path.join(current,part);
      try{const entry=fs.lstatSync(current);if(entry.isSymbolicLink()||!entry.isDirectory())throw invalid();}
      catch(error){if(error.code==='ENOENT')break;throw invalid();}
    }
  }
  return dataRoot;
}

export function normalizeInstallationConfiguration(value,{programRoot}={}){
  if(!plain(value)||![1,2].includes(value.schemaVersion)||!path.isAbsolute(programRoot??'')||
    typeof value.installationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installationId)||
    !executable(value.nodeExecutable,'node.exe')||!executable(value.pythonExecutable,'python.exe')||!executable(value.codexExecutable,'codex.exe'))throw invalid();
  const allowed=['schemaVersion','installationId','nodeExecutable','pythonExecutable','codexExecutable',...(value.schemaVersion===2?['dataRoot','panelPort']:[])];
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw invalid();
  resolveBuildxPanelPort(value);
  if(value.schemaVersion===2)assertBuildxDataPath(value.dataRoot,programRoot);
  return Object.freeze({schemaVersion:value.schemaVersion,installationId:value.installationId,nodeExecutable:value.nodeExecutable,
    pythonExecutable:value.pythonExecutable,codexExecutable:value.codexExecutable,...value.schemaVersion===2?{dataRoot:value.dataRoot}:{},
    ...Object.hasOwn(value,'panelPort')?{panelPort:value.panelPort}:{}});
}

const missingDocument=Symbol('missing-installation-document');
function readPlainInstallationDocument(file,{allowMissing=false}={}){
  let observed=false,handle=null;
  try{
    const info=fs.lstatSync(file,{bigint:true});observed=true;
    if(!info.isFile()||info.isSymbolicLink()||info.size<1n||info.size>4096n)throw invalid();
    const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs&&a.mtimeNs===b.mtimeNs&&a.size===b.size;
    handle=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(handle,{bigint:true});if(!same(info,opened))throw invalid();
    const buffer=Buffer.alloc(4097);let length=0;
    while(length<buffer.length){const count=fs.readSync(handle,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
    const named=fs.lstatSync(file,{bigint:true});
    if(length!==Number(opened.size)||named.isSymbolicLink()||!same(opened,fs.fstatSync(handle,{bigint:true}))||!same(opened,named))throw invalid();
    const bytes=buffer.subarray(0,length);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
    const value=JSON.parse(text),keys=new Set();let depth=0;
    // JSON.parse keeps only the last duplicate key; the C# reader rejects
    // duplicates. Inspect top-level property tokens to keep both readers equal.
    for(let index=0;index<text.length;index++){
      const token=text[index];
      if(token==='"'){
        const start=index++;for(;index<text.length;index++){if(text[index]==='\\'){index++;continue;}if(text[index]==='"')break;}
        let next=index+1;while(/\s/.test(text[next]??'')&&next<text.length)next++;
        if(depth===1&&text[next]===':'){const key=JSON.parse(text.slice(start,index+1));if(keys.has(key))throw invalid();keys.add(key);}
      }else if(token==='{'||token==='[')depth++;else if(token==='}'||token===']')depth--;
    }
    return value;
  }catch(error){if(allowMissing&&error.code==='ENOENT'&&!observed)return missingDocument;throw invalid();}
  finally{if(handle!==null)fs.closeSync(handle);}
}

function verifyDataOwner(configuration){
  if(configuration?.schemaVersion!==2)return;
  const owner=readPlainInstallationDocument(path.join(configuration.dataRoot,'buildx-data-owner.json'));
  if(!plain(owner)||Object.keys(owner).length!==2||owner.schemaVersion!==1||owner.installationId!==configuration.installationId)throw invalid();
}

export function readBuildxInstallation(programRoot){
  const value=readPlainInstallationDocument(path.join(programRoot,'buildx-installation.json'),{allowMissing:true});
  if(value===missingDocument)return null;
  const configuration=normalizeInstallationConfiguration(value,{programRoot});
  verifyDataOwner(configuration);
  return configuration;
}

// Version 1 retains its original paths; it never silently migrates history or
// unknown receipts. New installations use version 2 and a separate data root.
// Unconfigured source/test checkouts retain relative local paths, but the Revit
// installation loader requires an explicit configuration.
export function resolveBuildxPaths(programRoot,configuration=undefined){
  if(!path.isAbsolute(programRoot??''))throw new TypeError('Absolute BuildX program root required.');
  programRoot=path.resolve(programRoot);
  const selected=configuration===undefined?readBuildxInstallation(programRoot):configuration;
  const config=selected===null?null:normalizeInstallationConfiguration(selected,{programRoot});
  verifyDataOwner(config);
  const dataRoot=config?.schemaVersion===2?config.dataRoot:programRoot;
  return Object.freeze({programRoot,dataRoot,mode:config?config.schemaVersion===2?'installed':'legacy-installed':'source',
    workbenchRoot:path.join(dataRoot,'workbench'),runtimeDirectory:path.join(dataRoot,'runtime'),
    historyDirectory:path.join(dataRoot,'runtime-history'),projectHistoryDirectory:path.join(dataRoot,'project-history'),
    privateRuntimeDirectory:path.join(programRoot,'private-runtime'),webViewDirectory:path.join(dataRoot,'WebView2')});
}
