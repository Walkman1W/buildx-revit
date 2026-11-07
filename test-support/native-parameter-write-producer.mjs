import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
const sha=value=>createHash('sha256').update(value).digest('hex');
const framework=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
function start(source,marker){const index=source.indexOf(marker);if(index<0||source.indexOf(marker,index+marker.length)>=0)throw new Error('Missing or ambiguous production boundary: '+marker);return index;}
function endBlock(source,open){
  let depth=0,state='code';
  for(let i=open;i<source.length;i++){
    const c=source[i],next=source[i+1];
    if(state==='line'){if(c==='\n')state='code';continue;}
    if(state==='comment'){if(c==='*'&&next==='/'){state='code';i++;}continue;}
    if(state==='verbatim'){if(c==='"'){if(next==='"')i++;else state='code';}continue;}
    if(state==='string'||state==='char'){if(c==='\\'){i++;continue;}if(c===(state==='string'?'"':"'"))state='code';continue;}
    if(c==='/'&&next==='/'){state='line';i++;continue;}if(c==='/'&&next==='*'){state='comment';i++;continue;}
    if(c==='@'&&next==='"'){state='verbatim';i++;continue;}if(c==='"'){state='string';continue;}if(c==="'"){state='char';continue;}
    if(c==='{')depth++;else if(c==='}'&&--depth===0)return i+1;
  }
  throw new Error('Unclosed production C# block');
}
function block(source,marker){const begin=start(source,marker),open=source.indexOf('{',begin),end=endBlock(source,open);return {begin,end,text:source.slice(begin,end)};}
function declaration(source,marker){const begin=start(source,marker);return source.slice(begin,source.indexOf(';',begin)+1);}

/** Exact production setter, transaction and host write branch with controlled API peers. */
export async function loadNativeParameterWriteProducer(t){
  if(process.platform!=='win32')throw new Error('Parameter-write peers require Windows .NET Framework compiler');
  const [actions,host,peers,queries,material]=await Promise.all(['revit-addin/WorkbenchActions.cs','revit-addin/WorkbenchHost.cs','test-support/native-parameter-write-peers.cs','revit-addin/NativeModelQueries.cs','revit-addin/MaterialAssignment.cs'].map(name=>fs.readFile(path.join(root,name),'utf8')));
  const writeStart=start(actions,'internal static object Write('),writeEnd=start(actions,'private static object TransformElements(');
  if(writeEnd<=writeStart)throw new Error('Production parameter-write region reversed');
  const fragments={parameterWrite:actions.slice(writeStart,writeEnd).trim(),materialAssignment:['private sealed class MaterialAssignmentExpectation','private static Parameter MaterialInstanceParameter(','private static object SetElementMaterial(','private static long ExactMaterialOldValue(','private static void VerifyElementMaterial('].map(marker=>block(material,marker).text).join('\n')};
  for(const marker of ['private static object DescribedId(','private static object DescribeElement(','private static object InternalValue(','private static Element RequiredElement(','private static object Required(','private static IList RequiredList(','private static string OptionalString(','private static long ElementIdValue(','private static long Integer(','private static double FiniteNumber(','private static void Fields(','private sealed class RejectErrors'])fragments[marker]=block(actions,marker).text;
  fragments.writeOperations=declaration(actions,'internal static readonly string[] WriteOperations =');
  fragments.isWrite=block(actions,'internal static bool IsWrite(').text;
  const dispatch=block(host,'private object Dispatch('),read=block(host,'if (WorkbenchActions.IsRead(operation))');
  const branchStart=host.indexOf('if (operation != "execute_csharp"',read.end);
  if(branchStart<=dispatch.begin||branchStart>=dispatch.end)throw new Error('Production host write boundary invalid');
  fragments.hostWrite=host.slice(branchStart,dispatch.end-1).trim();
  for(const marker of ['private sealed class ScriptExecutionFailure','private static Dictionary<string, object> BoundedFailureError(','private object FreezeResult(','private static IDictionary<string, object> ScriptParameters(','private static string ExpectedDocument(','private static void RequireDocument('])fragments[marker]=block(host,marker).text;
  const actionText=Object.entries(fragments).filter(([key])=>key!=='hostWrite'&&!key.startsWith('private sealed class ScriptExecutionFailure')&&!key.startsWith('private static Dictionary')&&!key.startsWith('private object Freeze')&&!key.startsWith('private static IDictionary')&&!key.startsWith('private static string ExpectedDocument')&&!key.startsWith('private static void RequireDocument')).map(([,value])=>value).join('\n');
  const hostText=Object.entries(fragments).filter(([key])=>key.startsWith('private sealed class ScriptExecutionFailure')||key.startsWith('private static Dictionary')||key.startsWith('private object Freeze')||key.startsWith('private static IDictionary')||key.startsWith('private static string ExpectedDocument')||key.startsWith('private static void RequireDocument')).map(([,value])=>value).join('\n');
  const exactIdFragments=Object.fromEntries(['internal static string SignedId(','internal static long ExactId(','internal static long ExactSignedId(','private static long RequiredId('].map(marker=>[marker,block(queries,marker).text]));
  const generated=peers.replace('// PRODUCTION_ACTION_METHODS',actionText).replace('// PRODUCTION_HOST_METHODS',hostText).replace('// PRODUCTION_HOST_WRITE_BRANCH',fragments.hostWrite).replace('// PRODUCTION_EXACT_ID_METHODS',Object.values(exactIdFragments).join('\n'));
  if(generated.includes('// PRODUCTION_'))throw new Error('Unreplaced production peer marker');
  const tempRoot=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(tempRoot,'buildx-native-parameter-write-')),nonce=randomUUID();
  await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({kind:'native-parameter-write-peers',nonce}),{flag:'wx'});
  t.after(async()=>{const resolved=path.resolve(directory),real=await fs.realpath(directory),owner=JSON.parse(await fs.readFile(path.join(directory,'owner.json'),'utf8')),stat=await fs.lstat(directory);if(real!==resolved||path.dirname(real)!==tempRoot||!path.basename(real).startsWith('buildx-native-parameter-write-')||!stat.isDirectory()||stat.isSymbolicLink()||owner.kind!=='native-parameter-write-peers'||owner.nonce!==nonce)throw new Error('Unsafe parameter-write peer cleanup');await fs.rm(real,{recursive:true,force:false});});
  const sourceFile=path.join(directory,'producer.cs'),executable=path.join(directory,'producer.exe');
  await fs.writeFile(sourceFile,generated,{flag:'wx'});
  try{await run(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Core.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,sourceFile],{cwd:directory,windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
  catch(error){throw new Error('Actual parameter-write production compilation failed: '+(error.stdout??'')+(error.stderr??''));}
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Parameter-write peers timeout')),10000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1024*1024)finish(new Error('Parameter-write peers output limit'));});child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)finish(new Error('Parameter-write peers diagnostics limit'));});
    child.once('error',finish);child.stdin.on('error',finish);child.once('close',code=>{if(code!==0)return finish(new Error('Parameter-write peers exit '+code+': '+stderr));try{finish(null,JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){finish(error);}});child.stdin.end(JSON.stringify(input));
  });
  produce.sourceEvidence={actionsSha256:sha(actions),hostSha256:sha(host),peersSha256:sha(peers),exactIdSourceSha256:sha(queries),exactIdFragments:Object.fromEntries(Object.entries(exactIdFragments).map(([name,value])=>[name,{sha256:sha(value),characters:value.length}])),generatedSha256:sha(generated),fragments:Object.fromEntries(Object.entries(fragments).map(([name,value])=>[name,{sha256:sha(value),characters:value.length}])),scope:'Exact production Write/SetParameters/shared ID parser/helpers and Host write transaction-group branch; API, access policy and other providers are controlled peers; no Autodesk load or real Revit/model execution'};
  produce.extractedSource=generated;
  return produce;
}
