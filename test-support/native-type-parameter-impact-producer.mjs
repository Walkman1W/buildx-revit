import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
function between(source,start,end){const begin=source.indexOf(start),finish=source.indexOf(end,begin);if(begin<0||finish<0||source.indexOf(start,begin+start.length)>=0)throw new Error('Missing or ambiguous shared fact boundary');return source.slice(begin,finish).trim();}
function replaceOne(source,before,after){if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw new Error('Shared API peer boundary changed');return source.replace(before,after);}

export async function loadNativeTypeParameterImpactProducer(t){
  if(process.platform!=='win32')throw new Error('Native type-impact producer requires Windows .NET Framework compiler');
  const [queries,parameters,actions,sharedPeers,impactPeers]=await Promise.all([
    fs.readFile(path.join(root,'revit-addin/NativeModelQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin/NativeParameterQueries.cs'),'utf8'),fs.readFile(path.join(root,'revit-addin/WorkbenchActions.cs'),'utf8'),
    fs.readFile(new URL('./native-model-query-peers.cs',import.meta.url),'utf8'),fs.readFile(new URL('./native-type-parameter-impact-peers.cs',import.meta.url),'utf8')]);
  const descriptor=between(actions,'internal static object DescribeParameter(','private static object InternalValue('),internalValue=between(actions,'private static object InternalValue(','private static T RequiredType<T>('),marker='    internal static class NativeQueryPeerProgram',program=sharedPeers.indexOf(marker);
  if(program<0||sharedPeers.indexOf(marker,program+marker.length)>=0)throw new Error('Shared API peer program boundary changed');
  let peers=sharedPeers.slice(0,program).replace('// ORIGINAL_DESCRIBE_PARAMETER',descriptor).replace('// ORIGINAL_INTERNAL_VALUE',internalValue)+'\n}\n';
  // All replacements are confined to controlled API peers. The production
  // query, exact-ID parser, shared budget and descriptor remain unchanged.
  peers=replaceOne(peers,'public List<Parameter> Parameters=new List<Parameter>();','public ImpactParameterCollection Parameters=new ImpactParameterCollection();');
  peers=replaceOne(peers,'public ElementId GetTypeId(){return TypeId;}','public ElementId GetTypeId(){return ImpactPeerControl.GetTypeId(this);}');
  peers=replaceOne(peers,'public Element GetElement(ElementId id){return Elements.FirstOrDefault(element=>element.Id.Value==id.Value);}','public Element GetElement(ElementId id){return ImpactPeerControl.Lookup(this,id);}');
  peers=replaceOne(peers,'public IEnumerator<Element> GetEnumerator(){return values.GetEnumerator();}','public IEnumerator<Element> GetEnumerator(){return ImpactPeerControl.Enumerate(values).GetEnumerator();}');
  const tempRoot=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(tempRoot,'buildx-type-parameter-impact-')),nonce=randomUUID();
  await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({kind:'type-parameter-impact-peers',nonce}),{flag:'wx'});
  t.after(async()=>{const real=await fs.realpath(directory),stat=await fs.lstat(directory),owner=JSON.parse(await fs.readFile(path.join(directory,'owner.json'),'utf8'));if(real!==path.resolve(directory)||path.dirname(real)!==tempRoot||!path.basename(real).startsWith('buildx-type-parameter-impact-')||!stat.isDirectory()||stat.isSymbolicLink()||owner.kind!=='type-parameter-impact-peers'||owner.nonce!==nonce)throw new Error('Unsafe type-impact peer cleanup');await fs.rm(real,{recursive:true,force:false});});
  const files=[['NativeModelQueries.cs',queries],['NativeParameterQueries.cs',parameters],['shared-peers.cs',peers],['impact-peers.cs',impactPeers]];
  await Promise.all(files.map(([name,value])=>fs.writeFile(path.join(directory,name),value,{flag:'wx'})));
  const executable=path.join(directory,'type-impact.exe');
  try{await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Core.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,...files.map(([name])=>path.join(directory,name))],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(error){throw new Error('Actual type-impact producer compilation failed: '+(error.stdout??'')+(error.stderr??''));}
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Type-impact peer timeout')),12000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024)finish(new Error('Type-impact peer response limit'));});child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)finish(new Error('Type-impact peer diagnostic limit'));});
    child.once('error',finish);child.stdin.on('error',finish);child.once('close',code=>{if(code!==0)return finish(new Error('Type-impact peer exit '+code+': '+stderr));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){finish(error);}});child.stdin.end(JSON.stringify(input));
  });
  produce.sourceEvidence={querySourceSha256:sha(parameters),sharedQuerySourceSha256:sha(queries),parameterDescriptorSha256:sha(descriptor),internalValueSha256:sha(internalValue),sharedPeersSha256:sha(sharedPeers),impactPeersSha256:sha(impactPeers),scope:'Complete unchanged production queries, shared exact-ID parser, scan/response/time budget and descriptor; controlled API peer instrumentation only; no Autodesk load, setter APIs, transactions or real Revit/model'};
  return produce;
}
