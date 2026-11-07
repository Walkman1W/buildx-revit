import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';

// Compile the real configuration owner without Revit, WPF, services or model
// peers. All configuration files written by this harness stay in its own tree.
export async function loadNativeInstallationProducer(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-installation-layout-'));
  const root=path.join(directory,'program'),bin=path.join(root,'revit-addin','bin');
  await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(root,'server.mjs'),'// configuration fixture only\n');
  const source=await fs.readFile(new URL('../revit-addin/LocalCodexRevit.cs',import.meta.url),'utf8');
  const parts=source.split('// BEGIN BUILDX INSTALLATION');
  if(parts.length!==2||parts[1].split('// END BUILDX INSTALLATION').length!==2)throw new Error('Ambiguous production installation owner');
  const owner=parts[1].split('// END BUILDX INSTALLATION')[0];
  const generated=`using System;using System.IO;using System.Runtime.Serialization;using System.Runtime.Serialization.Json;using System.Collections.Generic;using System.Web.Script.Serialization;
namespace RevitLocalCodex { ${owner}
internal static class Program {
 public static void Main(string[] args) {
  var json=new JavaScriptSerializer();var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
  string root=args[0],file=Path.Combine(root,"buildx-installation.json");object text;
  if(input.TryGetValue("configurationText",out text))File.WriteAllText(file,Convert.ToString(text));else if(File.Exists(file))File.Delete(file);
  try {
   string assembly=Path.Combine(root,"revit-addin","bin","LocalCodexRevit.dll");
   var value=BuildXInstallation.FromAssemblyLocation(assembly);
   var navigation=new List<bool>();object addresses;
   if(input.TryGetValue("navigation",out addresses))foreach(object address in (System.Collections.IEnumerable)addresses)navigation.Add(value.AllowsPanelNavigation(address as string));
   Console.WriteLine(json.Serialize(new {ok=true,root=value.Root,dataRoot=value.DataRoot,workbenchRoot=value.WorkbenchRoot,webViewUserDataFolder=value.WebViewUserDataFolder,schemaVersion=value.SchemaVersion,panelPort=value.PanelPort,panelAddress=value.PanelAddress,navigation,developmentMode=value.DevelopmentMode,installationId=value.InstallationId,nodeExecutable=value.NodeExecutable,pythonExecutable=value.PythonExecutable,codexExecutable=value.CodexExecutable,matchesSelf=value.MatchesService("revit-local-codex",value.InstallationId),matchesMissing=value.MatchesService("revit-local-codex",null),matchesOther=value.MatchesService("other",value.InstallationId)}));
  } catch(Exception error) {Console.WriteLine(json.Serialize(new {ok=false,error=error.GetType().Name}));}
 }
}}`;
  const cs=path.join(directory,'producer.cs'),executable=path.join(directory,'producer.exe');await fs.writeFile(cs,generated);
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('buildx-installation-layout-'))throw new Error('Unsafe configuration fixture cleanup');await fs.rm(resolved,{recursive:true,force:true});});
  await execute(path.join(framework,'csc.exe'),['/nologo','/langversion:5','/utf8output','/reference:'+path.join(framework,'System.Runtime.Serialization.dll'),'/reference:'+path.join(framework,'System.Web.Extensions.dll'),'/out:'+executable,cs],{windowsHide:true,timeout:20000});
  const produce=input=>new Promise((resolve,reject)=>{
    const child=spawn(executable,[root],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Native installation producer timed out'));},5000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Native installation producer exited '+code+': '+stderr));try{resolve(JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify(input));
  });
  produce.root=root;produce.directory=directory;produce.sourceEvidence={source:'revit-addin/LocalCodexRevit.cs',sourceSha256:createHash('sha256').update(source).digest('hex'),ownerSha256:createHash('sha256').update(owner).digest('hex'),scope:'Actual C# installation parser, layout, configured panel address and navigation owner; filesystem fixtures only, no Revit or service starts'};
  return produce;
}
