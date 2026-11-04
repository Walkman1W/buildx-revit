// Isolated browser acceptance: production panel HTTP/SSE and assets, synthetic
// native Codex, no Revit, no real account and no provider inference.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {createCodexSessionProfile,MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(path.resolve(path.dirname(process.execPath),'..','node_modules','playwright')));}
const root=fileURLToPath(new URL('..',import.meta.url));
const browserPath=process.env.BUILDX_TEST_BROWSER;
if(!browserPath)throw new Error('Set BUILDX_TEST_BROWSER to an installed Chromium executable.');
const models=[
  {id:'fixture-a',model:'fixture-a',displayName:'隔离模型 A',description:'仅用于测试',isDefault:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low',description:'较快'},{reasoningEffort:'high',description:'深入'}],defaultReasoningEffort:'low'},
  {id:'fixture-b',model:'fixture-b',displayName:'隔离模型 B',description:'仅用于测试',isDefault:false,inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'medium',description:'均衡'},{reasoningEffort:'high',description:'深入'}],defaultReasoningEffort:'medium'},
];
class FakeCodex extends EventEmitter {
  constructor(){super();this.profile=createCodexSessionProfile(root,{profile:MODEL_WORKSPACE_SESSION_PROFILE});this.state={ready:true,error:false,mode:'document-workbench',message:'隔离测试连接',toolCount:this.profile.toolNames.length,connectionGeneration:1,codexAccount:{status:'verified',connectionGeneration:1,accountRevision:0,observationSequence:1,observedAt:new Date().toISOString(),stableAccountId:null,workspaceId:null}};this.turns=[];this.answers=[];this.steers=[];this.interrupts=[];this.timers=new Set();}
  later(fn){const t=setTimeout(()=>{this.timers.delete(t);fn();},100);this.timers.add(t);}
  async listModels(){return structuredClone(models);}
  assertModelSelection(model,{effort,requiresImages}={}){const item=models.find(x=>x.model===model);if(!item||requiresImages&&!item.inputModalities.includes('image')||effort!==undefined&&!item.supportedReasoningEfforts.some(x=>x.reasoningEffort===effort))throw new Error('隔离测试：模型能力不匹配');}
  async newThread(){return 'fixture-thread';}
  async turn(threadId,text,images,model,effort){this.assertModelSelection(model,{effort});const turn={threadId,turnId:'fixture-turn',text,images,model,effort};this.turns.push(turn);this.later(()=>this.ask(turn));return {turn:{id:turn.turnId}};}
  ask(turn){let pending=true;this.emit('user-input-request',{id:77,generation:1,revision:0,params:{threadId:turn.threadId,turnId:turn.turnId,itemId:'fixture-question',isBlocking:true,questions:[{id:'choice',header:'测试',question:'选择隔离测试方案',isOther:false,options:[{label:'方案甲',description:'仅测试'},{label:'方案乙',description:'仅测试'}]}]},respond:value=>{if(!pending)return false;pending=false;this.answers.push(value);return true;},reject:()=>{pending=false;},discard:()=>{pending=false;}});}
  async steer(threadId,turnId,text,requestId){this.steers.push({threadId,turnId,text,requestId});return {turnId};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});this.later(()=>this.emit('notification','turn/completed',{threadId,turnId,turn:{id:turnId,status:'interrupted'}}));}
  async close(){for(const timer of this.timers)clearTimeout(timer);this.timers.clear();return {closed:true};}
  failed(){}
}

const fake=new FakeCodex();let fixture,browser;
try{
  fixture=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,codexClient:fake});
  const port=new URL(fixture.origin).port;if(port==='41873')throw new Error('Refusing the live BuildX port.');
  browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  const page=await browser.newPage();page.setDefaultTimeout(10000);const requests=[],blocked=[];
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==fixture.origin){blocked.push(url.origin);return route.abort();}return route.continue();});
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===fixture.origin&&request.method()==='POST'&&url.pathname.startsWith('/api/'))requests.push({path:url.pathname,body:request.postDataJSON()});});
  await page.goto(fixture.origin,{waitUntil:'domcontentloaded'});
  await page.locator('.model-picker-toggle').waitFor({state:'visible'});
  await page.locator('.model-picker-toggle').click();
  await page.locator('#model-picker-select').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#model-picker-select')?.options.length===2);
  await page.selectOption('#model-picker-select','fixture-b');
  await page.locator('#model-picker-effort').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#model-picker-effort').getAttribute('aria-valuetext'),'高');
  await page.setViewportSize({width:380,height:800});
  const sliderBox=await page.locator('#model-picker-effort').boundingBox();
  assert.ok(sliderBox&&sliderBox.x>=0&&sliderBox.x+sliderBox.width<=380,'reasoning slider must fit narrow windows');
  await page.setViewportSize({width:1280,height:720});
  await page.locator('#prompt').fill('隔离验证：开始对话');
  await page.locator('#send').click();
  await page.locator('#user-input').waitFor({state:'visible'});
  const browserClient=requests.find(x=>x.path==='/api/turn').body.client,question=fixture.app.snapshot(browserClient).userInput;
  assert.ok(question);assert.equal(fixture.app.snapshot('different-browser').userInput,null);
  const foreignAnswer=await fixture.post('user-input',{client:'different-browser',conversationId:question.conversationId,requestId:question.id,answers:{choice:'方案乙'}});
  assert.equal(foreignAnswer.status,409);assert.equal(fake.answers.length,0);
  await page.locator('#user-input input[type=radio]').nth(1).check();
  await page.locator('#user-input button[type=submit]').click();
  await page.locator('#user-input').waitFor({state:'hidden'});
  await page.locator('#prompt').fill('隔离验证：补充要求');
  await page.locator('#steer').waitFor({state:'visible'});
  await page.locator('#steer').click();
  await page.locator('#steer-feedback').getByText('已接收',{exact:false}).waitFor();
  const foreignSteer=await fixture.post('steer',{client:'different-browser',conversationId:question.conversationId,turnId:'fixture-turn',requestId:'00000000-0000-4000-8000-000000000000',message:'未授权的补充'});
  assert.equal(foreignSteer.status,409);assert.equal(fake.steers.length,1);
  await page.locator('#stop').click();
  await page.locator('#stop').waitFor({state:'hidden'});
  assert.equal(fake.turns.length,1);assert.equal(fake.turns[0].model,'fixture-b');assert.equal(fake.turns[0].effort,'high');
  assert.equal(fake.answers.length,1);assert.deepEqual(fake.answers[0].answers.choice,{answers:['方案乙']});
  assert.equal(fake.steers.length,1);assert.equal(fake.steers[0].threadId,'fixture-thread');assert.equal(fake.steers[0].turnId,'fixture-turn');assert.equal(fake.steers[0].text,'隔离验证：补充要求');
  assert.deepEqual(fake.interrupts,[{threadId:'fixture-thread',turnId:'fixture-turn'}]);
  for(const route of ['/api/models','/api/turn','/api/user-input','/api/steer','/api/interrupt'])assert.ok(requests.some(x=>x.path===route),route);
  const submissions=requests.filter(x=>['/api/turn','/api/user-input','/api/steer','/api/interrupt'].includes(x.path));
  assert.equal(new Set(submissions.map(x=>x.body.client)).size,1);
  const turnRequest=submissions.find(x=>x.path==='/api/turn');assert.equal(turnRequest.body.model,'fixture-b');assert.equal(turnRequest.body.effort,'high');
  const steerRequest=submissions.find(x=>x.path==='/api/steer');assert.equal(steerRequest.body.turnId,'fixture-turn');assert.match(steerRequest.body.requestId,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({ok:true,scope:'real Chromium + production HTTP/SSE/UI, synthetic Codex; no Revit or model inference',checks:['model','reasoning effort','question','steer','interrupt','client ownership'],nativeCodexProcesses:0,realRevitReads:0,realAccountRequests:0}));
}finally{if(browser)await browser.close();if(fixture)await fixture.close();}
