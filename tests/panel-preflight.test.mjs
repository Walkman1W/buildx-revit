import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn as spawnChild} from 'node:child_process';
import {createPanelPreflight,parsePanelSnapshot,PANEL_PREFLIGHT_LIMITS} from '../lib/panel-preflight.mjs';

const root=process.cwd(),powershellPath='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const config=()=>({root,powershellPath});
const empty=()=>({schemaVersion:1,complete:true,listeners:[],processes:[],ambiguousProcesses:[],unreadableNodeProcesses:0});
const bytes=value=>Buffer.from(JSON.stringify(value));
const parse=value=>parsePanelSnapshot(bytes(value),{root});
const processFact=(Role='model',ProcessId=10)=>({Role,ProcessId,ExecutablePath:'C:\\runtime\\node.exe',CreationDate:'2026-10-25T00:00:00.1234567Z',CommandLine:'"C:\\runtime\\node.exe" "'+root+'\\'+(Role==='model'?'server.mjs':'source-panel.mjs')+'"',CommandMatches:true});
function fixture({auto=true,closeOnKill=true,callbackError=false,...injection}={}){
  const children=[],launches=[];
  const spawn=(...args)=>{
    launches.push(args);const child=new EventEmitter();children.push(child);child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin.writable=true;child.writes=[];child.ends=0;child.kills=0;child.closeOnKill=closeOnKill;
    child.complete=(output=empty(),exit=0)=>{child.stdout.emit('data',Buffer.isBuffer(output)?output:bytes(output));child.stdout.emit('end');child.emit('exit',exit);child.emit('close',exit);};
    child.stdin.write=(line,callback)=>{child.writes.push(line);queueMicrotask(()=>callback?.(callbackError?new Error('PRIVATE callback EPIPE'):undefined));return true;};
    child.stdin.end=()=>{child.ends++;if(auto)queueMicrotask(()=>child.complete());};
    child.kill=()=>{child.kills++;if(child.closeOnKill)queueMicrotask(()=>{child.emit('exit',null);child.emit('close',null);});return child.closeOnKill;};
    return child;
  };
  const owner=createPanelPreflight(config(),{spawn,queryTimeoutMs:50,cleanupTimeoutMs:10,...injection});
  return {owner,children,launches,get child(){return children.at(-1);}};
}

test('strict snapshot retains IPv4/IPv6 wildcard listeners and exact named process facts',()=>{
  const value=empty();value.listeners=[{LocalAddress:'0.0.0.0',LocalPort:41873,OwningProcess:10},{LocalAddress:'::',LocalPort:41874,OwningProcess:11}];value.processes=[processFact(),processFact('source',11)];
  const result=parse(value);assert.equal(result.ok,true);assert.deepEqual(result.value,value);assert.ok(Object.isFrozen(result.value.processes[0]));assert.throws(()=>result.value.listeners.push({}));
});
test('explicit query failure is unknown rather than a successful empty process table',()=>{
  const result=parse({schemaVersion:1,complete:false,reason:'QUERY_FAILED'});assert.equal(result.ok,false);assert.equal(result.error.code,'PREFLIGHT_QUERY_FAILED');assert.equal(result.error.cleanupPending,false);
});
test('schema, non-JSON, concatenated documents, invalid UTF8 and frame overrun fail without echoing source',()=>{
  for(const value of [{...empty(),schemaVersion:2},{...empty(),complete:false},{...empty(),foreignCommandLine:'PRIVATE'},[],null])assert.equal(parse(value).error.code,'PREFLIGHT_RESPONSE_INVALID');
  for(const value of [Buffer.from('{PRIVATE'),Buffer.from('{}\n{}'),Buffer.from([0xff]),Buffer.alloc(128*1024+1)])assert.equal(parsePanelSnapshot(value,{root}).error.code,'PREFLIGHT_RESPONSE_INVALID');
});
test('listener scope and field shapes reject unknown ports, nonaddresses, PIDs and extra data',()=>{
  for(const change of [{LocalPort:80},{LocalAddress:'PRIVATE host'},{OwningProcess:0},{OwningProcess:'10'},{foreign:true}]){
    const value=empty();value.listeners=[{LocalAddress:'127.0.0.1',LocalPort:41873,OwningProcess:10,...change}];assert.equal(parse(value).error.code,'PREFLIGHT_RESPONSE_INVALID');
  }
});
test('process facts retain source strings but refuse missing command proof and invalid identities',()=>{
  for(const change of [{Role:'other'},{ProcessId:0},{ExecutablePath:'relative\\node.exe'},{ExecutablePath:'C:\\runtime\\other.exe'},{CreationDate:'not-a-date'},{CreationDate:'2026-02-30T00:00:00Z'},{CreationDate:'2026-01-01T00:00:00+14:59'},{CommandLine:''},{CommandLine:'PRIVATE\ncommand'},{CommandMatches:false},{extra:'PRIVATE'}]){
    const value=empty();value.processes=[{...processFact(),...change}];assert.equal(parse(value).error.code,'PREFLIGHT_RESPONSE_INVALID');
  }
});
test('ambiguous or unreadable node metadata blocks automatic launcher decisions',()=>{
  for(const value of [{...empty(),ambiguousProcesses:[{Role:'model',pid:10}]},{...empty(),unreadableNodeProcesses:1},{...empty(),processes:[processFact(),processFact('model',11)]},{...empty(),processes:[processFact(),processFact('source',10)]}])assert.equal(parse(value).error.code,'PREFLIGHT_IDENTITY_UNKNOWN');
});
test('configured scope and internal dependencies are captured once and cannot add a shell or another script',async()=>{
  const f=fixture();const result=await f.owner.snapshot();assert.equal(result.ok,true);
  const [exe,args,options]=f.launches[0];assert.equal(exe,powershellPath);assert.deepEqual(args,['-NoLogo','-NoProfile','-NonInteractive','-File',root+'\\tools\\Read-PanelSnapshot.ps1']);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.cwd,root);
  assert.equal(f.child.writes.length,1);assert.deepEqual(JSON.parse(f.child.writes[0]),{schemaVersion:1,root});assert.equal(f.child.ends,1);assert.equal(f.child.kills,0);assert.equal(f.owner.diagnostics().ownedChild,false);assert.equal((await f.owner.close()).value.closed,true);
});
test('invalid configuration rejects unsupported runners, relative paths and expanded scope',()=>{
  for(const value of [{root,powershellPath:'powershell.exe'},{root:'relative',powershellPath},{root,powershellPath:'C:\\runtime\\cmd.exe'},{...config(),args:['other']},null])assert.throws(()=>createPanelPreflight(value),{code:'PREFLIGHT_CONFIG_INVALID'});
  for(const deps of [{spawn:3},{queryTimeoutMs:5001},{cleanupTimeoutMs:1001},{shell:true}])assert.throws(()=>createPanelPreflight(config(),deps),{code:'PREFLIGHT_CONFIG_INVALID'});
});
test('configuration property getters and dependency functions are not re-read after validation',async()=>{
  let reads=0;const selected={get root(){reads++;return root;},powershellPath};
  const owner=createPanelPreflight(selected,{spawn:()=>{throw new Error('PRIVATE spawn');}});Object.defineProperty(selected,'root',{value:'C:\\foreign'});
  assert.equal((await owner.snapshot()).error.code,'PREFLIGHT_SPAWN_FAILED');assert.equal(reads,1);assert.equal(owner.diagnostics().ownedChild,false);assert.equal((await owner.close()).value.closed,true);
});
test('split UTF8 response and trailing newline parse after exit and close only',async()=>{
  const f=fixture({auto:false});const pending=f.owner.snapshot(),child=f.child;const output=bytes(empty());
  for(const byte of output)child.stdout.emit('data',Buffer.from([byte]));child.stdout.emit('data',Buffer.from('\r\n'));child.stdout.emit('end');child.emit('exit',0);
  assert.equal(f.owner.diagnostics().queryPending,true);child.emit('close',0);assert.equal((await pending).ok,true);await f.owner.close();
});
test('exit is not output closure and cannot release an incomplete diagnostic child',async()=>{
  const f=fixture({auto:false,closeOnKill:false,queryTimeoutMs:5});const pending=f.owner.snapshot(),child=f.child;child.stdout.emit('data',bytes(empty()));child.emit('exit',0);
  const result=await pending;assert.equal(result.error.code,'PREFLIGHT_TIMEOUT');assert.equal(result.error.cleanupPending,true);assert.equal(f.owner.diagnostics().ownedChild,true);assert.equal(child.kills,1);
  const retry=await f.owner.snapshot();assert.equal(retry.error.code,'PREFLIGHT_CLEANUP_PENDING');assert.equal(f.children.length,1);
  assert.equal((await f.owner.close()).error.cleanupPending,true);assert.equal((await f.owner.snapshot()).error.cleanupPending,true);child.emit('close',0);assert.equal((await f.owner.close()).value.closed,true);assert.equal(f.owner.diagnostics().ownedChild,false);
});
test('only observed exit zero and close can publish a successful snapshot',async()=>{
  for(const exit of [1,null]){const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.complete(empty(),exit);assert.equal((await pending).ok,false);assert.equal(f.owner.diagnostics().ownedChild,false);await f.owner.close();}
  const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.stdout.emit('data',bytes(empty()));f.child.emit('close',0);assert.equal((await pending).error.code,'PREFLIGHT_CHILD_FAILED');await f.owner.close();
});
for(const stream of ['stdin','stdout','stderr']){
  test(stream+' error is owned, bounded and never leaks raw exception text',async()=>{
    const f=fixture({auto:false});const pending=f.owner.snapshot();assert.doesNotThrow(()=>f.child[stream].emit('error',new Error('PRIVATE transport')));const result=await pending;assert.equal(result.error.code,'PREFLIGHT_PIPE_FAILED');assert.equal(result.error.cleanupPending,false);assert.equal(f.child.kills,1);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);await f.owner.close();
  });
}
test('asynchronous stdin callback failure cannot become an unhandled error',async()=>{
  const f=fixture({auto:false,callbackError:true});const launch=f.owner.snapshot();assert.equal((await launch).error.code,'PREFLIGHT_PIPE_FAILED');assert.equal(f.child.kills,1);await f.owner.close();
});
test('child error settles only after cleanup is observed',async()=>{
  const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.emit('error',new Error('PRIVATE exe path'));const result=await pending;assert.equal(result.error.code,'PREFLIGHT_SPAWN_FAILED');assert.equal(result.error.cleanupPending,false);await f.owner.close();
});
test('stdout overrun terminates only the exact child and never grows the retained buffer',async()=>{
  const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.stdout.emit('data',Buffer.alloc(128*1024+1,65));const result=await pending;assert.equal(result.error.code,'PREFLIGHT_STDOUT_LIMIT');assert.equal(f.child.kills,1);assert.equal(f.owner.diagnostics().ownedChild,false);await f.owner.close();
});
test('stderr is discarded, counted and capped without retaining diagnostic bodies',async()=>{
  const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.stderr.emit('data',Buffer.alloc(64*1024+1,65));const result=await pending;assert.equal(result.error.code,'PREFLIGHT_STDERR_LIMIT');assert.equal(f.owner.diagnostics().stderrBytesDiscarded,64*1024+1);assert.equal(JSON.stringify(f.owner.diagnostics()).includes('AAAA'),false);await f.owner.close();
});
test('malformed, partial or multiple JSON outputs cannot be reported as an empty system',async()=>{
  for(const output of [Buffer.from('{"complete":'),Buffer.from(JSON.stringify(empty())+'\n'+JSON.stringify(empty())),Buffer.from([0xff])]){
    const f=fixture({auto:false});const pending=f.owner.snapshot();f.child.complete(output);assert.equal((await pending).error.code,'PREFLIGHT_RESPONSE_INVALID');assert.equal(f.owner.diagnostics().failureCode,'PREFLIGHT_RESPONSE_INVALID');await f.owner.close();
  }
});
test('concurrent snapshots do not create another observer and concurrent close shares cleanup',async()=>{
  const f=fixture({auto:false});const pending=f.owner.snapshot();assert.equal((await f.owner.snapshot()).error.code,'PREFLIGHT_BUSY');const closed=await Promise.all([f.owner.close(),f.owner.close()]);assert.ok(closed.every(x=>x.ok&&x.value.closed));assert.equal(f.child.kills,1);assert.equal((await pending).error.code,'PREFLIGHT_CLOSED');assert.equal((await f.owner.snapshot()).error.code,'PREFLIGHT_CLOSED');
});
test('late events from a completed child do not contaminate a later snapshot',async()=>{
  const f=fixture();assert.equal((await f.owner.snapshot()).ok,true);const old=f.child;assert.equal((await f.owner.snapshot()).ok,true);old.stdout.emit('data',Buffer.from('PRIVATE late'));old.stderr.emit('error',new Error('PRIVATE'));old.emit('error',new Error('PRIVATE'));assert.equal(f.children.length,2);assert.equal(f.owner.diagnostics().generation,2);assert.equal(f.owner.diagnostics().failureCode,null);await f.owner.close();
});
test('production budgets remain explicit and per-query rather than cumulative',async()=>{
  assert.equal(PANEL_PREFLIGHT_LIMITS.queryTimeoutMs,5000);assert.equal(PANEL_PREFLIGHT_LIMITS.stdoutBytes,131072);assert.equal(PANEL_PREFLIGHT_LIMITS.stderrBytes,65536);
  const f=fixture();for(let index=0;index<4;index++)assert.equal((await f.owner.snapshot()).ok,true);assert.equal(f.children.length,4);await f.owner.close();
});
test('a real self-owned hung child reaches the bounded deadline and is confirmed closed',async()=>{
  let child,closed=false;
  const owner=createPanelPreflight(config(),{queryTimeoutMs:40,cleanupTimeoutMs:1000,spawn:()=>{child=spawnChild(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});child.once('close',()=>{closed=true;});return child;}});
  const started=performance.now(),result=await owner.snapshot();assert.equal(result.error.code,'PREFLIGHT_TIMEOUT');assert.ok(performance.now()-started<1500);assert.equal((await owner.close()).value.closed,true);assert.equal(closed,true);assert.equal(owner.diagnostics().ownedChild,false);
});
test('a real self-owned oversized-output child is stopped and independently observed closed',async()=>{
  let child,closed=false;
  const owner=createPanelPreflight(config(),{queryTimeoutMs:1500,cleanupTimeoutMs:1000,spawn:()=>{child=spawnChild(process.execPath,['-e','process.stdout.write(Buffer.alloc(131073,65));setInterval(()=>{},1000)'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});child.once('close',()=>{closed=true;});return child;}});
  const result=await owner.snapshot();assert.equal(result.error.code,'PREFLIGHT_STDOUT_LIMIT');assert.equal((await owner.close()).value.closed,true);assert.equal(closed,true);assert.equal(owner.diagnostics().ownedChild,false);
});
