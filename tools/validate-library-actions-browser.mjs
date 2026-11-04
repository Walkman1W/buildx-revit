// Isolated Edge acceptance of the production HTTP/SSE/UI and filesystem owner.
// No installed BuildX, real Revit, native Codex, Windows opener or network.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createModelWorkspaceFixture} from '../test-support/model-workspace-preview.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';

const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require('playwright'));}catch{({chromium}=require(path.resolve(path.dirname(process.execPath),'..','node_modules','playwright')));}
const root=fileURLToPath(new URL('..',import.meta.url));
const browserPath=process.env.BUILDX_TEST_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output=path.join(root,'artifacts','library-actions-validation-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
const samples=path.join(output,'资料样例');
await mkdir(samples,{recursive:true});
await writeFile(path.join(samples,'说明.txt'),'资料库测试文本\n','utf8');
await copyFile(path.join(root,'public','bim-x-logo.png'),path.join(samples,'图片.png'));
const python=spawnSync('python',['-c',`import sys,zipfile
xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>资料库文档文本</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z: z.writestr('word/document.xml',xml.encode('utf-8'))`,path.join(samples,'样例.docx')],{encoding:'utf8',windowsHide:true,timeout:10000});
if(python.status!==0)throw new Error('Cannot create isolated DOCX: '+python.stderr);
const calls=[],requests=[],checks=[],pageErrors=[],blocked=[];
let fixture,browser,page;
const result={ok:false,scope:'real Edge and production HTTP/SSE/UI with isolated filesystem, fake opener and fake upstream; no real Revit or external network',output};
const materialOpener=Object.freeze({async open(target){calls.push(structuredClone(target));return {ok:true,value:{accepted:true}};},async close(){return {closed:true};}});
try{
  fixture=await createModelWorkspaceFixture({profile:MODEL_WORKSPACE_SESSION_PROFILE,required:false,historyDirectory:path.join(output,'history'),materialOpener});
  assert.notEqual(new URL(fixture.origin).port,'41873');
  browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  page=await browser.newPage({viewport:{width:1000,height:900}});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===fixture.origin&&request.method()==='POST'&&url.pathname.startsWith('/api/')){const body=request.postDataJSON();requests.push({path:url.pathname,action:body.action,parameters:body.parameters});}});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==fixture.origin){blocked.push(url.origin);return route.abort();}return route.continue();});
  await page.goto(fixture.origin,{waitUntil:'domcontentloaded'});
  await page.locator('#prompt').fill('已有对话草稿');
  const knowledge=page.getByRole('tab',{name:'资料库',exact:true});
  await knowledge.click();
  await page.locator('.project-files-manual').click();
  await page.locator('.project-files-kind').selectOption('directory');
  await page.locator('.project-files-path').fill(samples);
  await page.locator('.project-files-save').click();
  const card=page.locator('.project-files-root').filter({hasText:'资料样例'});
  await card.waitFor();
  const expand=async()=>{const folder=card.locator('details.project-files-directory').first();if(!await folder.evaluate(node=>node.open))await folder.locator('summary').first().click();await card.locator('.project-files-file-row').first().waitFor();};
  const row=name=>card.locator('.project-files-file-row').filter({hasText:name});
  await expand();
  const textRow=row('说明.txt');
  const before=requests.length;
  await textRow.locator('.project-files-file').click();
  assert.equal(await textRow.locator('.project-files-file').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.project-files-preview').count(),0);
  assert.equal(requests.slice(before).filter(item=>['read-file','read-attachment'].includes(item.action)).length,0);
  checks.push('selecting a file makes no content request or preview');
  await textRow.locator('summary').click();await textRow.locator('.project-files-open-file').click();
  await page.waitForFunction(()=>document.querySelector('.project-files-status')?.textContent.includes('已请求'));
  await textRow.locator('summary').click();await textRow.locator('.project-files-open-folder').click();
  for(let i=0;i<100&&calls.length<2;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(calls,[{path:path.join(samples,'说明.txt'),kind:'file'},{path:samples,kind:'directory'}]);
  const opened=requests.filter(item=>['open-file','open-folder'].includes(item.action));
  assert.deepEqual(opened.map(item=>item.action),['open-file','open-folder']);
  assert.equal(opened[0].parameters.path,'说明.txt');assert.equal(opened[1].parameters.path,'说明.txt');
  assert.equal(opened[0].parameters.rootId,opened[1].parameters.rootId);assert.ok(opened[0].parameters.rootId);
  checks.push('both menu actions resolve the selected file and folder through the injected opener');
  const layout=async()=>page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  let width=await layout();assert.ok(width.document<=width.viewport,JSON.stringify(width));
  await page.screenshot({path:path.join(output,'library-wide.png'),fullPage:true});
  await page.setViewportSize({width:380,height:900});
  await textRow.locator('summary').click();
  width=await layout();assert.ok(width.document<=width.viewport,JSON.stringify(width));
  const menu=await textRow.locator('.project-files-file-menu-options').boundingBox();assert.ok(menu&&menu.x>=0&&menu.x+menu.width<=width.viewport,JSON.stringify(menu));
  await page.screenshot({path:path.join(output,'library-narrow.png'),fullPage:true});
  await textRow.locator('summary').click();
  checks.push('wide and 380px layouts and the open menu fit the viewport');
  const add=async(name)=>{
    await row(name).locator('.project-files-add-context').click();
    await page.waitForFunction(()=>document.body.dataset.modelView==='chat');
    await page.locator('.model-pending-file').filter({hasText:name}).waitFor();
    assert.equal(await page.locator('#prompt').inputValue(),'已有对话草稿');
  };
  const returnToKnowledge=async()=>{
    const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project-files'&&response.request().postDataJSON()?.action==='list-roots');
    await knowledge.click();await refreshed;
    await page.waitForFunction(()=>document.querySelector('.project-files-status')?.textContent!=='正在读取资料库…');
    await expand();
  };
  await add('说明.txt');
  await returnToKnowledge();await add('图片.png');
  await returnToKnowledge();await add('样例.docx');
  const doc=page.locator('.model-pending-file').filter({hasText:'样例.docx'});
  assert.match(await doc.innerText(),/提取文本/);
  assert.match(await page.locator('.model-pending-file').filter({hasText:'图片.png'}).innerText(),/图片/);
  assert.equal(requests.filter(item=>item.path==='/api/turn').length,0);assert.equal(fixture.codex.turns.length,0);
  assert.equal(requests.filter(item=>item.action==='read-file').length,0);
  assert.equal(requests.filter(item=>item.action==='read-attachment').length,3);
  assert.deepEqual(blocked,[]);assert.deepEqual(pageErrors,[]);
  await page.screenshot({path:path.join(output,'chat-attachments.png'),fullPage:true});
  checks.push('text, image and extracted DOCX reach chat; draft preserved and no turn sent');
  Object.assign(result,{ok:true,checks,calls,requests,blocked,pageErrors});
}catch(error){
  Object.assign(result,{error:error.stack??String(error),checks,calls,requests,blocked,pageErrors});
  if(page)try{await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}
  process.exitCode=1;
}finally{
  if(browser)await browser.close();if(fixture)await fixture.close();
  await writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:result.ok,output,checks,error:result.error??null}));
}
