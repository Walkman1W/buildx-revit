import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('compiled host route defaults closed; isolated fixture returns correct envelopes', async () => {
 const s=await readFile(new URL('revit-addin/WorkbenchHost.cs',import.meta.url),'utf8');
 const start=s.indexOf('            if (operation == "batch_set_parameters_by_filter")');
 const end=s.indexOf('            if (operation == "set_type_parameter")',start);
 assert.ok(start>=0&&end>start);
 const route=s.slice(start,end), dir=await mkdtemp(join(tmpdir(),'buildx-host-route-'));
 const program=`using System; using System.Collections.Generic;
class Document { public string Title="fixture"; }
class Test { static int calls; static string Text(Dictionary<string,object> a,string k,string f){return (string)a[k];} static object FreezeResult(object x){return x;} static object DispatchClosedBatchWriteCandidate(Document d,Dictionary<string,object> a,object x){calls++;return new { count=1 };}
static object Route(string operation, Document doc, Dictionary<string,object> args, object access){
${route}
throw new Exception("unknown"); }
static void Main(){var a=new Dictionary<string,object>();a["mode"]="commit";
#if BUILDX_BATCH_FIXTURE
var r=Route("batch_set_parameters_by_filter",new Document(),a,null);if(calls!=1 || !(bool)r.GetType().GetProperty("committed").GetValue(r,null))throw new Exception("commit");a["mode"]="rollback";r=Route("batch_set_parameters_by_filter",new Document(),a,null);if(calls!=2 || (bool)r.GetType().GetProperty("committed").GetValue(r,null))throw new Exception("rollback");
#else
try{Route("batch_set_parameters_by_filter",new Document(),a,null);throw new Exception("open");}catch(InvalidOperationException){} if(calls!=0)throw new Exception("candidate called");
#endif
}}`;
 const cs=join(dir,'route.cs'); await writeFile(cs,program);
 for(const fixture of [false,true]){const exe=join(dir,fixture?'fixture.exe':'closed.exe');const args=['/nologo','/target:exe',`/out:${exe}`,...fixture?['/define:BUILDX_BATCH_FIXTURE']:[],cs];const c=spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',args,{encoding:'utf8'});assert.equal(c.status,0,c.stdout+c.stderr);const run=spawnSync(exe,[],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);}
});
