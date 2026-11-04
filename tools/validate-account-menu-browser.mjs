// Real Edge and production HTTP/SSE/assets with controlled account/Codex peers.
// This script never connects to an installed BuildX service or a Revit host.
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
const executablePath=process.env.BUILDX_TEST_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output=path.join(root,'artifacts','account-menu-validation-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
await mkdir(output,{recursive:true});
const checks=[],requests=[],pageErrors=[],consoleErrors=[],httpErrors=[],blocked=[],overflow=[];
let injectedRefreshFailures=0;
const record=name=>checks.push(name);
const result={ok:false,scope:'real Edge + production HTTP/SSE/UI; controlled account/Codex peers; no real account, native Codex, provider inference, or Revit',output};
let fixture,browser,context,page,registration;

async function noOverflow(target,label,selector){
  const value=await target.evaluate(selector=>{
    const node=document.querySelector(selector),bounds=node?.getBoundingClientRect();
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      left:bounds?.left??null,right:bounds?.right??null,
      elementScrollWidth:node?.scrollWidth??null,elementClientWidth:node?.clientWidth??null};
  },selector);
  overflow.push({label,...value});
  assert.ok(value.scrollWidth<=value.width,label+' document overflows');
  assert.ok(value.left!==null&&value.left>=-1&&value.right<=value.width+1,label+' surface exceeds viewport');
  assert.ok(value.elementScrollWidth<=value.elementClientWidth+1,label+' contents overflow');
}

try {
  fixture=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:true});
  assert.notEqual(new URL(fixture.origin).port,'41873');
  browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  context=await browser.newContext({viewport:{width:938,height:1000}});
  context.setDefaultTimeout(10000);
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==fixture.origin){blocked.push({origin:url.origin,path:url.pathname});return route.abort();}
    return route.continue();
  });
  context.on('page',target=>{
    target.on('pageerror',error=>pageErrors.push(error.message));
    target.on('console',message=>{
      if(message.type()!=='error')return;
      const location=message.location();
      consoleErrors.push({message:message.text(),url:location.url,
        expected:injectedRefreshFailures===1&&location.url===fixture.origin+'/api/account/status'&&message.text().includes('503')});
    });
  });
  context.on('response',response=>{
    if(response.status()<400)return;
    const pathname=new URL(response.url()).pathname;
    httpErrors.push({status:response.status(),path:pathname,
      expected:injectedRefreshFailures===1&&pathname==='/api/account/status'&&response.status()===503});
  });
  context.on('request',request=>{
    const url=new URL(request.url());
    if(url.origin!==fixture.origin||request.method()!=='POST')return;
    const body=request.postDataJSON();
    // Capture the actual submitted shape without retaining passwords or challenges.
    requests.push({path:url.pathname,body:Object.fromEntries(Object.entries(body??{}).map(([key,value])=>[key,['password','challengeId'].includes(key)?'[fixture value omitted]':value]))});
  });
  page=await context.newPage();
  await page.goto(fixture.origin,{waitUntil:'load'});
  await page.waitForFunction(()=>document.body.dataset.modelReady==='true');
  await page.waitForFunction(()=>document.querySelector('#account-summary')?.textContent==='未登录');
  const avatar=page.locator('#model-account-toggle'),menu=page.locator('#model-account-menu'),drawer=page.locator('#model-account-drawer');
  assert.equal(await menu.isVisible(),false);assert.equal(await drawer.isVisible(),false);
  assert.equal(requests.length,0);record('signed-out workspace starts with both menu and large dialog closed and no automatic POST');

  await avatar.click();await menu.waitFor({state:'visible'});
  assert.equal(await avatar.getAttribute('aria-expanded'),'true');
  await menu.screenshot({path:path.join(output,'menu-detail.png')});
  assert.equal(await page.locator('#model-account-login').evaluate(node=>document.activeElement===node),true);
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  assert.equal(await avatar.evaluate(node=>document.activeElement===node),true);
  await avatar.click();await page.locator('.identity h1').click();await menu.waitFor({state:'hidden'});
  await avatar.click();await page.locator('#model-connection-guide').focus();await page.keyboard.press('Tab');await menu.waitFor({state:'hidden'});
  assert.equal(await menu.evaluate(node=>node.contains(document.activeElement)),false);
  record('popover opens from avatar; Escape returns focus; outside click and natural Tab exit close it without a focus trap');

  await avatar.click();await page.locator('#model-account-login').click();
  await drawer.locator('[role="dialog"]').waitFor({state:'visible'});
  assert.equal(await drawer.getAttribute('data-view'),'account');
  assert.equal(await page.locator('#account-email').isVisible(),true);
  for(const selector of ['.connection','#codex-account-panel','.tools-panel','#model-permission-info','#model-mcp-candidates','section[aria-label="软件授权"]'])
    assert.equal(await drawer.locator(selector).isVisible(),false,'account form hides '+selector);
  record('login dialog exposes account form while connection, catalog, permissions, MCP, and license sections stay hidden');
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
  assert.equal(await avatar.evaluate(node=>document.activeElement===node),true);

  await avatar.click();await page.locator('#model-connection-guide').click();
  assert.equal(await drawer.getAttribute('data-view'),'guide');
  assert.match(await drawer.innerText(),/连接说明待接入/);
  assert.equal(await page.locator('#account-email').isVisible(),false);
  await page.keyboard.press('Escape');
  record('connection guide opens its explicit pending-integration state without an external request');

  // Registration must be reached through the real new-window link, including noopener.
  await avatar.click();
  const popup=context.waitForEvent('page');
  await page.locator('#model-account-register').click();registration=await popup;
  await registration.waitForLoadState('load');
  assert.equal(registration.url(),fixture.origin+'/register.html');
  assert.equal(await registration.evaluate(()=>window.opener===null),true);
  assert.equal(await registration.locator('input').count(),3);
  assert.equal(await registration.locator('input:disabled').count(),3);
  assert.equal(await registration.getByRole('button',{name:'注册暂未开放'}).isDisabled(),true);
  assert.match(await registration.locator('#registration-status').innerText(),/暂未开放注册/);
  assert.equal(await registration.locator('script').count(),0);
  assert.equal(requests.some(request=>request.path==='/api/account/sign-up'),false);
  record('invite registration opens a separate same-origin page with no opener, three disabled fields, and no signup submission');

  for(const width of [320,420,938]){
    await page.setViewportSize({width,height:1000});
    await page.bringToFront();
    if(await menu.isHidden())await avatar.click();
    await noOverflow(page,'menu-'+width,'#model-account-menu');
    await page.screenshot({path:path.join(output,'menu-'+width+'.png'),fullPage:true});
    await page.locator('#model-account-login').click();
    await noOverflow(page,'login-'+width,'.model-account-dialog');
    await page.screenshot({path:path.join(output,'login-'+width+'.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await registration.setViewportSize({width,height:1000});
    await registration.bringToFront();
    await noOverflow(registration,'registration-'+width,'.registration');
    await registration.screenshot({path:path.join(output,'registration-'+width+'.png'),fullPage:true});
  }
  record('menu, login, and registration fit 320, 420, and 938 pixel widths without horizontal overflow');
  await registration.close();registration=null;
  await page.setViewportSize({width:938,height:1000});
  await page.bringToFront();

  if(await menu.isHidden())await avatar.click();
  await page.locator('#model-account-login').click();
  await page.locator('#account-email').fill('demo@example.invalid');
  await page.locator('#account-password').fill('fixture-password');
  const loginResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/sign-in');
  await page.locator('#account-sign-in').click();assert.equal((await loginResponse).status(),200);
  await page.waitForFunction(()=>document.querySelector('#model-account-menu-title')?.textContent==='demo@example.invalid');
  assert.equal(await page.locator('#account-password').inputValue(),'');
  assert.equal(requests.filter(request=>request.path==='/api/codex-account/inspect').length,0);
  assert.equal(requests.filter(request=>request.path==='/api/codex-account/confirm').length,0);
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await drawer.getAttribute('data-view'),'account');
  await page.route(fixture.origin+'/api/account/status',route=>{
    injectedRefreshFailures++;
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'controlled account refresh failure'})});
  },{times:1});
  const failedRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/status'&&response.status()===503);
  await page.locator('#account-refresh').click();await failedRefresh;
  await page.waitForFunction(()=>document.querySelector('#account-summary')?.textContent==='待检查');
  await page.waitForFunction(()=>document.querySelector('#model-account-menu-title')?.textContent==='BuildX 账号');
  assert.doesNotMatch(await menu.textContent(),/demo@example\.invalid/);
  await page.keyboard.press('Escape');await avatar.click();
  await page.screenshot({path:path.join(output,'menu-refresh-failed.png'),fullPage:true});
  await page.locator('#model-account-login').click();
  await page.locator('#account-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#account-summary')?.textContent==='已登录');
  await page.waitForFunction(()=>document.querySelector('#model-account-menu-title')?.textContent==='demo@example.invalid');
  assert.equal(requests.filter(request=>request.path==='/api/account/sign-in').length,1);
  assert.equal(injectedRefreshFailures,1);
  record('one controlled account-status 503 immediately removes the old menu email; deliberate GET refresh restores verified display without replaying credentials');
  if(await drawer.getAttribute('data-view')!=='connection'){
    await page.keyboard.press('Escape');
    await page.locator('#model-tools-toggle').click();
  }
  await page.locator('#codex-account-inspect').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#codex-account-inspect').disabled);
  assert.equal(await page.locator('#codex-account-confirm').isDisabled(),true);
  const inspectResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/codex-account/inspect');
  await page.locator('#codex-account-inspect').click();assert.equal((await inspectResponse).status(),200);
  await page.waitForFunction(()=>!document.querySelector('#codex-account-confirm').disabled);
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(requests.filter(request=>request.path==='/api/codex-account/confirm').length,0);
  const confirmResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/codex-account/confirm');
  await page.locator('#codex-account-confirm').click();assert.equal((await confirmResponse).status(),200);
  await page.waitForFunction(()=>document.querySelector('#codex-account-summary')?.textContent==='本机连接已确认');
  assert.equal(requests.filter(request=>request.path==='/api/codex-account/inspect').length,1);
  assert.equal(requests.filter(request=>request.path==='/api/codex-account/confirm').length,1);
  record('successful login clears password and retains the explicit inspect-then-confirm Codex gate without automatic confirmation');
  await page.keyboard.press('Escape');
  await avatar.click();await menu.waitFor({state:'visible'});
  assert.equal(await page.locator('#model-account-menu-title').innerText(),'demo@example.invalid');
  assert.equal(await page.locator('#model-account-login').isVisible(),false);
  assert.equal(await page.locator('#model-account-signout').isVisible(),true);
  await page.screenshot({path:path.join(output,'menu-signed-in.png'),fullPage:true});
  await page.evaluate(()=>{
    window.__accountFocusTrace=[];
    document.addEventListener('focusin',event=>window.__accountFocusTrace.push(event.target.id||event.target.tagName));
  });
  const logoutResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/sign-out');
  await page.locator('#model-account-signout').click();assert.equal((await logoutResponse).status(),200);
  await page.waitForFunction(()=>document.querySelector('#model-account-menu-title')?.textContent==='BuildX 账号');
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#model-account-toggle'));
  assert.equal(await menu.isVisible(),false);
  await avatar.click();
  assert.equal(await page.locator('#model-account-login').isVisible(),true);
  assert.equal(await page.locator('#model-account-signout').isVisible(),false);
  assert.doesNotMatch(await menu.innerText(),/demo@example\.invalid/);
  assert.equal(await page.locator('#codex-account-email').innerText(),'');
  record('signed-in menu shows verified email and signout; signout closes the menu, returns focus to avatar, and removes old identity/observation before reopening');

  await page.keyboard.press('Escape');await page.locator('#model-tools-toggle').click();
  assert.equal(await drawer.getAttribute('data-view'),'connection');
  assert.equal(await page.locator('.tools-panel').isVisible(),true);
  assert.equal(await page.locator('#codex-account-panel').isVisible(),true);
  await page.screenshot({path:path.join(output,'connection-tools.png'),fullPage:true});
  record('tools entry retains the detailed connection and catalog dialog');
  assert.equal(requests.some(request=>request.path==='/api/account/sign-up'),false);
  assert.equal(requests.some(request=>request.path==='/api/turn'),false);
  assert.equal(fixture.codex.turns.length,0);assert.equal(fixture.workbenchCalls.length,0);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors.filter(error=>!error.expected),[]);assert.deepEqual(httpErrors.filter(error=>!error.expected),[]);assert.deepEqual(blocked,[]);
  assert.equal(httpErrors.filter(error=>error.expected).length,1);
  record('no signup, AI turn, external request, real model read, page error, or unexpected console/HTTP error; the injected refresh 503 is recorded separately');
  Object.assign(result,{ok:true,checks,requests,overflow,pageErrors,consoleErrors,httpErrors,blocked,
    upstreamCalls:fixture.authCalls,nativeCodexProcesses:0,realAccountRequests:0,realRevitReads:0});
}catch(error){
  Object.assign(result,{error:error.stack??String(error),checks,requests,overflow,pageErrors,consoleErrors,httpErrors,blocked});
  if(page)try{result.focus=await page.evaluate(()=>({active:document.activeElement?.id||document.activeElement?.tagName,menuHidden:document.querySelector('#model-account-menu')?.hidden,events:window.__accountFocusTrace??[]}));}catch{}
  if(page)try{await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}
  process.exitCode=1;
}finally{
  if(browser)await browser.close();
  if(fixture)await fixture.close();
  result.cleanup={browserClosed:!browser?.isConnected(),serverListening:fixture?.app.server.listening??false};
  await writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:result.ok,output,checks,error:result.error??null}));
}
