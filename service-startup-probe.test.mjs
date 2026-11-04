import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Compile the actual launcher and identity parser, without loading Revit or
// substituting HttpClient. Temporary evidence is retained for inspection.
test('production .NET launcher checks identity and recovers an absent service', {skip:process.platform!=='win32',timeout:45000},async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'buildx-service-probe-'));
  const source=readFileSync(new URL('./revit-addin/LocalCodexRevit.cs',import.meta.url),'utf8');
  const begin=source.indexOf('    // BEGIN SERVICE STARTUP DIAGNOSTIC');
  assert.ok(begin>0);
  const producer=source.slice(begin,source.lastIndexOf('\n}'));
  const program=`using System; using System.IO; using System.Diagnostics; using System.Net.Http; using System.Net.Sockets; using System.Reflection; using System.Runtime.Serialization; using System.Runtime.Serialization.Json; using System.Text; using System.Threading.Tasks;
namespace RevitLocalCodex {
static class App { internal static string PanelAddress; internal static string ErrorCode(Exception e){return e.HResult.ToString("X8");} }
${producer}
class Test {
static int Main(string[] args) { try { Run(args).GetAwaiter().GetResult(); return 0; } catch(Exception e) { Console.Error.WriteLine(e); return 1; } }
static async Task Run(string[] args) {
 App.PanelAddress=args[0];
 var flags=BindingFlags.Static|BindingFlags.NonPublic;
 var constructor=typeof(BuildXInstallation).GetConstructors(BindingFlags.Instance|BindingFlags.NonPublic)[0];
 var config=constructor.Invoke(new object[]{args[1],args[4]=="null"?null:args[4],args[2],null,null,args[4]=="null"});
 typeof(LocalService).GetField("installation",flags).SetValue(null,config);
 int absent=0;
 try {
  string error=await LocalService.EnsureAvailableAsync(args[3]!="probe",delegate{absent++;});
  if(error==null && args[3]=="restart"){
   var owner=typeof(LocalService).GetField("launchedProcess",flags).GetValue(null);
   var child=(Process)owner.GetType().GetField("process",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(owner);
   child.Kill();if(!child.WaitForExit(5000))throw new Exception("Prior test child exit unconfirmed");
  }
  string again=error==null?await LocalService.EnsureAvailableAsync(true,delegate{absent++;}):error;
  Console.WriteLine("{\\"ok\\":"+(error==null?"true":"false")+",\\"again\\":"+(again==null?"true":"false")+",\\"absent\\":"+absent+"}");
 } finally {
  var owner=typeof(LocalService).GetField("launchedProcess",flags).GetValue(null);
  if(owner!=null){
   var child=(Process)owner.GetType().GetField("process",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(owner);
   if(!child.HasExited){child.Kill();if(!child.WaitForExit(5000))throw new Exception("Test child cleanup unconfirmed");}
   LocalService.ReleaseHandle();
  }
 }
}
}}
`;
  const cs=path.join(directory,'probe.cs'),exe=path.join(directory,'probe.exe');
  writeFileSync(cs,program);
  const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  execFileSync(path.join(framework,'csc.exe'),['/nologo','/langversion:5',`/out:${exe}`,`/reference:${framework}\\System.Net.Http.dll`,`/reference:${framework}\\System.Runtime.Serialization.dll`,cs]);
  async function run(url,{start=false,restart=false,id=null}={}){
    return await new Promise((resolve,reject)=>{
      const child=spawn(exe,[url,directory,process.execPath,restart?'restart':start?'start':'probe',id??'null'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr)));
    });
  }
  async function fixture(fn){
    const requests=[],sockets=new Set();
    const server=http.createServer((req,res)=>{requests.push(req.url);fn(req,res);});
    server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {url:`http://127.0.0.1:${server.address().port}/`,requests,close:()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(resolve);})};
  }
  await t.test('large dynamic status does not participate in service identity',async()=>{
    const f=await fixture((req,res)=>res.end(JSON.stringify({service:'revit-local-codex',installationId:null,...req.url==='/api/status'?{toolCatalog:'x'.repeat(12000)}:{}})));
    try {assert.deepEqual(await run(f.url),{ok:true,again:true,absent:0});assert.deepEqual(f.requests,['/api/service-identity','/api/service-identity']);} finally {await f.close();}
  });
  await t.test('installed identity must match exactly',async()=>{
    const id='aa159a01-0b21-4da8-95ab-8f2488a24ffe';
    const f=await fixture((req,res)=>res.end(JSON.stringify({service:'revit-local-codex',installationId:id})));
    try {assert.equal((await run(f.url,{id})).ok,true);assert.deepEqual(await run(f.url,{start:true}),{ok:false,again:false,absent:0});} finally {await f.close();}
  });
  for(const mode of ['wrong-service','missing-installation','malformed','oversized','redirect','timeout'])await t.test(mode+' never starts another service',async()=>{
    const f=await fixture((req,res)=>{
      if(mode==='timeout')return;
      if(mode==='redirect'){res.writeHead(302,{Location:'/api/status'});res.end();return;}
      if(mode==='missing-installation'){res.end(JSON.stringify({service:'revit-local-codex'}));return;}
      res.end(mode==='malformed'?'{':JSON.stringify({service:mode==='wrong-service'?'other':'revit-local-codex',installationId:null,...mode==='oversized'?{extra:'x'.repeat(9000)}:{}}));
    });
    try {assert.deepEqual(await run(f.url,{start:true}),{ok:false,again:false,absent:0});assert.equal(f.requests.length,1);} finally {await f.close();}
  });
  await t.test('connection refusal starts the configured child once, then reuses it',async()=>{
    const free=await fixture((req,res)=>res.end());const url=free.url;await free.close();
    assert.deepEqual(await run(url),{ok:false,again:false,absent:1});
    writeFileSync(path.join(directory,'server.mjs'),`import http from 'node:http';http.createServer((req,res)=>res.end(JSON.stringify({service:'revit-local-codex',installationId:null}))).listen(${new URL(url).port},'127.0.0.1');`);
    assert.deepEqual(await run(url,{start:true}),{ok:true,again:true,absent:1});
    assert.deepEqual(await run(url,{restart:true}),{ok:true,again:true,absent:2});
  });
  t.diagnostic('Retained .NET producer harness: '+directory);
});
