import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const run=promisify(execFile);
const sha=value=>createHash('sha256').update(value).digest('hex');
function between(source,start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  if(first<0||last<0||source.indexOf(start,first+start.length)>=0)throw new Error('Missing or ambiguous native parameter producer boundary');
  return source.slice(first,last).trim();
}
export async function loadNativeModelQueryProducer(t){
  const [source,actions,peers]=await Promise.all([fs.readFile(path.join(root,'revit-addin','NativeModelQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin','WorkbenchActions.cs'),'utf8'),fs.readFile(new URL('./native-model-query-peers.cs',import.meta.url),'utf8')]);
  const parameter=between(actions,'internal static object DescribeParameter(','private static object InternalValue(');
  const internalValue=between(actions,'private static object InternalValue(','private static T RequiredType<T>(');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-native-query-producer-'));
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('buildx-native-query-producer-'))throw new Error('Unsafe native producer cleanup');await fs.rm(resolved,{recursive:true,force:true});});
  const service=path.join(directory,'NativeModelQueries.cs'),fixture=path.join(directory,'peers.cs'),executable=path.join(directory,'queries.exe');
  await Promise.all([fs.writeFile(service,source),fs.writeFile(fixture,peers.replace('// ORIGINAL_DESCRIBE_PARAMETER',parameter).replace('// ORIGINAL_INTERNAL_VALUE',internalValue))]);
  try{await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/reference:'+path.join(framework,'System.Core.dll'),'/out:'+executable,service,fixture],{cwd:directory,windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(error){throw new Error('Native model query producer compilation failed: '+(error.stdout??'')+(error.stderr??''));}
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{child.kill();finish(new Error('Native model query producer timeout'));},10000);
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024){child.kill();finish(new Error('Native producer output budget'));}});
    child.stderr.on('data',part=>{stderr+=part;});child.on('error',finish);child.stdin.on('error',finish);
    child.on('close',code=>{if(code!==0)return finish(new Error('Native producer exit '+code+': '+stderr));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){finish(error);}});
    child.stdin.end(JSON.stringify(input));
  });
  produce.sourceEvidence={source:'revit-addin/NativeModelQueries.cs',sourceSha256:sha(source),parameterProducerSha256:sha(parameter),internalValueProducerSha256:sha(internalValue),scope:'Unmodified native query and parameter producers executed with controlled Revit API peers; no real Revit process/model.'};
  return produce;
}
