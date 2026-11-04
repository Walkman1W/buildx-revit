// Real Edge + production HTTP/SSE/assets, with synthetic model command results.
// This script never connects to the installed BuildX service or a Revit host.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const require=createRequire(import.meta.url);
let chromium;
try {({chromium}=require('playwright'));}
catch {({chromium}=require(path.resolve(path.dirname(process.execPath),'..','node_modules','playwright')));}
const root=fileURLToPath(new URL('..',import.meta.url));
const browserPath=process.env.BUILDX_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output=path.join(root,'artifacts','command-forms-validation-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
await mkdir(output,{recursive:true});
const source={session:'isolated-command-forms-host',title:'交互验证样例.rvt',path:'D:\\isolated-command-forms\\sample.rvt'};
const document={title:source.title,path:source.path};
const parameters=[
  {parameter_id:-1001105,name:'高度',storage_type:'Double',is_read_only:false,has_value:true,data_type:'autodesk.spec.aec:length-2.0.0',unit_type:'autodesk.unit.unit:millimeters-1.0.1',value_internal:3000/304.8,value_display:'3000'},
  {parameter_id:601,name:'备注',storage_type:'String',is_read_only:false,has_value:true,data_type:'autodesk.spec:string.text-2.0.0',value_internal:'原备注',value_display:'原备注'},
  {parameter_id:602,name:'启用',storage_type:'Integer',is_read_only:false,has_value:true,data_type:'autodesk.spec:spec.bool-1.0.0',value_internal:1,value_display:'是'},
  {parameter_id:603,name:'只读项',storage_type:'String',is_read_only:true,has_value:true,value_internal:'不可编辑'},
];
const personalCommand={command_id:'sample',revision:'a'.repeat(64),name:'批量备注',description:'自定义说明',parameters:{count:'integer',enabled:'boolean',note:'string'},parameter_labels:{count:'数量',enabled:'启用',note:'备注'},verification:{status:'unverified'}};
const calls=[],requests=[],pageErrors=[],consoleErrors=[],httpErrors=[],blocked=[],checks=[];
let fixture,browser,page;
const result={ok:false,scope:'real Edge + production HTTP/SSE/UI; synthetic model receipts; no real Revit, native Codex or provider inference',output};
const record=name=>checks.push(name);
try {
  fixture=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,historyDirectory:path.join(output,'isolated-history'),invokeReadonlyCommand:async(command,chosen,options)=>{
    calls.push({command,parameters:structuredClone(chosen),confirmed:options.confirmed===true,sourceDocument:options.sourceDocument??null});
    let data;
    if(command==='selection')data={items:[{element_id:'42',name:'样例墙',category:'墙'},{element_id:'84',name:'样例设备',category:'机械设备'}],total:2,returned:2,truncated:false};
    else if(command==='revit_describe_parameters')data={value:{element_id:chosen.element_id,element_name:chosen.element_id===42?'样例墙':'样例设备',parameters}};
    else if(command==='levels')data={items:[{element_id:'10',name:'首层',elevation_mm:0},{element_id:'20',name:'二层',elevation_mm:3600}],total:2};
    else if(command==='revit_list_family_types')data={value:{items:[{element_id:100,name:'200 mm',family_name:'样例基本墙',class_name:'WallType'}],total:1,limit:50,offset:0,has_more:false}};
    else if(command==='revit_list_commands')data={value:{commands:[personalCommand],total:1,limit:20,offset:0,has_more:false}};
    else if(command==='revit_get_command')data={value:{...personalCommand,code:'return new { count, enabled, note };'}};
    else if(command==='revit_run_command')data={value:{preview:true,parameters:chosen.parameters}};
    else if(['revit_set_parameters','revit_move_elements'].includes(command))data={value:{applied:chosen.mode==='commit',preview:chosen.mode==='rollback',parameters:chosen}};
    else if(command==='document')data={activeView:{id:'12',type:'ThreeD'}};
    else throw new Error('Unexpected isolated command: '+command);
    return {ok:true,value:{command,tool:command,operation:command,hostSession:source.session,document,requestIds:[],data}};
  }});
  assert.notEqual(new URL(fixture.origin).port,'41873');
  browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  page=await browser.newPage({viewport:{width:1000,height:1000}});page.setDefaultTimeout(10000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)httpErrors.push({status:response.status(),url:response.url()});});
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===fixture.origin&&request.method()==='POST'&&url.pathname.startsWith('/api/'))requests.push({path:url.pathname,body:request.postDataJSON()});});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==fixture.origin){blocked.push(url.origin);return route.abort();}return route.continue();});
  await page.goto(fixture.origin,{waitUntil:'domcontentloaded'});
  await page.getByRole('tab',{name:'命令',exact:true}).click();
  const open=async(id,search)=>{
    await page.locator('.model-command-filter').fill(search);
    const row=page.locator('.model-command-item[data-command-id="'+id+'"]');
    if(await row.locator('.model-command-parameters').isHidden())await row.locator('.model-command-apply').click();
    await row.locator('.model-command-parameters').waitFor({state:'visible'});return row;
  };
  const waitForCall=async(command,count)=>{await page.waitForFunction(({command,count})=>window.__commandFormCalls?.[command]>=count,{command,count});};
  // Keep completion observation outside application state. The page marker only
  // counts HTTP responses; no application handler or UI state is replaced.
  const responseCounts={};page.on('response',async response=>{
    if(new URL(response.url()).pathname!=='/api/command')return;
    const body=response.request().postDataJSON(),id=body.commandId;
    responseCounts[id]=(responseCounts[id]??0)+1;
    try{await page.evaluate(({id,count})=>{window.__commandFormCalls??={};window.__commandFormCalls[id]=count;},{id,count:responseCounts[id]});}catch{}
  });
  const row=await open('revit_set_parameters','修改参数'),base='#model-command-revit_set_parameters-changes';
  assert.equal(await row.locator('textarea').count(),0);
  await page.locator(base+'-read-selection').click();
  await page.locator(base+'-element option[value="42"]').waitFor({state:'attached'});
  await page.locator(base+'-element').selectOption('42');
  await page.locator(base+'-read-parameters').click();
  await page.locator(base+'-parameter option[value="-1001105"]').waitFor({state:'attached'});
  assert.equal(await page.locator(base+'-parameter option[value="603"]').count(),0);
  await page.locator(base+'-parameter').selectOption('-1001105');
  assert.equal(await page.locator(base+'-number').inputValue(),'3000');
  await page.locator(base+'-number').fill('3200.5');await page.locator(base+'-add').click();
  await row.locator('.parameter-change-list').getByText('3200.5 mm',{exact:true}).waitFor();
  const confirm=row.locator('.model-command-confirm input');
  await confirm.check();await page.locator(base+'-parameter').selectOption('601');assert.equal(await confirm.isChecked(),false);
  await page.locator(base+'-value').fill('浏览器验证备注');await page.locator(base+'-add').click();
  await page.locator(base+'-parameter').selectOption('602');await page.locator(base+'-yesno').selectOption('0');await page.locator(base+'-add').click();
  await confirm.check();await row.locator('.model-command-run').click();await waitForCall('revit_set_parameters',1);
  await page.waitForFunction(()=>!document.querySelector('#model-command-revit_set_parameters-mode')?.disabled);
  const writes=()=>requests.filter(request=>request.path==='/api/command'&&request.body.commandId==='revit_set_parameters');
  assert.equal(writes().length,1);const preview=writes()[0].body;
  assert.equal(preview.confirmed,true);assert.equal(preview.parameters.mode,'rollback');assert.deepEqual(preview.sourceDocument,source);
  assert.equal(preview.parameters.changes.length,3);
  assert.ok(Math.abs(preview.parameters.changes[0].value-3200.5/304.8)<1e-12);
  assert.deepEqual(preview.parameters.changes[0],{element_id:42,parameter_id:-1001105,value:3200.5/304.8,value_unit:'internal'});
  assert.deepEqual(preview.parameters.changes[1],{element_id:42,parameter_id:601,value:'浏览器验证备注'});
  assert.deepEqual(preview.parameters.changes[2],{element_id:42,parameter_id:602,value:0});
  assert.equal(await confirm.isChecked(),false);
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:path.join(output,'parameters-wide.png'),fullPage:true});
  await page.setViewportSize({width:380,height:980});
  const parameterOverflow=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert.ok(parameterOverflow.document<=parameterOverflow.viewport,JSON.stringify(parameterOverflow));
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:path.join(output,'parameters-narrow.png'),fullPage:true});record('parameter editor fits a 380px viewport');
  await page.setViewportSize({width:1000,height:1000});
  await row.locator('select[id$="-mode"]').selectOption('commit');
  await confirm.check();await row.locator('.model-command-run').click();await waitForCall('revit_set_parameters',2);
  assert.equal(writes()[1].body.parameters.mode,'commit');record('parameter selection, length mm conversion, text and yes/no typing, preview/apply and confirmation invalidation');
  const move=await open('revit_move_elements','移动元素');assert.equal(await move.locator('textarea').count(),0);
  const selected=move.locator('#model-command-revit_move_elements-element_ids-choice');
  await selected.locator('..').getByRole('button',{name:'使用当前选择',exact:true}).click();
  await selected.locator('option').filter({hasText:'已选择 2 个构件'}).waitFor({state:'attached'});
  for(const [axis,value] of Object.entries({x:'120.5',y:'-25',z:'0'}))await move.locator('#model-command-revit_move_elements-delta_mm-'+axis).fill(value);
  await move.locator('.model-command-confirm input').check();await move.locator('.model-command-run').click();await waitForCall('revit_move_elements',1);
  const moved=requests.find(request=>request.path==='/api/command'&&request.body.commandId==='revit_move_elements').body;
  assert.deepEqual(moved.parameters.element_ids,[42,84]);assert.deepEqual(moved.parameters.delta_mm,{x:120.5,y:-25,z:0});assert.deepEqual(moved.sourceDocument,source);
  record('move command uses current selection and three typed numeric coordinates without JSON');
  const wall=await open('revit_create_wall','创建墙');
  for(const [key,read,value] of [['level_id','读取标高','20'],['wall_type_id','读取墙类型','100']]) {
    const choice=wall.locator('#model-command-revit_create_wall-'+key+'-choice');
    await choice.locator('..').getByRole('button',{name:read,exact:true}).click();
    await choice.locator('option[value="'+value+'"]').waitFor({state:'attached'});await choice.selectOption(value);assert.equal(await choice.inputValue(),value);
  }
  record('model levels and wall types are selected from native dropdowns');
  await page.setViewportSize({width:380,height:980});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:path.join(output,'wall-narrow.png'),fullPage:true});
  await page.setViewportSize({width:1000,height:1000});
  await page.getByRole('tab',{name:'对话',exact:true}).click();
  await page.locator('#prompt').fill('已有对话草稿，仅用于隔离验证');
  await page.getByRole('tab',{name:'命令',exact:true}).click();
  await page.locator('.model-command-filter').fill('');
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:path.join(output,'system-commands.png'),fullPage:true});
  await page.getByRole('tab',{name:'个人',exact:true}).click();
  assert.equal(await page.locator('.model-command-item[data-command-id="revit_list_commands"]').isVisible(),true);
  assert.equal(await page.locator('.model-command-item[data-command-id="revit_create_wall"]').isVisible(),false);
  const library=page.locator('.model-command-item[data-command-id="revit_list_commands"]');
  await library.locator('.model-command-version-view').waitFor({state:'visible'});
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:path.join(output,'personal-commands.png'),fullPage:true});
  await page.locator('#model-create-command').screenshot({path:path.join(output,'create-command-entry.png')});
  await library.locator('.model-command-version-view').click();
  const readVersion=page.locator('.model-command-item[data-command-id="revit_get_command"]');
  await readVersion.locator('.model-command-version-choose').click();
  const runVersion=page.locator('.model-command-item[data-command-id="revit_run_command"]');
  assert.equal(await runVersion.locator('textarea').count(),0);
  await runVersion.getByLabel('数量',{exact:true}).fill('3');
  await runVersion.getByLabel('启用',{exact:true}).selectOption('false');
  await runVersion.getByLabel('备注',{exact:true}).fill('个人参数输入');
  const runConfirmation=runVersion.locator('.model-command-confirm input');await runConfirmation.check();
  await runVersion.getByLabel('数量',{exact:true}).fill('4');assert.equal(await runConfirmation.isChecked(),false);
  assert.equal(await runVersion.getByLabel('启用',{exact:true}).inputValue(),'false');
  assert.equal(await runVersion.getByLabel('备注',{exact:true}).inputValue(),'个人参数输入');
  await runConfirmation.check();await runVersion.locator('.model-command-run').click();await waitForCall('revit_run_command',1);
  const personalRun=requests.find(request=>request.path==='/api/command'&&request.body.commandId==='revit_run_command').body;
  assert.equal(personalRun.parameters.command_id,'sample');assert.equal(personalRun.parameters.revision,'a'.repeat(64));
  assert.equal(personalRun.parameters.mode,'rollback');assert.deepEqual(personalRun.parameters.parameters,{count:4,enabled:false,note:'个人参数输入'});
  record('saved personal revision produces Chinese-labelled number, yes/no and text controls without JSON; full revision and confirmation remain bound');
  await page.setViewportSize({width:1000,height:1200});
  await runVersion.screenshot({path:path.join(output,'personal-run-card.png')});
  await page.setViewportSize({width:1000,height:1000});
  const oldConversation=requests.find(request=>request.path==='/api/command').body.conversationId;
  const createdResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/new-chat');
  await page.locator('#model-create-command').click();
  const created=await (await createdResponse).json();
  assert.equal(created.ok,true);assert.notEqual(created.session.conversation.id,oldConversation);
  assert.deepEqual(created.session.messages,[]);
  await page.waitForFunction(()=>document.body.dataset.modelView==='chat'&&document.querySelector('#prompt').value.includes('我想创建一个个人命令'));
  assert.match(await page.locator('#prompt').inputValue(),/不要自动执行/);
  const createRequest=requests.find(request=>request.path==='/api/new-chat');assert.equal(createRequest.body.draft.text,'已有对话草稿，仅用于隔离验证');
  await page.screenshot({path:path.join(output,'command-authoring-chat.png'),fullPage:true});
  record('system/personal categories and create command open a distinct empty chat, preserve the prior draft and prefill guidance without sending a turn');
  assert.equal(requests.filter(request=>request.path==='/api/turn').length,0);assert.equal(fixture.codex.turns.length,0);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(httpErrors,[]);assert.deepEqual(blocked,[]);record('no AI turn, external network request, or browser page error');
  Object.assign(result,{ok:true,checks,parameterOverflow,commandRequests:requests.filter(request=>request.path==='/api/command'),upstreamCalls:calls,nativeCodexProcesses:0,realRevitReads:0,realAccountRequests:0});
}catch(error){
  result.error=error.stack??String(error);result.checks=checks;result.requests=requests;result.upstreamCalls=calls;result.pageErrors=pageErrors;result.consoleErrors=consoleErrors;result.httpErrors=httpErrors;result.blocked=blocked;
  if(page)try{await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}
  process.exitCode=1;
}finally{
  if(browser)await browser.close();if(fixture)await fixture.close();
  await writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:result.ok,output,checks,error:result.error??null}));
}
