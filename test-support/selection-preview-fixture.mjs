// Development-only peer for the real panel HTTP/SSE/UI. It never starts a
// native Codex process, contacts an auth provider or reads a Revit document.
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createPanelServerCore} from '../lib/panel-server-core.mjs';
import {createCustomerChatProfile} from '../lib/customer-chat-profile.mjs';
import {createBuildxAuth} from '../lib/buildx-auth.mjs';
import {createPanelChatStore} from '../lib/chat-store.mjs';
import {MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {MODEL_AI_READ_TOOLS} from '../lib/panel-tools.mjs';
import {PANEL_TOOL_CATALOG} from '../lib/panel-catalog.mjs';
import {READONLY_WORKBENCH_TOOL_NAMES} from '../lib/workbench-client.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const settle=()=>new Promise(resolve=>setImmediate(resolve));

class FixtureCodex extends EventEmitter{
  constructor({profile,autoReply,replyDelayMs,autoInterrupt}){
    super();this.autoReply=autoReply;this.replyDelayMs=replyDelayMs;this.autoInterrupt=autoInterrupt;
    if([MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE].includes(profile))Object.defineProperty(this,'profile',{value:Object.freeze({id:profile,toolNames:profile===MODEL_WORKSPACE_SESSION_PROFILE?Object.freeze(MODEL_AI_READ_TOOLS.map(tool=>tool.name)):READONLY_WORKBENCH_TOOL_NAMES,supportsTurnAttachments:true})});
    this.state={ready:true,error:false,mode:profile==='model'||[MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE].includes(profile)?'document-workbench':profile,
      message:'Codex 已连接',toolCount:profile===MODEL_WORKSPACE_SESSION_PROFILE?MODEL_AI_READ_TOOLS.length:profile===MODEL_READONLY_SESSION_PROFILE?4:profile==='customer-chat'?0:profile==='source-development'?6:PANEL_TOOL_CATALOG.length,
      connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0,
        observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};
    this.turns=[];this.interrupts=[];this.threads=0;this.timers=new Set();this.closed=false;
  }
  later(action,delay=this.replyDelayMs){const timer=setTimeout(()=>{this.timers.delete(timer);if(!this.closed)action();},delay);this.timers.add(timer);}
  async start(){
    this.closed=false;const generation=this.state.connectionGeneration+1;
    this.state={...this.state,ready:true,error:false,message:'Codex 已连接',connectionGeneration:generation,
      codexAccount:{...this.state.codexAccount,status:'verified',connectionGeneration:generation,
        accountRevision:this.state.codexAccount.accountRevision+1,observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()}};
    this.emit('state',this.state);
  }
  async refreshAccount(){
    const meta={...this.state.codexAccount,observationSequence:this.state.codexAccount.observationSequence+1,observedAt:new Date().toISOString()};
    this.state={...this.state,codexAccount:meta};
    return {...meta,type:'chatgpt',email:'local-codex@example.invalid',planType:'free'};
  }
  async newThread(){return 'isolated-model-thread-'+(++this.threads);}
  notify(method,turn,extra={}){this.emit('notification',method,{threadId:turn.threadId,turnId:turn.turnId,...extra});}
  finish(turn,status='completed',text='已收到只读查询回执。'){
    if(typeof turn==='number')turn=this.turns[turn];
    if(!turn)return;
    if(text)this.notify('item/completed',turn,{item:{id:'answer-'+turn.turnId,type:'agentMessage',text}});
    this.notify('turn/completed',turn,{turn:{id:turn.turnId,status}});
  }
  async turn(threadId,text,localImages=[]){
    const turn={threadId,text,localImages:structuredClone(localImages),turnId:'isolated-model-turn-'+(this.turns.length+1)};this.turns.push(turn);
    if(this.autoReply&&!text.includes('等待停止'))this.later(()=>{
      this.notify('item/started',turn,{item:{id:'query-'+turn.turnId,type:'mcpToolCall',tool:'revit_workbench_status',arguments:{}}});
      this.notify('item/completed',turn,{item:{id:'query-'+turn.turnId,type:'mcpToolCall',tool:'revit_workbench_status',status:'completed',result:{content:[{type:'text',text:'只读回执：项目参考.rvt；当前选择 2 项。'}]}}});
      this.finish(turn,'completed','已收到只读查询回执。\n\n当前模型：项目参考.rvt\n当前选择：2 项');
    });
    return {turn:{id:turn.turnId}};
  }
  async interrupt(threadId,turnId){
    this.interrupts.push({threadId,turnId});
    if(this.autoInterrupt){const turn=this.turns.find(item=>item.threadId===threadId&&item.turnId===turnId);this.later(()=>this.finish(turn,'interrupted',''),120);}
  }
  failed(message='本地连接已中断'){
    for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
    this.state={...this.state,ready:false,error:true,message};this.emit('state',this.state);
  }
  async close(){for(const timer of this.timers)clearTimeout(timer);this.timers.clear();this.closed=true;return {closed:true};}
}

export async function createModelWorkspaceFixture({profile='model',required=profile!=='source-development',requireLicense=false,autoReply=false,replyDelayMs=350,autoInterrupt=false,historyDirectory,historyOptions={},historyDependencies={},codexClient=null,requestTimeoutMs=5000,invokeReadonlyCommand=null,viewerService=null,projectPollMs=30000,projectHistoryFactory=null,cabinetFixtureTesting=false,materialIndexFactory=null,materialOpener=null,accessServices=null,modelPermissionServices=null,invokeAtomicContextRead=null}={}){
  if(!['model',MODEL_READONLY_SESSION_PROFILE,MODEL_WORKSPACE_SESSION_PROFILE,'source-development','customer-chat'].includes(profile))throw new Error('Unknown fixture profile');
  if(profile==='source-development'&&required)throw new Error('Source fixture cannot require customer identity');
  const authCalls=[],workbenchCalls=[],audits=[];
  let licenseStatus='trial';
  const user={id:'11111111-1111-1111-1111-111111111111',email:'demo@example.invalid'};
  const otherUser={id:'22222222-2222-2222-2222-222222222222',email:'other@example.invalid'};
  const accountAuth=required?createBuildxAuth({url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrst',fetchImpl:async(url,options)=>{
    authCalls.push({path:new URL(url).pathname,method:options.method});
    if(url.includes('/token?')){const other=JSON.parse(options.body).email===otherUser.email;return Response.json({access_token:'fixture-access'+(other?'-other':''),refresh_token:'fixture-refresh'+(other?'-other':''),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600});}
    if(url.endsWith('/user'))return Response.json(options.headers.Authorization.endsWith('-other')?otherUser:user);
    if(url.includes('/logout?scope=local'))return new Response(null,{status:204});
    if(url.endsWith('/signup'))return Response.json({user,session:null});
    if(url.endsWith('/rpc/buildx_license_status'))return Response.json({status:licenseStatus,startsAt:null,endsAt:null});
    throw new Error('Unexpected isolated auth route');
  }}):null;
  const codex=codexClient??new FixtureCodex({profile,autoReply,replyDelayMs,autoInterrupt});
  let document={title:'项目参考.rvt',path:'D:\\isolated-samples\\project.rvt',activeViewId:12},elementIds=[42,84];
  const invokeWorkbench=async(name,args)=>{
    workbenchCalls.push({name,args:structuredClone(args)});
    const result={hostSession:'isolated-host',document:{...document}};
    if(name==='revit_workbench_status')return result;
    if(name==='revit_get_selection')return {...result,operation:'get_selection',value:{total:elementIds.length,returned:elementIds.length,truncated:false,items:elementIds.map(element_id=>({element_id}))}};
    throw new Error('Unexpected isolated model query');
  };
  const historyStore=historyDirectory?createPanelChatStore({...historyOptions,stateDirectory:historyDirectory},historyDependencies):null;
  const options={root,codex,port:0,accountAuth,requireAccount:required,requireLicense,projectPollMs,projectHistoryFactory,cabinetFixtureTesting,invokeWorkbench,...(invokeAtomicContextRead?{invokeAtomicContextRead}:{}),audit:(file,data)=>audits.push({file,data}),historyStore,...(invokeReadonlyCommand?{invokeReadonlyCommand}:{}),...(viewerService?{viewerService}:{}),...(materialIndexFactory?{materialIndexFactory}:{}),...(materialOpener?{materialOpener}:{}),...(accessServices?{accessServices}:{}),...(modelPermissionServices?{modelPermissionServices}:{})};
  const app=profile==='customer-chat'?createPanelServerCore({...options,requireAccount:true,selection:createCustomerChatProfile().panel}):createPanelServer({...options,profile});
  const {origin}=await app.listen(),controllers=new Set();
  const status=async cookie=>{
    const response=await fetch(origin+'/api/status',{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(5000)});
    return response.json();
  };
  const initial=await status();
  const post=async(route,input={},cookie,extraHeaders={})=>{
    const response=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'X-Local-Chat':initial.csrf,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extraHeaders},body:JSON.stringify({client:'model-test-client',...input}),signal:AbortSignal.timeout(requestTimeoutMs)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const events=async(cookie,client='model-test-client')=>{
    const controller=new AbortController();controllers.add(controller);
    const response=await fetch(origin+'/api/events?client='+client,{headers:cookie?{Cookie:cookie}:{},signal:controller.signal});
    if(!response.ok)return {response,abort:()=>controller.abort()};
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    return {response,abort:()=>controller.abort(),async next(){
      while(true){const index=buffer.indexOf('\n\n');if(index>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);if(!block.startsWith('event: '))continue;return {event:block.slice(7,block.indexOf('\n')),data:JSON.parse(block.slice(block.indexOf('data: ')+6))};}
        const {value,done}=await reader.read();if(done)throw new Error('SSE stream ended');buffer+=decoder.decode(value,{stream:true});}
    }};
  };
  const confirm=async cookie=>{const inspected=await post('codex-account/inspect',{},cookie);if(inspected.status!==200)throw new Error('Fixture inspect failed');return post('codex-account/confirm',{challengeId:inspected.body.challengeId},cookie);};
  let closed=false;
  return {origin,app,codex,initial,post,status,events,confirm,authCalls,workbenchCalls,audits,historyStore,
    setDocument(next,ids=elementIds){document={...next};elementIds=[...ids];},setLicense(value){licenseStatus=value;},
    async close(){if(closed)return;for(const controller of controllers)controller.abort();await app.close();closed=true;await settle();}};
}

const direct=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const fixture=await createModelWorkspaceFixture({autoReply:true,autoInterrupt:true});
  let closing=false;const input=createInterface({input:process.stdin});
  const close=async()=>{if(closing)return;closing=true;clearTimeout(deadline);input.close();await fixture.close();process.exitCode=0;};
  const deadline=setTimeout(()=>{void close();},15*60*1000);
  input.on('line',line=>{if(line.trim()==='close')void close();else if(line.trim()==='disconnect')fixture.codex.failed();});
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
  console.log(JSON.stringify({origin:fixture.origin,scope:'isolated real HTTP/SSE/UI with controlled upstream',fixtureLogin:'demo@example.invalid',fixturePassword:'fixture-password',nativeCodexProcesses:0,externalAuthRequests:0,realRevitReads:0,autoCloseMinutes:15}));
}
