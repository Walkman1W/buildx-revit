import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {crc32, deflateSync} from 'node:zlib';
import {createPanelChatStore} from '../lib/chat-store.mjs';
import {createCodexSessionProfile, MODEL_WORKSPACE_SESSION_PROFILE} from '../lib/codex-profile.mjs';
import {createLocalChatTools} from '../lib/local-chat-tools.mjs';
import {validateExcelWorkbook, writeLocalExcel} from '../lib/local-excel.mjs';
import {createLocalImageGeneration} from '../lib/local-image-generation.mjs';
import {scanLocalPdf} from '../lib/local-scan-pdf.mjs';
import {createLocalWebSearch, validateLocalWebQuery} from '../lib/local-web-search.mjs';
import {createPanelServer} from '../lib/panel-server.mjs';

const program = fileURLToPath(new URL('../', import.meta.url));
const fixtureScript = fileURLToPath(new URL('../test-support/local-scan-pdf-fixture.py', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const native = {
  pythonExecutable: process.env.BUILDX_TEST_SCAN_PYTHON,
  ocrExecutable: process.env.BUILDX_TEST_SCAN_TESSERACT,
  ocrDataDirectory: process.env.BUILDX_TEST_SCAN_TESSDATA,
};
const excelPython = process.env.BUILDX_TEST_CHAT_TOOLS_EXCEL_PYTHON ?? native.pythonExecutable;
const excelDeps = process.env.BUILDX_TEST_CHAT_TOOLS_EXCEL_DEPS;
const font = process.env.BUILDX_TEST_SCAN_FONT;
const output = process.env.BUILDX_TEST_CHAT_TOOLS_XLSX_OUTPUT;
const canRunNative = [...Object.values(native),excelPython,font].every(file => typeof file === 'string' && path.isAbsolute(file));

class CodexPeer extends EventEmitter {
  state = {ready:true,error:false,mode:'document-workbench',connectionGeneration:1,codexAccount:{accountRevision:2}};
  outcomes = new Map();

  constructor(tools) {
    super();
    this.profile = Object.freeze({...createCodexSessionProfile(program,{profile:MODEL_WORKSPACE_SESSION_PROFILE}), dynamicTools:tools});
  }

  async newThread() { return 'local-tools-thread'; }

  async turn(threadId,text,localImages) {
    this.input = {threadId,text,localImages};
    return {turn:{id:'local-tools-turn'}};
  }

  async close() { return {closed:true}; }

  request(id, tool, args) {
    const params = Object.freeze({threadId:'local-tools-thread', turnId:'local-tools-turn', callId:`call-${id}`, tool,
      arguments:Object.freeze(args)});
    this.emit('dynamic-tool-request',{id,params,generation:1,revision:2,
      respond:value => { this.outcomes.set(id,value); return true; },
      reject:() => this.outcomes.set(id,{rejected:true}),
      discard:() => this.outcomes.set(id,{discarded:true})});
  }

  async answer(id) {
    const result = await waitFor(() => this.outcomes.get(id),`tool answer ${id}`);
    assert.ok(result.contentItems?.[0]?.text,JSON.stringify(result));
    return JSON.parse(result.contentItems[0].text);
  }
}

async function waitFor(observe, label) {
  const deadline = Date.now() + 12000;
  do {
    const value = observe();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(t, buildTools) {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const dataRoot = await fs.mkdtemp(path.join(temporaryParent,'BuildX-LocalChatHttp-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    const actual = await fs.realpath(dataRoot);
    assert.equal(path.dirname(actual),temporaryParent);
    assert.match(path.basename(actual),/^BuildX-LocalChatHttp-/);
    await fs.rm(actual,{recursive:true,force:true});
  });
  const localChatTools = createLocalChatTools({dataRoot,...await buildTools(dataRoot)});
  const codex = new CodexPeer(localChatTools.tools);
  const historyStore = createPanelChatStore({stateDirectory:path.join(dataRoot,'history')});
  app = createPanelServer({root:program,dataRoot,port:0,codex,profile:MODEL_WORKSPACE_SESSION_PROFILE,confirmedWrite:true,
    historyStore,localChatTools,invokeWorkbench:async () => { throw new Error('Local document tools should not call Revit'); }});
  const {origin} = await app.listen();
  const status = await (await fetch(origin+'/api/status')).json();

  async function request(route, payload, {requestOrigin=origin,csrf=status.csrf} = {}) {
    const response = await fetch(`${origin}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json',
      'X-Local-Chat':csrf,...requestOrigin?{Origin:requestOrigin}:{}},body:JSON.stringify({client:'browser',...payload}),
      signal:AbortSignal.timeout(8000)});
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status:response.status,headers:response.headers,bytes,
      body:response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : undefined};
  }
  const finish = () => codex.emit('notification','turn/completed',{threadId:'local-tools-thread',turn:{id:'local-tools-turn',status:'completed'}});
  return {app,codex,dataRoot,request,status,finish};
}

test('PDF attachment through local OCR and one confirmed XLSX download', {skip:!canRunNative}, async t => {
  let writes = 0, scans = 0;
  const {app,codex,dataRoot,request,status,finish} = await fixture(t,() => ({
    scanPdf:args => { scans++; return scanLocalPdf({...args,...native}); },
    validateWorkbook:validateExcelWorkbook,
    writeWorkbook:args => { writes++; return writeLocalExcel({...args,pythonExecutable:excelPython,dependencyPath:excelDeps}); },
  }));
  assert.equal(status.pdfAttachmentsAvailable,true);
  const sourcePath = path.join(dataRoot,'synthetic-pump-quote.pdf');
  await exec(native.pythonExecutable,['-E','-P','-B',fixtureScript,font,sourcePath],{windowsHide:true,timeout:30000});
  const pdf = await fs.readFile(sourcePath);

  const conversationId = app.snapshot('browser').session.conversation.id;
  const posted = await request('turn',{conversationId,message:'识别报价单并生成 Excel',attachments:[{
    name:'水泵报价单.pdf',mediaType:'application/pdf',data:pdf.toString('base64'),
  }]});
  assert.equal(posted.status,202,JSON.stringify(posted.body));
  const attachment = app.snapshot('browser').session.messages.find(message => message.role==='user').attachments[0];
  assert.equal(attachment.kind,'pdf');
  assert.equal(attachment.sha256,sha(pdf));
  assert.ok(codex.input.text.includes(attachment.id));
  assert.ok(codex.input.text.includes(attachment.sha256));
  assert.ok(!codex.input.text.includes(pdf.toString('base64')));
  assert.ok(!codex.input.text.includes(sourcePath));
  assert.deepEqual(codex.input.localImages,[]);

  codex.request(1,'buildx_ocr_pdf',{attachment_id:randomUUID(),pages:[1]});
  assert.equal((await codex.answer(1)).ok,false);
  assert.equal(scans,0);
  codex.request(2,'buildx_ocr_pdf',{attachment_id:attachment.id,pages:[1,2]});
  const recognized = await codex.answer(2);
  assert.equal(recognized.ok,true,JSON.stringify(recognized));
  assert.equal(recognized.value.pageCount,2);
  assert.equal(recognized.value.sha256,sha(pdf));
  assert.equal(scans,1);
  assert.equal(app.snapshot('browser').dynamicApproval,null);
  const [scan,digital] = recognized.value.pages;
  assert.equal(scan.page,1);
  assert.equal(scan.source,'ocr');
  assert.equal(typeof scan.needsReview,'boolean');
  assert.equal(digital.source,'text');
  assert.match(digital.text,/DIGITAL TERMS/);
  const model = scan.text.match(/MODEL:\s*([A-Z0-9-]+)\b/)?.[1];
  const quantity = Number(scan.text.match(/QUANTITY:\s*(\d+)\b/)?.[1]);
  const unitPrice = Number(scan.text.match(/UNIT PRICE:\s*(\d+\.\d\d) CNY/)?.[1]);
  assert.deepEqual({model,quantity,unitPrice},{model:'BX-150-80',quantity:2,unitPrice:12500});
  const workbook = {sheets:[{name:'泵报价 Pump Quote',header:true,rows:[
    ['型号 / Model','数量 / Quantity','单价 / Unit price','金额 / Amount','复核 / Review'],
    [model,quantity,{value:unitPrice,numberFormat:'#,##0.00'},{formula:'=B2*C2',numberFormat:'#,##0.00'},'核对原稿第 1 页'],
    ['合计 / Total',null,null,{formula:'=SUM(D2:D2)',numberFormat:'#,##0.00'}],
  ]}]};
  codex.request(3,'buildx_create_workbook',{file_name:'扫描水泵报价',workbook});
  const preview = await waitFor(() => app.snapshot('browser').dynamicApproval,'workbook approval');
  assert.equal(preview.kind,'file');
  assert.equal(preview.target,'扫描水泵报价.xlsx');
  assert.equal(JSON.parse(preview.parameters).workbook.sheets[0].rows[1][0],model);
  assert.match(preview.parameters,/=B2\*C2/);
  assert.equal(writes,0);
  const approve = {conversationId:preview.conversationId,requestId:preview.id,digest:preview.digest,decision:'accept'};
  assert.equal((await request('dynamic-approval',approve,{requestOrigin:null})).status,403);
  assert.equal((await request('dynamic-approval',{...approve,digest:'0'.repeat(64)})).status,409);
  assert.equal(writes,0);
  assert.equal((await request('dynamic-approval',approve)).status,200);
  assert.equal((await request('dynamic-approval',approve)).status,409);

  const result = await codex.answer(3);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(writes,1);
  assert.equal(result.value.status,'completed');
  const artifact = await waitFor(() => app.snapshot('browser').generatedFiles.find(file => file.artifactId === result.value.artifactId),'published workbook');
  assert.equal(artifact.fileName,preview.target);
  assert.equal(artifact.local,true);
  const artifactKey = {conversationId:preview.conversationId,artifactId:artifact.artifactId};
  assert.equal((await request('chat-artifact/local',artifactKey,{csrf:'forged'})).status,403);
  assert.equal((await request('chat-artifact/local',artifactKey,{requestOrigin:null})).status,403);
  assert.equal((await request('chat-artifact/local',{...artifactKey,client:'foreign'})).status,409);
  assert.equal((await request('chat-artifact/local',{...artifactKey,path:sourcePath})).status,400);
  const receipt = await request('chat-artifact/local-check',artifactKey);
  assert.equal(receipt.status,200);
  assert.equal(receipt.body.status,'completed');
  const download = await request('chat-artifact/local',artifactKey);
  assert.equal(download.status,200);
  assert.equal(download.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(download.headers.get('cache-control'),'no-store');
  assert.match(decodeURIComponent(download.headers.get('content-disposition')),/扫描水泵报价\.xlsx$/);
  assert.equal(sha(download.bytes),result.value.sha256);
  assert.equal(download.bytes.length,result.value.bytes);
  assert.equal(download.bytes.subarray(0,4).toString('hex'),'504b0304');
  assert.deepEqual(await fs.readFile(sourcePath),pdf);

  if (output !== undefined) {
    assert.ok(path.isAbsolute(output) && path.extname(output).toLowerCase() === '.xlsx');
    await fs.writeFile(output,download.bytes,{flag:'wx'});
  }
  finish();
});

function fixturePng(width, height) {
  const chunk = (name, data) => {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length,0);
    output.write(name,4,'ascii');
    data.copy(output,8);
    output.writeUInt32BE(crc32(output.subarray(4,-4)),output.length-4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width,0);
  header.writeUInt32BE(height,4);
  header[8]=8;
  header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}

test('search preserves the approved public query and image generation exports only the selected reference', async t => {
  const imageCalls = [];
  const png = fixturePng(3,2), selectedPng = fixturePng(2,1), otherPng = fixturePng(4,1);
  const responseBody = {data:[{b64_json:png.toString('base64')}]};
  const generate = createLocalImageGeneration({fetcher:async (url,{body,method,redirect}) => {
    imageCalls.push({url,body,method,redirect});
    return Response.json(responseBody);
  }});
  const {app,codex,dataRoot,request,finish} = await fixture(t,async root => {
    const entry = path.join(root,'search-fixture.mjs');
    await fs.copyFile(new URL('../test-support/local-web-provider-fixture.mjs',import.meta.url),entry);
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'@brave/brave-search-mcp-server',version:'2.1.4'}));
    const search = createLocalWebSearch({locate:async () => entry});
    return {validateQuery:validateLocalWebQuery,
      searchWeb:args => search({...args,apiKey:'synthetic-chat-search-key'}),
      generateImage:args => generate({...args,apiKey:'synthetic-chat-images-key'})};
  });
  const turn = app.snapshot('browser').session.conversation.id;
  const attached = (name,bytes) => ({name,mediaType:'image/png',data:bytes.toString('base64')});
  const posted = await request('turn',{conversationId:turn,message:'查公开水泵资料并生成配图',attachments:[
    attached('选中参考.png',selectedPng),attached('另一张.png',otherPng),
  ]});
  assert.equal(posted.status,202,JSON.stringify(posted.body));
  const [reference] = app.snapshot('browser').session.messages.find(message => message.role==='user').attachments;
  assert.equal(reference.sha256,sha(selectedPng));

  async function approve(preview) {
    const body = {conversationId:preview.conversationId,requestId:preview.id,digest:preview.digest,decision:'accept'};
    assert.equal((await request('dynamic-approval',body)).status,200);
    assert.equal((await request('dynamic-approval',body)).status,409);
  }

  const query = 'site:example.com  公开水泵 DN100';
  const observed = path.join(dataRoot,'observed.json');
  codex.request(1,'buildx_search_public_web',{query});
  const searchApproval = await waitFor(() => app.snapshot('browser').dynamicApproval,'search approval');
  assert.equal(searchApproval.kind,'browser');
  assert.equal(JSON.parse(searchApproval.parameters).query,query);
  await assert.rejects(fs.access(observed),{code:'ENOENT'});
  await approve(searchApproval);
  const search = await codex.answer(1);
  assert.equal(search.ok,true,JSON.stringify(search));
  assert.equal(search.value.query,query);
  assert.equal(search.value.sources[0].url,'https://example.com/docs/pump');
  const observation = JSON.parse(await fs.readFile(observed,'utf8'));
  assert.equal(observation.calls.length,1);
  assert.equal(observation.calls[0].arguments.query,query);

  async function imageRound(id, name, prompt, referenceId) {
    const before = imageCalls.length;
    codex.request(id,'buildx_generate_image',{file_name:name,prompt,...referenceId?{reference_id:referenceId}:{}});
    const preview = await waitFor(() => app.snapshot('browser').dynamicApproval,`image approval ${id}`);
    assert.equal(preview.kind,'file');
    const parameters = JSON.parse(preview.parameters);
    assert.equal(parameters.prompt,prompt);
    assert.equal(imageCalls.length,before);
    assert.deepEqual(parameters.reference,referenceId ? {name:'选中参考.png',sha256:sha(selectedPng)} : undefined);
    await approve(preview);
    const result = await codex.answer(id);
    assert.equal(result.ok,true,JSON.stringify(result));
    const artifact = await waitFor(() => app.snapshot('browser').generatedFiles.find(file => file.artifactId === result.value.artifactId),`published image ${id}`);
    const download = await request('chat-artifact/local',{conversationId:turn,artifactId:artifact.artifactId});
    assert.equal(download.status,200);
    assert.equal(download.headers.get('content-type'),'image/png');
    assert.deepEqual(download.bytes,png);
    assert.equal(result.value.sha256,sha(png));
    assert.equal(imageCalls.length,before+1);
  }

  const prompt = '生成水泵目录封面。';
  await imageRound(2,'纯文本水泵图',prompt);
  assert.equal(imageCalls[0].url,'https://api.openai.com/v1/images/generations');
  assert.equal(JSON.parse(imageCalls[0].body).prompt,prompt);
  assert.equal(JSON.parse(imageCalls[0].body).image,undefined);

  const edit = '按参考图改善背景。';
  await imageRound(3,'参考水泵图',edit,reference.id);
  assert.equal(imageCalls[1].url,'https://api.openai.com/v1/images/edits');
  const images = imageCalls[1].body.getAll('image[]');
  assert.equal(imageCalls[1].body.get('prompt'),edit);
  assert.equal(images.length,1);
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()),selectedPng);
  assert.ok(imageCalls.every(call => call.method==='POST' && call.redirect==='error'));
  finish();
});
