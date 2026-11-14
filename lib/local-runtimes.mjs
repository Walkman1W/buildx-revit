import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Callers may display the fixed category without parsing a diagnostic message
// or exposing an executable path. The original messages remain actionable.
const runtimeError=(code,message)=>Object.assign(new Error(message),{code});

function regularFile(file){
  try{return fs.statSync(file).isFile();}
  catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}
}
function explicitExecutable(env,key,name){
  if(!Object.hasOwn(env,key))return null;
  const file=env[key];
  if(typeof file!=='string'||!path.isAbsolute(file)||path.basename(file).toLowerCase()!==name||!regularFile(file))
    throw runtimeError(key==='BUILDX_CODEX_EXE'?'CODEX_PATH_INVALID':'PYTHON_PATH_INVALID',key+' 必须指向已安装且可读取的 '+name+' 绝对路径；不会自动安装软件。');
  return file;
}
function pathDirectories(env){
  return (env.Path??env.PATH??'').split(path.delimiter).map(entry=>entry.replace(/^"|"$/g,''))
    .filter(entry=>entry&&path.isAbsolute(entry));
}

// The installer and live app-server use the same executable-selection owner.
// npm command wrappers are not executable identities and are never launched.
// All callers fail closed on an earlier wrapper; only an explicit path resolves it.
export function resolveCodexExecutable({env=process.env,home=os.homedir()}={}){
  let codex=explicitExecutable(env,'BUILDX_CODEX_EXE','codex.exe');
  let wrapper=false;
  if(!codex){
    for(const directory of pathDirectories(env)){
      const candidate=path.join(directory,'codex.exe');
      if(regularFile(candidate)){
        if(wrapper)throw runtimeError('CODEX_PATH_AMBIGUOUS','PATH 前面的 Codex 命令包装和后面的 codex.exe 可能属于不同版本；请将 BUILDX_CODEX_EXE 设置为已确认的 codex.exe 绝对路径；不会执行包装脚本或自动选择另一版本。');
        codex=candidate;break;
      }
      if(regularFile(path.join(directory,'codex.cmd'))||regularFile(path.join(directory,'codex.ps1')))wrapper=true;
    }
  }
  if(!codex){
    const bundleRoot=path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'OpenAI','Codex','bin');
    let entries=[];
    try{entries=fs.readdirSync(bundleRoot,{withFileTypes:true});}
    catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    const candidates=entries.filter(entry=>entry.isDirectory()&&/^[a-f0-9]{16}$/i.test(entry.name))
      .map(entry=>path.join(bundleRoot,entry.name,'codex.exe')).filter(regularFile);
    if(candidates.length===1){
      if(wrapper)throw runtimeError('CODEX_PATH_AMBIGUOUS','PATH 中的 Codex 命令包装与桌面版可能属于不同版本；请将 BUILDX_CODEX_EXE 设置为已确认的 codex.exe 绝对路径；不会执行包装脚本或自动选择另一版本。');
      codex=candidates[0];
    }
    else if(candidates.length>1)throw runtimeError('CODEX_PATH_AMBIGUOUS','发现多个 Codex 运行版本且 PATH 无法确定当前版本，请设置 BUILDX_CODEX_EXE；不会猜选。');
  }
  if(!codex&&wrapper)throw runtimeError('CODEX_WRAPPER_ONLY','检测到 Codex 命令包装，但未找到可直接调用的 codex.exe；请手动选择现有 codex.exe，不会执行包装脚本。');
  if(!codex)throw runtimeError('CODEX_NOT_FOUND','没有找到已安装的 codex.exe，请检查 PATH 或 BUILDX_CODEX_EXE；不会自动安装或切换 API Key。');
  return codex;
}

export function inspectPythonExecutable(candidate,{env=process.env,home=os.homedir()}={}){
    let info;
    try{info=fs.lstatSync(candidate);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}
    const aliasRoot=path.resolve(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'Microsoft','WindowsApps');
    const selected=path.resolve(candidate),relative=path.relative(aliasRoot.toLowerCase(),selected.toLowerCase());
    if((relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))||info.isSymbolicLink())
      throw runtimeError('PYTHON_PATH_UNVERIFIED','检测到 Python 应用执行别名或链接；请选择已安装的 python.exe，不会启动该别名。');
    let ancestor=path.dirname(selected),root=path.parse(selected).root;
    while(ancestor!==root){
      if(fs.lstatSync(ancestor).isSymbolicLink())throw runtimeError('PYTHON_PATH_UNVERIFIED','Python 路径包含未核验的链接；请选择已安装的 python.exe。');
      ancestor=path.dirname(ancestor);
    }
    return info.isFile();
}
export function resolvePythonExecutable({env=process.env,home=os.homedir()}={}){
  let python=explicitExecutable(env,'BUILDX_PYTHON_EXE','python.exe');
  const inspect=candidate=>inspectPythonExecutable(candidate,{env,home});
  if(python&&!inspect(python))throw runtimeError('PYTHON_PATH_INVALID','请选择可读取的 python.exe。');
  if(!python)for(const directory of pathDirectories(env)){
    const candidate=path.join(directory,'python.exe');
    if(inspect(candidate)){python=candidate;break;}
  }
  if(!python)throw runtimeError('PYTHON_NOT_FOUND','没有找到已有 Python 配置读取器，请设置 BUILDX_PYTHON_EXE；不会安装 Python。');
  return python;
}

export function resolveNodeExecutable({env=process.env,executable=process.execPath}={}){
  if(typeof executable==='string'&&path.isAbsolute(executable)&&path.basename(executable).toLowerCase()==='node.exe'&&regularFile(executable))return executable;
  for(const directory of pathDirectories(env)){
    const candidate=path.join(directory,'node.exe');
    if(regularFile(candidate))return candidate;
  }
  throw runtimeError('NODE_NOT_FOUND','没有找到已有 node.exe，请选择已安装的 Node。');
}

export function detectLocalRuntimes(options={}){
  const detect=fn=>{
    try{return {status:'found',path:fn(options),code:null};}
    catch(error){
      const code=typeof error?.code==='string'&&/^(?:NODE|PYTHON|CODEX)_[A-Z_]+$/.test(error.code)?error.code:'RUNTIME_UNAVAILABLE';
      const status=code.endsWith('_NOT_FOUND')?'missing':code.endsWith('_AMBIGUOUS')?'ambiguous':code.endsWith('_INVALID')?'invalid':'unavailable';
      return {status,path:null,code};
    }
  };
  return {schemaVersion:1,runtimes:{node:detect(resolveNodeExecutable),python:detect(resolvePythonExecutable),codex:detect(resolveCodexExecutable)},codexInstallUrl:'https://developers.openai.com/codex/cli/'};
}

export function resolveLocalRuntimes(options={}){
  const codex=resolveCodexExecutable(options),python=resolvePythonExecutable(options);
  return {codex,python};
}
