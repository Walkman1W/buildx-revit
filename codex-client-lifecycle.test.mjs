import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClient} from './lib/codex-client.mjs';
import {createPanelServer} from './lib/panel-server.mjs';

const root=process.cwd(),tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const children=[],diagnostics=[],settings={respond:()=>true,...options};let client;
  const spawn=()=>{
    const child=new EventEmitter();child.pid=children.length+100;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.messages=[];child.callbacks=[];child.pending=[];child.endCalls=0;child.killCalls=0;child.blocked=false;child.respondAutomatically=true;
    child.confirmClose=()=>{if(child.confirmed)return;child.confirmed=true;child.emit('exit',0,null);child.emit('close',0,null);};
    child.reply=(message,result)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:message.id,result})+'\n'));
    child.stdin.writable=true;
    child.stdin.write=(line,callback)=>{
      if(child.writeThrows)throw new Error('PRIVATE raw pipe error');
      const message=JSON.parse(line);child.messages.push(message);child.callbacks.push(callback);
      if(callback&&!child.deferCallbacks)queueMicrotask(()=>callback());
      if(message.id!==undefined&&message.method){
        let result;
        if(message.method==='initialize')result={};
        else if(message.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture@example.invalid',planType:'free'}};
        else if(message.method==='thread/start')result={thread:{id:'thread-'+children.length}};
        else if(message.method==='mcpServerStatus/list'){
          const group=client.profile.groups.find(group=>group.name===message.params.serverName);
          result={data:[{name:group.name,runtimeStatus:'connected',tools:Object.fromEntries(group.toolNames.map(name=>[name,{}]))}]};
        }else if(message.method==='turn/start')result={turn:{id:'turn-'+children.length}};
        else result={ok:true};
        if(child.respondAutomatically&&settings.respond(message,child,result)!==false)queueMicrotask(()=>child.reply(message,result));else child.pending.push([message,result]);
      }
      return !child.blocked;
    };
    child.stdin.end=()=>{child.endCalls++;if(settings.closeOnEnd!==false)queueMicrotask(()=>child.confirmClose());};
    child.kill=()=>{child.killCalls++;if(settings.closeOnKill)queueMicrotask(()=>child.confirmClose());return settings.killReturn??true;};
    children.push(child);return child;
  };
  client=new CodexClient(root,options.profile?{profile:options.profile}:{},{spawn,resolveRuntimes:()=>({codex:'fake-codex',python:'fake-python'}),readConfiguredNames:()=>['revit_local'],closeTimeoutMs:5,killTimeoutMs:5});
  client.on('diagnostic',value=>diagnostics.push(value));
  return {client,children,diagnostics,settings,get child(){return children.at(-1);}};
}
async function ready(t,options={}){const f=fixture(options);await f.client.start();assert.equal(f.client.state.ready,true);t.after(async()=>{for(const child of f.children)child.confirmClose();await f.client.close();});return f;}

test('real production client completes one initialization and exact named catalog; concurrent start is shared',async t=>{
  const f=fixture();t.after(()=>f.client.close());await Promise.all([f.client.start(),f.client.start()]);
  assert.equal(f.children.length,1);assert.equal(f.client.state.ready,true);assert.equal(f.client.pending.size,0);
  assert.deepEqual(f.child.messages.slice(0,4).map(x=>x.method),['initialize','initialized','account/read','thread/start']);
  assert.ok(f.child.messages.every(x=>!['account/login/start','account/logout','fs/writeFile','command/exec'].includes(x.method)));
  assert.ok(f.diagnostics.some(x=>x.code==='codex_lifecycle'&&x.phase==='connected'));
});

for(const [surface,event,reason] of [['stdin','error','codex_stdin_error'],['stdout','error','codex_stdout_error'],['stderr','error','codex_stderr_error'],['stdout','end','codex_stdout_eof'],['stdin','close','codex_stdin_closed'],['stdout','close','codex_stdout_closed']]){
  test('pipe '+surface+' '+event+' settles requests without unhandled errors or replay',async t=>{
    const f=await ready(t);f.child.respondAutomatically=false;
    const pending=f.client.turn('thread-owned','one-turn');const rejected=assert.rejects(pending);const before=f.child.messages.length;
    assert.doesNotThrow(()=>f.child[surface].emit(event,new Error('PRIVATE raw pipe error')));await rejected;
    assert.equal(f.client.pending.size,0);assert.equal(f.client.state.ready,false);assert.equal(f.client.state.cleanupPending,true);assert.equal(f.client.child,f.child);
    await tick();assert.equal(f.child.messages.length,before);assert.ok(f.diagnostics.some(x=>x.reason===reason));assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE'),false);
  });
}

test('asynchronous stdin write callback error has the same fault owner',async t=>{
  const f=await ready(t);f.child.deferCallbacks=true;f.child.respondAutomatically=false;
  const pending=f.client.turn('t','do not retry');const rejected=assert.rejects(pending);f.child.callbacks.at(-1)(new Error('PRIVATE EPIPE'));await rejected;
  assert.equal(f.client.pending.size,0);assert.equal(f.client.state.ready,false);assert.ok(f.diagnostics.some(x=>x.reason==='codex_stdin_write_error'));
});
test('child spawn error settles initialization and releases only after observed close',async t=>{
  const f=fixture({respond:()=>false});const started=f.client.start(),rejected=assert.rejects(started);t.after(()=>f.client.close());
  const child=f.child;child.emit('error',new Error('PRIVATE spawn path'));await rejected;
  assert.equal(f.client.child,child);assert.equal(f.client.pending.size,0);assert.equal(f.client.state.ready,false);child.confirmClose();assert.equal(f.client.child,null);
});
test('synchronous stdin write failure settles request and retains child',async t=>{
  const f=await ready(t);f.child.writeThrows=true;await assert.rejects(f.client.turn('t','one'),/连接/);
  assert.equal(f.client.pending.size,0);assert.equal(f.client.child,f.child);assert.equal(f.client.state.ready,false);
});
test('exit is a failed transport, not proof of closed resources',async t=>{
  const f=await ready(t,{closeOnEnd:false});const child=f.child;child.emit('exit',2,'SIGTERM');
  assert.equal(f.client.child,child);assert.equal(f.client.state.ready,false);await assert.rejects(f.client.start(),{code:'CODEX_CLEANUP_REQUIRED'});
  child.confirmClose();assert.equal(f.client.child,null);assert.ok(f.diagnostics.some(x=>x.code==='codex_exit'&&x.exitCode===2&&x.signal==='SIGTERM'));
});
test('late old-child data, errors, callback, EOF and exit do not poison a new generation',async t=>{
  const f=await ready(t);const old=f.child;old.deferCallbacks=true;old.respondAutomatically=false;
  const pending=f.client.turn('old','old-turn');const rejected=assert.rejects(pending);const callback=old.callbacks.at(-1);
  await f.client.close();await rejected;await f.client.start();const current=f.child,generation=f.client.state.connectionGeneration;
  old.stdout.emit('data',Buffer.from('bad old data\n'));old.stdin.emit('error',new Error('PRIVATE late'));old.stderr.emit('error',new Error('PRIVATE late'));old.stdout.emit('end');old.emit('exit',3,'SIGTERM');callback(new Error('PRIVATE late write'));
  assert.equal(f.client.child,current);assert.equal(f.client.state.connectionGeneration,generation);assert.equal(f.client.state.ready,true);
});

for(const phase of ['initialize','account/read','thread/start','mcpServerStatus/list']){
  test('close between '+phase+' response and await continuation cannot publish readiness',async t=>{
    let target;
    const f=fixture({respond(message,child,result){if(message.method===phase){target=child;queueMicrotask(()=>{child.reply(message,result);child.confirmClose();});return false;}}});
    t.after(()=>f.client.close());await assert.rejects(f.client.start());assert.equal(f.client.state.ready,false);assert.equal(f.client.authReady,false);assert.equal(f.client.preparedThread,null);assert.equal(f.client.pending.size,0);assert.ok(target);
    if(phase==='initialize')assert.equal(target.messages.some(x=>x.method==='account/read'),false);
    if(phase==='thread/start')assert.equal(target.messages.some(x=>x.method==='mcpServerStatus/list'),false);
  });
}
test('close during catalog delay cancels the wait and cannot query the next generation',async t=>{
  const f=fixture({respond(message,child,result){if(message.method==='mcpServerStatus/list')result.data[0].runtimeStatus='connecting';}});
  const started=f.client.start(),rejected=assert.rejects(started);t.after(()=>f.client.close());await tick();assert.equal(f.client._connection.delays.size,1);
  const before=f.child.messages.length;await f.client.close();await rejected;await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.child.messages.length,before);assert.equal(f.client.pending.size,0);
});
test('cleanup failure retains exact child, blocks overlapping spawn and can be retried',async t=>{
  const f=await ready(t,{closeOnEnd:false,closeOnKill:false});const child=f.child;
  await assert.rejects(f.client.close(),{code:'CODEX_CLEANUP_UNCONFIRMED'});assert.equal(f.client.child,child);assert.equal(child.endCalls,1);assert.equal(child.killCalls,1);assert.equal(f.client.state.cleanupPending,true);
  await assert.rejects(f.client.start(),{code:'CODEX_CLEANUP_REQUIRED'});assert.equal(f.children.length,1);
  f.settings.closeOnKill=true;const result=await f.client.close();assert.equal(result.closed,true);assert.equal(child.endCalls,1);assert.equal(child.killCalls,2);assert.equal(f.client.child,null);
});
test('concurrent close makes one stdin-end and one cleanup operation',async t=>{
  const f=await ready(t);const child=f.child;const results=await Promise.all([f.client.close(),f.client.close()]);assert.ok(results.every(x=>x.closed));assert.equal(child.endCalls,1);assert.equal(child.killCalls,0);
});
test('kill returning false or throwing does not manufacture close confirmation',async t=>{
  for(const throws of [false,true]){
    const f=await ready(t,{closeOnEnd:false,killReturn:false});if(throws)f.child.kill=()=>{throw new Error('PRIVATE denial');};
    await assert.rejects(f.client.close(),{code:'CODEX_CLEANUP_UNCONFIRMED'});assert.equal(f.client.child,f.child);assert.equal(f.client.state.cleanupPending,true);f.child.confirmClose();
  }
});
test('backpressure queues in order, resumes only on drain and does not replay accepted frames',async t=>{
  const f=await ready(t);f.child.blocked=true;f.child.respondAutomatically=false;
  const first=f.client.request('probe/one',{}),second=f.client.request('probe/two',{});const promises=Promise.all([assert.rejects(first),assert.rejects(second)]);
  assert.equal(f.child.messages.at(-1).method,'probe/one');assert.equal(f.client._connection.queue.length,1);await tick();assert.equal(f.child.messages.filter(x=>x.method==='probe/two').length,0);
  f.child.blocked=false;f.child.stdin.emit('drain');assert.equal(f.child.messages.at(-1).method,'probe/two');assert.equal(f.child.messages.filter(x=>x.method==='probe/one').length,1);await f.client.close();await promises;
});
test('expired request still queued behind backpressure is removed before drain',async t=>{
  const f=await ready(t);f.child.blocked=true;f.client.notify('blocked/notice');
  await assert.rejects(f.client.request('must/not/send',{},5),{code:'CODEX_REQUEST_TIMEOUT'});assert.equal(f.client._connection.queue.length,0);f.child.blocked=false;f.child.stdin.emit('drain');assert.equal(f.child.messages.some(x=>x.method==='must/not/send'),false);
});
test('pending requests and outgoing frames have independent hard bounds',async t=>{
  const f=await ready(t);f.child.respondAutomatically=false;const pending=[];
  for(let n=0;n<64;n++)pending.push(assert.rejects(f.client.request('pending/'+n,{})));
  await assert.rejects(f.client.request('too/many',{}),{code:'CODEX_PENDING_LIMIT'});assert.equal(f.client.pending.size,64);await f.client.close();await Promise.all(pending);
  await f.client.start();await assert.rejects(f.client.request('oversized',{text:'x'.repeat(256*1024)}),{code:'CODEX_OUTBOUND_LIMIT'});assert.equal(f.client.pending.size,0);assert.equal(f.client.state.ready,true);
});
test('bounded outgoing byte retention faults without accumulating unbounded writes',async t=>{
  const f=await ready(t);f.child.blocked=true;f.child.deferCallbacks=true;f.client.notify('first',{text:'x'.repeat(200000)});
  assert.throws(()=>{for(let n=0;n<30;n++)f.client.notify('queued',{text:'x'.repeat(200000)});},/队列已满/);
  assert.equal(f.client.state.ready,false);assert.equal(f.client._connection.queuedBytes,0);assert.ok(f.client._connection.writeBytes<=4*1024*1024);assert.equal(f.client.child,f.child);
});
test('outgoing frame-count limit applies even when byte usage is small',async t=>{
  const f=await ready(t);f.child.blocked=true;f.child.deferCallbacks=true;
  for(let n=0;n<64;n++)f.client.notify('small/frame',{n});
  assert.equal(f.client._connection.queue.length+f.client._connection.writes.size,64);
  assert.throws(()=>f.client.notify('one/extra'),{code:'CODEX_WRITE_LIMIT'});assert.equal(f.client._connection.queue.length,0);assert.equal(f.client.state.ready,false);
});
test('pipe failure during cleanup does not substitute for close confirmation',async t=>{
  const f=await ready(t,{closeOnEnd:false,closeOnKill:true}),child=f.child;
  const closing=f.client.close();child.stdin.emit('error',new Error('PRIVATE cleanup'));const result=await closing;
  assert.equal(result.closed,true);assert.equal(f.client.child,null);assert.equal(child.killCalls,1);
});
for(const [label,bytes,reason] of [['invalid JSON',Buffer.from('{bad\n'),'invalid_rpc_line'],['invalid UTF8',Buffer.from([0xff,10]),'invalid_rpc_line'],['invalid envelope',Buffer.from('[]\n'),'invalid_rpc_envelope'],['oversized frame',Buffer.alloc(8*1024*1024+1,65),'codex_frame_limit']]){
  test(label+' fails closed with fixed diagnostics and bounded retention',async t=>{
    const f=await ready(t);f.child.respondAutomatically=false;const pending=f.client.turn('t','pending'),rejected=assert.rejects(pending);
    f.child.stdout.emit('data',bytes);await rejected;assert.equal(f.client.pending.size,0);assert.equal(f.client.state.ready,false);assert.equal(f.client._connection.used,0);assert.ok(f.client._connection.frame.length<=8*1024*1024);assert.ok(f.diagnostics.some(x=>x.reason===reason));
  });
}
test('split UTF8 and CRLF frames preserve one notification and do not impose cumulative stream quotas',async t=>{
  const f=await ready(t),seen=[];f.client.on('notification',(name,params)=>seen.push([name,params]));const bytes=Buffer.from(JSON.stringify({method:'delta',params:{text:'中文'}})+'\r\n');
  for(const byte of bytes)f.child.stdout.emit('data',Buffer.from([byte]));
  assert.deepEqual(seen,[['delta',{text:'中文'}]]);
  for(let n=0;n<1000;n++)f.child.stdout.emit('data',Buffer.from('{"method":"delta","params":{}}\n'));
  assert.equal(f.client.state.ready,true);assert.equal(seen.length,1001);
});
test('HTTP remains available and an in-flight tool becomes unknown after a real client pipe error',async t=>{
  const f=fixture();const app=createPanelServer({root,codex:f.client,invokeWorkbench:async()=>{throw new Error('Revit must not be called');},port:0});
  const address=await app.listen();t.after(async()=>{for(const child of f.children)child.confirmClose();await app.close();});await app.connect();
  const origin=address.origin,status=await(await fetch(origin+'/api/status')).json();assert.equal(status.ready,true);
  const response=await fetch(origin+'/api/turn',{method:'POST',headers:{'content-type':'application/json','x-local-chat':status.csrf,origin},body:JSON.stringify({client:'transport-test',message:'one pending turn'})});assert.equal(response.status,202);
  const thread='thread-1',turn='turn-1';f.child.stdout.emit('data',Buffer.from(JSON.stringify({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'tool-1',type:'mcpToolCall',tool:'revit_create_wall',status:'inProgress'}}})+'\n'));
  f.child.stdin.emit('error',new Error('PRIVATE EPIPE'));const after=await(await fetch(origin+'/api/status')).json();assert.equal(after.ready,false);assert.equal(after.busy,false);
  const session=app.snapshot('transport-test').session;assert.equal(session.messages[1].status,'unknown');assert.equal(session.messages[1].tools[0].status,'unknown');assert.equal(f.child.messages.filter(x=>x.method==='turn/start').length,1);
});
