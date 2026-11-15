import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const nativeProducerAvailable = process.platform === 'win32';
const runFile = promisify(execFile);
const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const hash = text => createHash('sha256').update(text).digest('hex');

// Fail closed if a production boundary disappears or becomes ambiguous. The
// scanner counts C# braces while excluding comments and string/char literals.
function uniqueStart(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw new Error('Missing or ambiguous production boundary: ' + marker);
  return start;
}
function braceEnd(source, start) {
  let depth = 0, state = 'code';
  for (let i = start; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === 'line') { if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; i++; } continue; }
    if (state === 'verbatim') { if (c === '"') { if (next === '"') i++; else state = 'code'; } continue; }
    if (state === 'string' || state === 'char') {
      if (c === '\\') { i++; continue; }
      if (c === (state === 'string' ? '"' : "'")) state = 'code';
      continue;
    }
    if (c === '/' && next === '/') { state = 'line'; i++; continue; }
    if (c === '/' && next === '*') { state = 'block'; i++; continue; }
    if (c === '@' && next === '"') { state = 'verbatim'; i++; continue; }
    if (c === '"') { state = 'string'; continue; }
    if (c === "'") { state = 'char'; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('Unclosed production C# block');
}
function block(source, marker) {
  const start = uniqueStart(source, marker), open = source.indexOf('{', start);
  if (open < 0) throw new Error('No production block: ' + marker);
  const end = braceEnd(source, open);
  return {start, open, end, text: source.slice(start, end)};
}
function statement(source, marker) {
  const start = uniqueStart(source, marker), end = source.indexOf(';', start);
  if (end < 0) throw new Error('Missing production declaration terminator');
  return source.slice(start, end + 1);
}

function harness({readBranch, writeBranch, scriptFailure, boundedFailureError, freeze, scriptParameters, expectedDocument, requireDocument, readOperations, writeOperations, isRead, isWrite, isParameterRead}) {
  return `using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Controlled peers only: no Autodesk assembly, Revit process, real model,
// runtime directory, server, transaction, network or external provider loads.
internal sealed class Document {
  internal string Title, PathName;
  internal bool IsModified, AllowedSample;
  internal int Mutations;
}
internal sealed class UIDocument { internal Document Document; }
internal sealed class UIApplication { internal UIDocument ActiveUIDocument; }
internal static class Control {
  internal static object Value;
  internal static string FailureMessage;
  internal static bool Fail, RollbackUnknown;
  internal static int ReadCalls, WriteCalls, Commits, Rollbacks;
}
internal static class NativeParameterQueries {
  ${isParameterRead}
}
internal static class WorkbenchActions {
  ${readOperations}
  ${writeOperations}
  ${isRead}
  ${isWrite}
  internal static object Read(UIApplication uiapp, string operation, Dictionary<string,object> args) {
    Control.ReadCalls++;
    if (Control.Fail) throw new InvalidOperationException("Controlled read failure.");
    return Control.Value;
  }
  internal static object Write(UIApplication uiapp, string operation, Dictionary<string,object> args) {
    Control.WriteCalls++;
    uiapp.ActiveUIDocument.Document.IsModified = true;
    uiapp.ActiveUIDocument.Document.Mutations++;
    if (Control.Fail) throw new InvalidOperationException(Control.FailureMessage ?? "Controlled write failure.");
    return Control.Value;
  }
}
internal enum TransactionStatus { Uninitialized, Started, Committed, RolledBack }
internal sealed class TransactionGroup : IDisposable {
  private readonly Document doc;
  private readonly bool originalModified;
  private readonly int originalMutations;
  private TransactionStatus status;
  internal TransactionGroup(Document document, string name) { doc=document;originalModified=doc.IsModified;originalMutations=doc.Mutations; }
  internal TransactionStatus Start() { status=TransactionStatus.Started;return status; }
  internal TransactionStatus Assimilate() { Control.Commits++;status=TransactionStatus.Committed;return status; }
  internal TransactionStatus RollBack() { Control.Rollbacks++;if(Control.RollbackUnknown){status=TransactionStatus.Uninitialized;return status;}doc.IsModified=originalModified;doc.Mutations=originalMutations;status=TransactionStatus.RolledBack;return status; }
  internal TransactionStatus GetStatus() { return status; }
  public void Dispose() { if(status==TransactionStatus.Started)RollBack(); }
}
internal static class ScriptRunner { internal static object Execute(UIApplication app,string code,string id,IDictionary<string,object> parameters) { return WorkbenchActions.Write(app,"execute_csharp",null); } }
internal static class ArgusTools {
  internal static object Annotate(UIApplication app,Dictionary<string,object> args) { return WorkbenchActions.Write(app,"smart_annotate",args); }
  internal static object Schematic(UIApplication app,Dictionary<string,object> args) { return WorkbenchActions.Write(app,"build_schematic",args); }
}
internal static class SchematicRevitService { internal static object Export(UIApplication app,Dictionary<string,object> args) { return WorkbenchActions.Write(app,"export_schematic",args); } }

internal sealed class Producer {
  private readonly string session;
  private readonly JavaScriptSerializer json = new JavaScriptSerializer {MaxJsonLength=1024*1024,RecursionLimit=40};
  internal Producer(string value) { session=value; }
  ${scriptFailure}
  ${boundedFailureError}
  internal static object ErrorReceipt(Exception failure) { Exception cause=failure is ScriptExecutionFailure?failure.InnerException:failure;return BoundedFailureError(cause.GetType().Name,cause.Message); }
  internal object Produce(UIApplication uiapp,string operation,Dictionary<string,object> args) {
    Document doc=uiapp.ActiveUIDocument==null?null:uiapp.ActiveUIDocument.Document;
    string id="controlled-native-producer";
    object access=null;
    // Original production IsRead block, including its returned DTO:
    ${readBranch}
    // Original production operation admission, transaction and write result:
    ${writeBranch}
  }
  ${freeze}
  ${scriptParameters}
  ${expectedDocument}
  ${requireDocument}
  private static string Text(Dictionary<string,object> values,string key,string fallback="") { object value;return values.TryGetValue(key,out value)?Convert.ToString(value):fallback; }
  // This peer isolates dispatch/transaction behavior. The real access-policy
  // implementation is executed separately by tests/native-access-policy.test.mjs.
  private static void RequireProjectEdit(Document doc,string expected,object access) { RequireDocument(doc,expected);if(!doc.AllowedSample)throw new InvalidOperationException("Controlled document is not an allowed project."); }
}
internal static class Program {
  private static string StringValue(Dictionary<string,object> values,string key,string fallback) { object value;return values.TryGetValue(key,out value)?Convert.ToString(value):fallback; }
  private static bool BoolValue(Dictionary<string,object> values,string key,bool fallback) { object value;return values.TryGetValue(key,out value)&&value is bool?(bool)value:fallback; }
  public static int Main() {
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    var json=new JavaScriptSerializer {MaxJsonLength=1024*1024,RecursionLimit=40};
    var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
    object rawDoc;var facts=input.TryGetValue("document",out rawDoc)?rawDoc as Dictionary<string,object>:new Dictionary<string,object>();
    if(facts==null)facts=new Dictionary<string,object>();
    var doc=new Document {Title=StringValue(facts,"title","Atomic sample"),PathName=StringValue(facts,"path",@"D:\\samples\\atomic.rvt"),IsModified=BoolValue(facts,"modified",false),AllowedSample=BoolValue(facts,"allowedSample",true)};
    bool beforeModified=doc.IsModified;
    object rawArgs;var args=input.TryGetValue("args",out rawArgs)?rawArgs as Dictionary<string,object>:new Dictionary<string,object>();
    if(args==null)args=new Dictionary<string,object>();
    bool noDocument=BoolValue(input,"noDocument",false);
    if(!args.ContainsKey("expected_document")&&!noDocument)args["expected_document"]=doc.PathName;
    object nativeValue;Control.Value=input.TryGetValue("value",out nativeValue)?nativeValue:null;Control.Fail=BoolValue(input,"fail",false);Control.RollbackUnknown=BoolValue(input,"rollbackUnknown",false);Control.FailureMessage=StringValue(input,"failureMessage",null);
    object result=null,error=null;bool ok=false;
    try { result=new Producer(StringValue(input,"session",new string('d',32))).Produce(new UIApplication {ActiveUIDocument=noDocument?null:new UIDocument {Document=doc}},StringValue(input,"operation","get_selection"),args);ok=true; }
    catch(Exception failure) { var transactionProperty=failure.GetType().GetProperty("TransactionReceipt");error=new {type=failure.GetType().Name,message=failure.Message,receipt=Producer.ErrorReceipt(failure),transaction=transactionProperty==null?null:transactionProperty.GetValue(failure,null)}; }
    Console.WriteLine(json.Serialize(new {ok,result,error,facts=new {readCalls=Control.ReadCalls,writeCalls=Control.WriteCalls,commits=Control.Commits,rollbacks=Control.Rollbacks,modifiedBefore=beforeModified,modifiedAfter=doc.IsModified,mutations=doc.Mutations,scope="Controlled API peers; actual production dispatch branches and serialization; no real Revit modification"}}));
    return 0;
  }
}`;
}

async function runProducer(executable, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {cwd:path.dirname(executable),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='', stderr='', done=false;
    const fail=error=>{if(done)return;done=true;clearTimeout(timer);child.kill();reject(error);};
    const timer=setTimeout(()=>fail(new Error('Controlled native producer timed out')),10000);
    child.on('error',fail);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{stdout+=part;if(stdout.length>2*1024*1024)fail(new Error('Controlled native producer output exceeded budget'));});
    child.stderr.on('data',part=>{stderr+=part;if(stderr.length>16384)fail(new Error('Controlled native producer stderr exceeded budget'));});
    child.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code!==0)return reject(new Error('Controlled native producer exited '+code+': '+stderr));try{resolve(JSON.parse(stdout.replace(/^\uFEFF/,'').trim()));}catch(error){reject(new Error('Invalid controlled native JSON: '+error.message));}});
    child.stdin.on('error',fail);
    child.stdin.end(JSON.stringify(input));
  });
}

/** Compile exact source branches into controlled peers, then return their DTO. */
export async function loadNativeReadProducer(t, {hostPath=path.join(stage,'revit-addin','WorkbenchHost.cs')}={}) {
  if(!nativeProducerAvailable)throw new Error('Native producer tests require Windows with the existing .NET Framework compiler');
  const [source,actions,parameterQueries]=await Promise.all([fs.readFile(hostPath,'utf8'),fs.readFile(path.join(stage,'revit-addin','WorkbenchActions.cs'),'utf8'),fs.readFile(path.join(stage,'revit-addin','NativeParameterQueries.cs'),'utf8')]);
  const read=block(source,'if (WorkbenchActions.IsRead(operation))');
  const dispatch=block(source,'private object Dispatch(');
  if(read.start<dispatch.open||read.end>=dispatch.end)throw new Error('Read producer is outside actual Dispatch');
  const writeStart=source.indexOf('if (operation != "execute_csharp"',read.end);
  if(writeStart<read.end||writeStart>=dispatch.end)throw new Error('Missing original write admission boundary');
  const fragments={readBranch:read.text,writeBranch:source.slice(writeStart,dispatch.end-1).trim(),scriptFailure:block(source,'private sealed class ScriptExecutionFailure').text,boundedFailureError:block(source,'private static Dictionary<string, object> BoundedFailureError(').text,freeze:block(source,'private object FreezeResult(').text,scriptParameters:block(source,'private static IDictionary<string, object> ScriptParameters(').text,expectedDocument:block(source,'private static string ExpectedDocument(').text,requireDocument:block(source,'private static void RequireDocument(').text,readOperations:statement(actions,'internal static readonly string[] ReadOperations ='),writeOperations:statement(actions,'internal static readonly string[] WriteOperations ='),isRead:block(actions,'internal static bool IsRead(').text,isWrite:block(actions,'internal static bool IsWrite(').text};
  fragments.isParameterRead=block(parameterQueries,'internal static bool IsRead(').text;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-native-read-producer-'));
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('buildx-native-read-producer-'))throw new Error('Unsafe controlled compiler cleanup target');await fs.rm(resolved,{recursive:true,force:true});});
  const generated=path.join(directory,'producer.cs'),executable=path.join(directory,'producer.exe');
  await fs.writeFile(generated,harness(fragments),'utf8');
  try { await runFile(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/reference:'+path.join(framework,'System.Core.dll'),'/out:'+executable,generated],{cwd:directory,windowsHide:true,timeout:20000,maxBuffer:1024*1024}); }
  catch(error){throw new Error('Controlled native producer compilation failed: '+(error.stdout??'')+(error.stderr??'')+error.message);}
  const inspect=input=>runProducer(executable,input);
  const produce=async input=>{const observed=await inspect(input);if(!observed.ok){const error=new Error(observed.error?.message??'Native producer failed');error.nativeType=observed.error?.type;error.nativeFacts=observed.facts;throw error;}return observed.result;};
  produce.inspect=inspect;
  produce.sourceEvidence={hostPath,hostSha256:hash(source),actionsSha256:hash(actions),fragments:Object.fromEntries(Object.entries(fragments).map(([name,text])=>[name,{sha256:hash(text),characters:text.length}])),scope:'Exact production query/write dispatch branches with controlled Revit peers; no real-model write verification'};
  return produce;
}
