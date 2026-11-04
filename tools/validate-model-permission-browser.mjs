// Isolated product HTTP/SSE/UI, synthetic Codex and synthetic model services.
// No real Revit, model request, external connection, or fixed BuildX port.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createPanelServer} from '../lib/panel-server.mjs';
import {createPanelChatStore} from '../lib/chat-store.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(path.resolve(path.dirname(process.execPath),'..','node_modules','playwright')));}
const root=fileURLToPath(new URL('..',import.meta.url));
const browserPath=process.env.BUILDX_TEST_BROWSER;
if(!browserPath)throw new Error('Set BUILDX_TEST_BROWSER to an installed Chromium executable.');
const output=path.join(root,'artifacts','model-permission-browser-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
await fs.mkdir(output,{recursive:false});

class FakeCodex extends EventEmitter{
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',message:'隔离测试连接',toolCount:this.profile.toolNames.length,connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0,observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};this.answers=[];this.turns=[];this.rejected=0;this.discarded=0;}
  async listModels(){return [{model:'fixture-model',displayName:'验证模型',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low',description:'低'},{reasoningEffort:'medium',description:'中'},{reasoningEffort:'high',description:'高'}]}];}
  assertModelSelection(){}
  async newThread(){return 'fixture-thread';}
  async turn(threadId,text){this.turns.push({threadId,text});return {turn:{id:'fixture-turn'}};}
  request(id,tool,parameters){let pending=true;const params=Object.freeze({threadId:'fixture-thread',turnId:'fixture-turn',callId:'call-'+id,tool:'buildx_model_operation',arguments:Object.freeze({tool,parameters})});this.emit('dynamic-tool-request',{id,generation:1,revision:0,params,respond:value=>{if(!pending)return false;pending=false;this.answers.push(value);return true;},reject:()=>{pending=false;this.rejected++;},discard:()=>{pending=false;this.discarded++;}});}
  finish(){this.emit('notification','turn/completed',{threadId:'fixture-thread',turnId:'fixture-turn',turn:{id:'fixture-turn',status:'completed'}});}
  async interrupt(){} async close(){return {closed:true};}
}
const fake=new FakeCodex(),calls=[];
const services=Object.freeze({observeDocument:async()=>({session:'fixture-host',path:'C:\\fixture\\model.rvt',title:'隔离模型'}),readCommand:async()=>{throw new Error('Unexpected fixture command read');},inspectFamilyJob:async()=>{throw new Error('Unexpected fixture family read');},invoke:async(tool,args,control)=>{calls.push({tool,args:structuredClone(args),sourceDocument:control.sourceDocument});return {ok:true,value:{done:true}};}});
const history=createPanelChatStore({stateDirectory:path.join(output,'history')});
const app=createPanelServer({root,codex:fake,profile:MODEL_WORKSPACE_SESSION_PROFILE,port:0,historyStore:history,modelPermissionServices:services,invokeWorkbench:async()=>{throw new Error('Unexpected Revit call');},invokeReadonlyCommand:async()=>{throw new Error('Unexpected direct command');}});
let browser;
try{
  const {origin}=await app.listen();assert.notEqual(new URL(origin).port,'41873');
  browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  const page=await browser.newPage({viewport:{width:1280,height:800}}),requests=[],blocked=[],errors=[];page.setDefaultTimeout(15000);
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){blocked.push(url.origin);return route.abort();}return route.continue();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===origin&&request.method()==='POST'&&url.pathname.startsWith('/api/'))requests.push({path:url.pathname,body:request.postDataJSON()});});
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  const select=page.locator('#model-permission-select'),attach=page.locator('.model-add-file'),prompt=page.locator('#prompt');
  await select.waitFor({state:'visible'});await attach.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#model-permission-select')?.disabled);
  const labels=await select.locator('option').allTextContents();for(const text of ['回滚预览','确认后应用','自动应用'])assert.ok(labels.includes(text));
  for(const level of ['rollback','confirm','automatic','confirm']){
    await select.selectOption(level);await page.waitForFunction(level=>document.querySelector('#model-permission-select')?.value===level,level);
    assert.equal(requests.filter(item=>item.path==='/api/model-permission').at(-1).body.level,level);
  }
  const picker=page.locator('.model-picker-toggle');await picker.waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.model-picker-current-model')?.textContent==='验证模型');
  const geometries=[];
  for(const width of [900,380]){
    await page.setViewportSize({width,height:800});
    const layout=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};};return {attach:box('.model-add-file'),permission:box('#model-permission-select'),prompt:box('#prompt'),model:box('.model-picker-toggle'),send:box('#send'),viewport:innerWidth,docWidth:document.documentElement.scrollWidth};});
    assert.ok(Math.abs(layout.attach.y-layout.permission.y)<3&&Math.abs(layout.attach.y-layout.model.y)<3&&Math.abs(layout.attach.y-layout.send.y)<3,'controls must stay on one row');
    assert.ok(layout.attach.right<=layout.permission.x+1&&layout.permission.right<=layout.model.x+1&&layout.model.right<=layout.send.x+1,'controls must follow the requested left/right order');
    assert.ok(layout.docWidth<=width&&layout.send.right<=width,'composer must not overflow');
    geometries.push(layout);
  }
  await page.screenshot({path:path.join(output,'narrow-picker.png')});
  await picker.click();const slider=page.locator('#model-picker-effort');await slider.waitFor({state:'visible'});await slider.focus();await page.keyboard.press('ArrowLeft');
  assert.equal(await slider.getAttribute('aria-valuetext'),'中');
  await page.waitForFunction(()=>document.querySelector('.model-picker-current-effort')?.textContent==='中');
  const sliderBox=await slider.boundingBox();assert.ok(sliderBox&&sliderBox.x>=0&&sliderBox.x+sliderBox.width<=380,'reasoning menu must fit narrow windows');
  await page.screenshot({path:path.join(output,'narrow-menu.png')});await page.keyboard.press('Escape');assert.equal(await picker.getAttribute('aria-expanded'),'false');
  const geometry=geometries[1];
  assert.ok(geometry.attach.right<=geometry.permission.x+1,'permission selector should follow attachment button');
  assert.ok(geometry.permission.y>=geometry.prompt.bottom-2,'permission selector should be below prompt');
  if(geometry.permission.right>geometry.viewport||geometry.docWidth>geometry.viewport){const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('*')).map(element=>{const r=element.getBoundingClientRect();return {tag:element.tagName,id:element.id,cls:typeof element.className==='string'?element.className:'',left:r.left,right:r.right,width:r.width};}).filter(item=>item.right>innerWidth+1||item.left< -1).slice(0,20));throw new Error('narrow layout overflow: '+JSON.stringify({geometry,overflow}));}
  await page.screenshot({path:path.join(output,'narrow.png')});
  await page.setViewportSize({width:1280,height:800});
  await prompt.fill('隔离验证审批');await page.locator('#send').click();
  await page.waitForFunction(()=>document.querySelector('#stop')&&!document.querySelector('#stop').hidden);
  for(let attempt=0;attempt<200&&!requests.some(item=>item.path==='/api/turn');attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  const client=requests.find(item=>item.path==='/api/turn')?.body.client;assert.ok(client);
  for(let attempt=0;attempt<200&&app.snapshot(client).session.conversation.turnBinding?.turnId!=='fixture-turn';attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.snapshot(client).session.conversation.turnBinding?.turnId,'fixture-turn');
  fake.request(1,'revit_execute_csharp',{mode:'rollback',code:'return 42;'});
  const approval=page.locator('#dynamic-approval');
  try{await approval.waitFor({state:'visible'});}catch(error){console.error(JSON.stringify({answers:fake.answers,rejected:fake.rejected,discarded:fake.discarded,snapshot:app.snapshot(client),errors}));throw error;}
  assert.match(await approval.innerText(),/return 42/);assert.match(await approval.innerText(),/回滚不能撤销文件、网络/);assert.equal(calls.length,0);
  await approval.getByRole('button',{name:'拒绝'}).click();await page.waitForFunction(()=>document.querySelector('#dynamic-approval')?.textContent.includes('拒绝'));
  assert.equal(calls.length,0);
  // Wait for the browser to receive the cleared proposal before a new one.
  await new Promise(resolve=>setTimeout(resolve,100));fake.request(2,'revit_execute_csharp',{mode:'rollback',code:'return 43;'});
  await page.waitForFunction(()=>document.querySelector('#dynamic-approval')?.textContent.includes('return 43;'));
  await approval.getByRole('button',{name:'同意本次操作'}).click();
  await page.waitForFunction(()=>document.querySelector('#dynamic-approval')?.textContent.includes('已提交')||document.querySelector('#dynamic-approval')?.textContent.includes('已同意'));
  assert.equal(calls.length,1);assert.equal(calls[0].tool,'revit_execute_csharp');assert.equal(calls[0].args.code,'return 43;');
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  const permissionRequests=requests.filter(item=>item.path==='/api/model-permission');assert.deepEqual(permissionRequests.map(item=>item.body.level),['rollback','confirm','automatic','confirm']);
  assert.equal(requests.filter(item=>item.path==='/api/dynamic-approval').length,2);
  fake.finish();
  const evidence={ok:true,scope:'real Edge with production local HTTP/SSE/UI, synthetic model and Codex; no real Revit or inference',geometry,geometries,checks:['attachment and permission on left, model and send on right in one row','900px and 380px layouts','model and advertised effort slider menu','three levels round trip over HTTP/SSE','script approval requires a user decision','no external requests'],calls:calls.length,externalRequests:blocked,pageErrors:errors};
  await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({...evidence,output}));
}finally{if(browser)await browser.close();await app.close();}
