import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('Revit template directory is observed without guessing, and changes invalidate the old location', {skip:process.platform!=='win32'},()=>{
  const root=path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const source=readFileSync(path.join(root,'family-core/revit/RevitFamilyWorkflow.cs'),'utf8');
  const extracted=source.match(/\/\/ BEGIN REVIT CONFIGURED TEMPLATE SOURCE\s*([\s\S]*?)\s*\/\/ END REVIT CONFIGURED TEMPLATE SOURCE/);
  assert.ok(extracted,'production source must expose its template ownership boundary');
  const temp=mkdtempSync(path.join(tmpdir(),'buildx-configured-template-'));
  try{
    const program=`using System; using System.IO; using BuildX.FamilyCore;
namespace BuildX.FamilyRevit {
${extracted[1]}
static class Test {
static void Check(bool value) { if(!value) throw new Exception("template assertion failed"); }
static void Main(string[] args) {
  string first=Path.Combine(args[0],"first"), second=Path.Combine(args[0],"second");
  Directory.CreateDirectory(first); Directory.CreateDirectory(second);
  string configured=null; bool fail=false;
  var source=new RevitConfiguredTemplateSource(delegate { if(fail) throw new InvalidOperationException(); return configured; });
  Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.Unknown);
  Check(source.Inspect("not-a-template").Issue==FamilyTemplateIssue.UnknownId);
  configured="relative"; Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.Unknown);
  configured=@"\\\\server\\templates"; Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.Unknown);
  configured=first;
  Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.NotFound);
  File.WriteAllText(Path.Combine(first,"公制常规模型.rft"),"first-template");
  var a=source.Inspect("metric-generic-model"); Check(a.State==FamilyTemplateState.BytesVerified && a.SourcePath==Path.Combine(first,"公制常规模型.rft"));
  Check(source.Inspect("metric-mechanical-equipment").State==FamilyTemplateState.NotFound);
  configured=second; Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.NotFound);
  File.WriteAllText(Path.Combine(second,"公制常规模型.rft"),"second-template");
  var b=source.Inspect("metric-generic-model"); Check(b.State==FamilyTemplateState.BytesVerified && b.SourcePath!=a.SourcePath && b.Sha256!=a.Sha256);
  fail=true; Check(source.Inspect("metric-generic-model").State==FamilyTemplateState.Unknown);
  fail=false; configured=first; Check(source.Inspect("metric-generic-model").SourcePath==a.SourcePath);
} } }`;
    const cs=path.join(temp,'test.cs'),exe=path.join(temp,'test.exe');
    writeFileSync(cs,program);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',[
      '/nologo','/langversion:5','/utf8output',`/out:${exe}`,
      path.join(root,'family-core/FamilyTemplateFacts.cs'),path.join(root,'family-core/FamilyTemplateCatalog.cs'),cs,
    ]);
    execFileSync(exe,[temp]);
  }finally{
    assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith('buildx-configured-template-'));
    rmSync(temp,{recursive:true,force:true});
  }
});
