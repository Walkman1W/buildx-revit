import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
function between(source,start,end){const begin=source.indexOf(start),finish=source.indexOf(end,begin);if(begin<0||finish<0||source.indexOf(start,begin+start.length)>=0)throw new Error('Missing or ambiguous parameter fact owner');return source.slice(begin,finish).trim();}
function replaceOne(source,oldValue,newValue){if(source.indexOf(oldValue)<0||source.indexOf(oldValue)!==source.lastIndexOf(oldValue))throw new Error('Shared peer boundary changed');return source.replace(oldValue,newValue);}

/** Compile actual query services and unchanged shared fact owner with API peers. */
export async function loadNativeSingleParameterProducer(t){
  if(process.platform!=='win32')throw new Error('Native single-parameter peers require Windows .NET Framework compiler');
  const [queries,parameters,actions,sharedPeers,singlePeers]=await Promise.all([
    fs.readFile(path.join(root,'revit-addin/NativeModelQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin/NativeParameterQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin/WorkbenchActions.cs'),'utf8'),
    fs.readFile(new URL('./native-model-query-peers.cs',import.meta.url),'utf8'),fs.readFile(new URL('./native-single-parameter-peers.cs',import.meta.url),'utf8')]);
  const descriptor=between(actions,'internal static object DescribeParameter(','private static object InternalValue('),internalValue=between(actions,'private static object InternalValue(','private static T RequiredType<T>(');
  const programMarker='    internal static class NativeQueryPeerProgram',program=sharedPeers.indexOf(programMarker);
  if(program<0||sharedPeers.indexOf(programMarker,program+programMarker.length)>=0)throw new Error('Shared read-peer program boundary changed');
  // Only the test API peer collection changes: its deterministic enumerator can
  // count scans or delay enumeration. Production source is compiled unchanged.
  const peers=replaceOne(sharedPeers.slice(0,program),'public List<Parameter> Parameters=new List<Parameter>();','public SingleParameterCollection Parameters=new SingleParameterCollection();')
    .replace('// ORIGINAL_DESCRIBE_PARAMETER',descriptor).replace('// ORIGINAL_INTERNAL_VALUE',internalValue)+'\n}\n';
  const tempRoot=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(tempRoot,'buildx-native-single-parameter-')),nonce=randomUUID();
  await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({kind:'native-single-parameter-peers',nonce}),{flag:'wx'});
  t.after(async()=>{const real=await fs.realpath(directory),stat=await fs.lstat(directory),owner=JSON.parse(await fs.readFile(path.join(directory,'owner.json'),'utf8'));if(real!==path.resolve(directory)||path.dirname(real)!==tempRoot||!path.basename(real).startsWith('buildx-native-single-parameter-')||!stat.isDirectory()||stat.isSymbolicLink()||owner.kind!=='native-single-parameter-peers'||owner.nonce!==nonce)throw new Error('Unsafe single-parameter peer cleanup');await fs.rm(real,{recursive:true,force:false});});
  const files=[['NativeModelQueries.cs',queries],['NativeParameterQueries.cs',parameters],['shared-peers.cs',peers],['single-peers.cs',singlePeers]];
  await Promise.all(files.map(([name,value])=>fs.writeFile(path.join(directory,name),value,{flag:'wx'})));
  const executable=path.join(directory,'single-parameter.exe');
  try{await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Core.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,...files.map(([name])=>path.join(directory,name))],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(error){throw new Error('Actual single-parameter query compilation failed: '+(error.stdout??'')+(error.stderr??''));}
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Single-parameter peer timeout')),12000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024)finish(new Error('Single-parameter peer response limit'));});child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)finish(new Error('Single-parameter peer diagnostic limit'));});
    child.once('error',finish);child.stdin.on('error',finish);child.once('close',code=>{if(code!==0)return finish(new Error('Single-parameter peer exit '+code+': '+stderr));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){finish(error);}});child.stdin.end(JSON.stringify(input));
  });
  produce.sourceEvidence={querySource:'revit-addin/NativeParameterQueries.cs',querySourceSha256:sha(parameters),sharedQuerySourceSha256:sha(queries),parameterDescriptorSha256:sha(descriptor),internalValueSha256:sha(internalValue),sharedPeersSha256:sha(sharedPeers),singlePeersSha256:sha(singlePeers),scope:'Actual unchanged parameter query, shared exact-ID parser, budget and descriptor; controlled read-only API peers, collection enumeration instrumentation only; no Autodesk load, transactions or real model'};
  return produce;
}
