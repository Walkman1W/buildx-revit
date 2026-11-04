import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexClientCore,validateDynamicToolOutput,CODEX_OUTBOUND_FRAME_BYTES} from './lib/codex-client-core.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from './lib/codex-profile.mjs';
import {MODEL_AI_READ_TOOLS} from './lib/panel-tools.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const output=(bytes=png)=>({success:true,contentItems:[{type:'inputText',text:'Captured; view restored.'},{type:'inputImage',imageUrl:'data:image/png;base64,'+bytes.toString('base64')}]});
function fixture(){
  const profile=createCodexSessionProfile(process.cwd(),{profile:MODEL_WORKSPACE_SESSION_PROFILE}),messages=[];
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;
    child.stdin.write=(line,callback)=>{const request=JSON.parse(line);messages.push(request);queueMicrotask(()=>{
      callback?.();if(!request.method||request.id===undefined)return;
      const result=request.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',email:null,planType:'free'}}:request.method==='thread/start'?{thread:{id:'visual-thread'}}:request.method==='mcpServerStatus/list'?{nextCursor:null,data:profile.groups.map(group=>({name:group.name,runtimeStatus:'connected',authStatus:'unsupported',resources:[],resourceTemplates:[],tools:Object.fromEntries(MODEL_AI_READ_TOOLS.map(tool=>[tool.name,structuredClone(tool)]))}))}:{};
      child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));
    });return true;};
    child.stdin.end=()=>queueMicrotask(()=>{child.emit('exit',0,null);child.emit('close',0,null);});child.kill=()=>true;return child;
  };
  const client=new CodexClientCore(process.cwd(),profile,{spawn,resolveRuntimes:()=>({codex:'fixture',python:'fixture'}),readConfiguredNames:()=>[],closeTimeoutMs:20,killTimeoutMs:20});
  let observed;client.on('dynamic-tool-request',value=>{observed=value;});
  const call=(tool,id)=>{client.dispatch({id,method:'item/tool/call',params:{threadId:'visual-thread',turnId:'turn',callId:'call-'+id,tool:'buildx_model_operation',arguments:{tool,parameters:{}}}});return observed;};
  return {client,messages,call};
}

test('visual output accepts bounded PNG data only, never a URL or arbitrary native path',()=>{
  assert.equal(validateDynamicToolOutput(output()),false);assert.equal(validateDynamicToolOutput(output(),true),true);
  for(const imageUrl of ['file:///C:/private.png','http://127.0.0.1/private','https://example.invalid/a.png','data:text/html;base64,AAAA','data:image/png;base64,not+canonical='])assert.equal(validateDynamicToolOutput({success:true,contentItems:[{type:'inputImage',imageUrl}]},true),false);
  const wrong=Buffer.from(png);wrong.writeUInt32BE(4097,16);assert.equal(validateDynamicToolOutput(output(wrong),true),false);
  assert.equal(validateDynamicToolOutput({...output(),unexpected:true},true),false);
});

test('visual expansion and aggregate budgets reject before accepting oversized output',()=>{
  const twoMiB=Buffer.concat([png,Buffer.alloc(2*1024*1024-png.length)]),item=output(twoMiB).contentItems[1];
  assert.equal(validateDynamicToolOutput({success:true,contentItems:[item,item]},true),true);
  assert.equal(validateDynamicToolOutput({success:true,contentItems:[item,item,item]},true),false);
  assert.equal(validateDynamicToolOutput(output(Buffer.concat([twoMiB,Buffer.alloc(1)])),true),false);
  assert.equal(validateDynamicToolOutput({success:true,contentItems:Array(4).fill(output().contentItems[1])},true),false);
});

test('only registered visual calls send a larger image response; ordinary RPC bounds stay unchanged',async t=>{
  const f=fixture();t.after(()=>f.client.close());await f.client.start();
  const large=output(Buffer.concat([png,Buffer.alloc(300000)]));assert.ok(Buffer.byteLength(JSON.stringify(large))>CODEX_OUTBOUND_FRAME_BYTES);
  const visual=f.call('revit_inspect_elements',501);assert.equal(visual.respond(large),true);
  assert.equal(f.messages.at(-1).id,501);assert.equal(f.messages.at(-1).result.contentItems[1].type,'inputImage');
  const ordinary=f.call('revit_create_wall',502);assert.equal(ordinary.respond(output()),false);assert.equal(ordinary.respond({success:true,contentItems:[{type:'inputText',text:'done'}]}),true);
  assert.throws(()=>f.client.send({method:'arbitrary',params:{text:'x'.repeat(CODEX_OUTBOUND_FRAME_BYTES)}}),/传输上限/);
});

test('late visual images cannot cross an account revision',async t=>{
  const f=fixture();t.after(()=>f.client.close());await f.client.start();const call=f.call('revit_capture_view',600);
  f.client.dispatch({method:'account/updated',params:{}});assert.equal(call.respond(output()),false);assert.equal(f.messages.some(message=>message.id===600&&message.result),false);
});

test('registered text writes admit the file budget and JSON expansion without expanding other tools',async t=>{
  const f=fixture();t.after(()=>f.client.close());await f.client.start();const seen=[];f.client.on('dynamic-tool-request',call=>seen.push(call));
  const send=(id,tool,content)=>f.client.dispatch({id,method:'item/tool/call',params:{threadId:'visual-thread',turnId:'turn',callId:'file-'+id,tool,arguments:{path:'C:\\controlled.txt',content,create:true}}});
  const content='\u0001'.repeat(1024*1024);send(701,'buildx_file_write',content);
  assert.equal(seen.length,1);assert.equal(seen[0].params.arguments.content,content);seen[0].discard();
  send(702,'buildx_file_write','x'.repeat(1024*1024+1));assert.equal(seen.length,1);assert.ok(f.messages.at(-1).error);
  send(703,'buildx_file_read','x'.repeat(65537));assert.equal(seen.length,1);assert.ok(f.messages.at(-1).error);
});
