import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native lifecycle token binds the reviewed state, operation, event version and expiry once',async t=>{
  const root=fileURLToPath(new URL('.',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-family-approval-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'Test.cs'),exe=path.join(directory,'Test.exe');
  await fs.writeFile(source,`
using System; using System.Web.Script.Serialization; using System.Collections.Generic; using BuildX.FamilyRevit;
class Check {
 static Dictionary<string,object> Issue(FamilyLifecycleApprovalBook b,string job,string state,DateTime at) { return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new JavaScriptSerializer().Serialize(b.Issue(job,state,new { shown=state },at))); }
 static void Assert(bool ok) { if (!ok) throw new Exception("assertion failed"); }
 static string Token(Dictionary<string,object> v,string k) { return (string)v[k]; }
 static void Main() {
  var now=new DateTime(2030,1,1,0,0,0,DateTimeKind.Utc); long tick=1000; var b=new FamilyLifecycleApprovalBook(()=>tick, 1000);
  var one=Issue(b,"job-1","state-A",now); var same=Issue(b,"job-1","state-A",now.AddSeconds(1));
  Assert(Token(one,"save_token")==Token(same,"save_token")); Assert(Token(one,"save_token")!=Token(one,"close_token"));
  Assert(!b.Consume("job-1","state-A","family_close_job",Token(one,"save_token"),now));
  Assert(!b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now));
  one=Issue(b,"job-1","state-A",now); Assert(!b.Consume("job-1","state-B","family_save_job",Token(one,"save_token"),now));
  one=Issue(b,"job-1","state-A",now); tick+=90000; Assert(!b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now.AddHours(-1)));
  one=Issue(b,"job-1","state-A",now); tick+=89999; Assert(b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now.AddYears(1)));
  one=Issue(b,"job-1","state-A",now); tick--; Assert(!b.Consume("job-1","state-A","family_close_job",Token(one,"close_token"),now));
  foreach(var change in new[]{"commit","undo","redo","view-change"}) { one=Issue(b,"job-1","state-A",now); b.Changed(); Assert(!b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now)); }
  one=Issue(b,"job-1","state-A",now); Assert(!b.Consume("job-2","state-A","family_save_job",Token(one,"save_token"),now));
  Assert(b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now)); Assert(!b.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now));
  one=Issue(b,"job-1","state-A",now); var restarted=new FamilyLifecycleApprovalBook(); Assert(!restarted.Consume("job-1","state-A","family_save_job",Token(one,"save_token"),now));
  one=Issue(b,"job-1","state-A",now); b.Disable(); Assert(!b.Consume("job-1","state-A","family_close_job",Token(one,"close_token"),now)); Assert(b.Issue("job-1","state-A",null,now)==null);
 }
}`);
  const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  execFileSync(compiler,['/nologo','/reference:System.Web.Extensions.dll','/out:'+exe,source,path.join(root,'family-core/revit/FamilyLifecycleApproval.cs')],{windowsHide:true,timeout:30000});
  const output=execFileSync(exe,[],{windowsHide:true,timeout:30000});assert.equal(output.toString(),'');
});

test('lifecycle review and owned resource cleanup do not require a current template', async () => {
  const root=fileURLToPath(new URL('.',import.meta.url));
  const source=await fs.readFile(path.join(root,'family-core/revit/RevitFamilyWorkflow.cs'),'utf8');
  const review=source.slice(source.indexOf('private object LifecycleReview('),source.indexOf('private void RequireLifecycleApproval('));
  const close=source.slice(source.indexOf('public FamilyCloseOutcome Close()'),source.indexOf('private sealed class RejectReplacement'));
  assert.match(review,/RequireJobProject\(/);
  assert.match(review,/template_current_verified = \(bool\?\)null/);
  assert.doesNotMatch(review,/RequireTemplate\(/);
  assert.doesNotMatch(close,/RequireTemplate\(/);
  assert.match(close,/Document\.Close\(false\)/);
  assert.match(source.slice(source.indexOf('private object Save('),source.indexOf('private object Load(')),/RequireTemplate\(record\)/);
  assert.match(source,/approval_validation = record == null \|\| operation == "family_inspect_job" \? null/);
});
