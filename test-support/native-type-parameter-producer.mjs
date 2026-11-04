import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
function between(source,start,end){const begin=source.indexOf(start),finish=source.indexOf(end,begin);if(begin<0||finish<0||source.indexOf(start,begin+start.length)>=0)throw new Error('Missing or ambiguous parameter fact owner');return source.slice(begin,finish).trim();}

export async function loadNativeTypeParameterProducer(t){
  const [queries,types,actions,sharedPeers,typePeers]=await Promise.all([
    fs.readFile(path.join(root,'revit-addin','NativeModelQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin','NativeParameterQueries.cs'),'utf8'),
    fs.readFile(path.join(root,'revit-addin','WorkbenchActions.cs'),'utf8'),fs.readFile(new URL('./native-model-query-peers.cs',import.meta.url),'utf8'),fs.readFile(new URL('./native-type-parameter-peers.cs',import.meta.url),'utf8')]);
  const descriptor=between(actions,'internal static object DescribeParameter(','private static object InternalValue('),internalValue=between(actions,'private static object InternalValue(','private static T RequiredType<T>(');
  const programMarker='    internal static class NativeQueryPeerProgram',program=sharedPeers.indexOf(programMarker);
  if(program<0||sharedPeers.indexOf(programMarker,program+programMarker.length)>=0)throw new Error('Shared read-peer boundary is ambiguous');
  const peers=sharedPeers.slice(0,program).replace('// ORIGINAL_DESCRIBE_PARAMETER',descriptor).replace('// ORIGINAL_INTERNAL_VALUE',internalValue)+'\n}\n';
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-native-type-parameters-'));
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('buildx-native-type-parameters-'))throw new Error('Unsafe type parameter producer cleanup');await fs.rm(resolved,{recursive:true,force:true});});
  const files=[['NativeModelQueries.cs',queries],['NativeParameterQueries.cs',types],['shared-peers.cs',peers],['type-peers.cs',typePeers]];
  await Promise.all(files.map(([name,value])=>fs.writeFile(path.join(directory,name),value)));
  const executable=path.join(directory,'type-parameters.exe');
  try{await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Core.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,...files.map(([name])=>path.join(directory,name))],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(error){throw new Error('Actual type parameter producer compilation failed: '+(error.stdout??'')+(error.stderr??''));}
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Type parameter producer timeout')),10000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024)finish(new Error('Type parameter producer response budget exceeded'));});
    child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)finish(new Error('Type parameter producer diagnostic budget exceeded'));});
    child.once('error',finish);child.stdin.on('error',finish);child.once('close',code=>{if(code!==0)return finish(new Error('Type parameter producer exit '+code+': '+stderr));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){finish(error);}});child.stdin.end(JSON.stringify(input));
  });
  produce.sourceEvidence={typeSource:'revit-addin/NativeParameterQueries.cs',typeSourceSha256:sha(types),sharedQuerySourceSha256:sha(queries),parameterDescriptorSha256:sha(descriptor),internalValueSha256:sha(internalValue),sharedPeersSha256:sha(sharedPeers),scope:'Actual unchanged C# type query, shared parameter rows and descriptor executed with controlled read-only API peers; no Autodesk loads or real model.'};
  return produce;
}
