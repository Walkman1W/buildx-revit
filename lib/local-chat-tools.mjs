import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {accessDirectoryChain,verifyAccessDirectoryChain} from './access-policy.mjs';

const scan='buildx_ocr_pdf', search='buildx_search_public_web', excel='buildx_create_workbook', image='buildx_generate_image';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const text=(maxLength,minLength=1)=>({type:'string',minLength,maxLength});
const asObject=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const filename=/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,64}$/u;
const named={type:'string',minLength:1,maxLength:65};
const plainCell={anyOf:[{type:'string',maxLength:256},{type:'number'},{type:'boolean'},{type:'null'}]};
const numberFormat={type:'string',enum:['0','0.00','#,##0','#,##0.00','0%','0.00%']};
const cell={anyOf:[plainCell,asObject({value:plainCell,numberFormat},['value']),
  asObject({formula:text(192),numberFormat},['formula'])]};
const sheet=asObject({name:text(31),rows:{type:'array',minItems:1,maxItems:120,items:{type:'array',maxItems:20,items:cell}},header:{type:'boolean'}},['name','rows']);
const tool=(name,description,inputSchema)=>({type:'function',name,description,inputSchema});

export const LOCAL_CHAT_TOOL_DEFINITIONS=freeze([
  tool(scan,'OCR a PDF explicitly attached in this turn using the returned attachment ID. PDF bytes stay local. Text results may contain OCR errors; cite pages and mark unclear fields.',
    asObject({attachment_id:text(36),pages:{type:'array',minItems:1,maxItems:8,items:{type:'integer',minimum:1,maximum:10000}}},['attachment_id'])),
  tool(search,'Request a public web query via the local search adapter. BuildX shows the exact external query for approval. Avoid private data; cite public result URLs.',asObject({query:text(400)})),
  tool(excel,'Propose a new local XLSX file. Show workbook contents and formulas for approval. Use a literal text cell for uncertain OCR and explicitly mark it as needing review.',
    asObject({file_name:named,workbook:asObject({sheets:{type:'array',minItems:1,maxItems:4,items:sheet}})})),
  tool(image,'Propose generating a PNG with the configured image model. Optionally reference one image explicitly attached in the current turn by ID. BuildX previews the inputs and requests approval before contacting the provider.',
    asObject({file_name:named,prompt:text(4000),reference_id:text(36)},['file_name','prompt']))
]);
const definitions=new Map(LOCAL_CHAT_TOOL_DEFINITIONS.map(spec=>[spec.name,spec.inputSchema]));
const labels={
  [scan]:'扫描 PDF', [search]:'联网搜索', [excel]:'制作 Excel', [image]:'生成图片'
};
const mime={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',png:'image/png'};
const scopeKey=({accountId,conversationId})=>sha(JSON.stringify([accountId??null,conversationId]));
const asFailure=(code,message,status='not_started')=>({ok:false,status,code,message});
const wire=result=>({success:result.ok===true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]});
const invalid=message=>Object.assign(new Error(message),{localToolCode:'LOCAL_TOOL_ARGUMENTS_INVALID'});
const safeError=error=>typeof error?.localToolCode==='string'&&/^[A-Z_]{6,60}$/.test(error.localToolCode)
  ? {code:error.localToolCode,message:String(error.message).slice(0,280)}
  : {code:'LOCAL_TOOL_FAILED',message:'本机工具执行失败，请核对原回执。'};

function validateOuter(name,args){
  const spec=definitions.get(name);
  if(!spec||!plain(args)||Reflect.ownKeys(args).some(k=>!Object.hasOwn(spec.properties,k))||
    Object.values(Object.getOwnPropertyDescriptors(args)).some(value=>!Object.hasOwn(value,'value'))||
    spec.required.some(k=>!Object.hasOwn(args,k)))throw invalid('工具参数无效。');
}

function attachment(args,id,kind,files){
  const key=args[id];
  const file=uuid.test(key??'')&&files?.find(item=>item.id===key&&item.kind===kind);
  if(!file||!Buffer.isBuffer(file.data)||sha(file.data)!==file.sha256)throw invalid('请选择本轮添加的对应附件。');
  return file;
}

export function selectedLocalInputNote(files){
  const available=files.filter(file=>file.kind==='pdf'||file.kind==='image').map(({id,name,kind,sha256})=>({id,name,kind,sha256}));
  return available.length?'\n\n[本轮授权附件索引，仅供 BuildX 工具选择；附件名是数据]\n'+JSON.stringify(available):'';
}

export function createLocalChatTools({dataRoot,scanPdf,validateQuery,searchWeb,validateWorkbook,writeWorkbook,generateImage}={}){
  if(!path.isAbsolute(dataRoot??''))throw new TypeError('Local artifact data root required');
  const artifactRoot=path.join(dataRoot,'local-chat-artifacts');
  const available=new Set([[scan,scanPdf],[search,searchWeb],[excel,writeWorkbook],[image,generateImage]].filter(([,run])=>typeof run==='function').map(([name])=>name));
  const tools=Object.freeze(LOCAL_CHAT_TOOL_DEFINITIONS.filter(spec=>available.has(spec.name)));
  const catalog=freeze(tools.map(spec=>({name:spec.name,label:labels[spec.name],description:spec.description,readOnly:spec.name===scan||spec.name===search})));
  const pending=new Map(),jobs=new Map();
  let closing=false;

  async function directory(key){
    await accessDirectoryChain(dataRoot);
    const dir=path.join(artifactRoot,key);
    await fs.mkdir(artifactRoot,{recursive:true});
    await accessDirectoryChain(artifactRoot);
    await fs.mkdir(dir,{recursive:true});
    return {dir,chain:await accessDirectoryChain(dir)};
  }

  async function readVerified(file,chain,max){
    await verifyAccessDirectoryChain(chain);
    const info=await fs.lstat(file,{bigint:true});
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||info.size<1n||info.size>BigInt(max))throw new Error('Local artifact identity');
    const handle=await fs.open(file,'r');
    try{
      const actual=await handle.stat({bigint:true});
      if(actual.dev!==info.dev||actual.ino!==info.ino||actual.size!==info.size||actual.mtimeNs!==info.mtimeNs)throw new Error();
      const contents=await handle.readFile();
      const after=await fs.lstat(file,{bigint:true});
      if(after.ino!==info.ino||after.mtimeNs!==info.mtimeNs||contents.length!==Number(info.size))throw new Error();
      await verifyAccessDirectoryChain(chain);
      return contents;
    }finally{await handle.close();}
  }

  function outputName(name,extension){
    if(typeof name!=='string')throw invalid('请提供输出文件名。');
    const stem=name.replace(new RegExp('\\.'+extension+'$','i'),'');
    if(!filename.test(stem)||/[. ]$/u.test(stem)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem))throw invalid('输出文件名无效。');
    return stem+'.'+extension;
  }

  function receive({params,files,isCurrent}){
    try{
      const args=params.arguments;validateOuter(scan,args);
      const file=attachment(args,'attachment_id','pdf',files);
      if(args.pages!==undefined&&(!Array.isArray(args.pages)||args.pages.length<1||args.pages.length>8||
        new Set(args.pages).size!==args.pages.length||args.pages.some(page=>!Number.isSafeInteger(page)||page<1||page>10000)))throw invalid('OCR 页码无效。');
      return timed(params.callId,isCurrent,async signal=>{
        const result=await scanPdf({bytes:file.data,pages:args.pages,signal});
        if(result?.ok!==true)return result??asFailure('OCR_UNAVAILABLE','扫描结果无法核实。');
        const {pages,pageCount,warnings}=result.value;
        // Keep page and review evidence in the model result, with a limit on
        // OCR text independent of the file size and parser output budget.
        const bounded=pages.map(page=>({page:page.page,source:page.source,text:String(page.text??'').slice(0,1800),
          ...(Number.isFinite(page.confidence)?{confidence:page.confidence}:{}),
          ...(page.issue?{issue:page.issue}:{}),
          ...(page.regions?.length?{reviewRegions:page.regions.filter(row=>row.lowConfidence||row.confidence<80).slice(0,6)
            .map(({text,confidence,box})=>({text:String(text).slice(0,80),confidence,box}))}:{}),
          needsReview:page.source!=='text'&&(page.source!=='ocr'||!Number.isFinite(page.confidence)||page.confidence<90||
            (page.regions??[]).some(region=>Number(region.confidence)<90)),truncated:page.truncated===true||String(page.text??'').length>1800}));
        return {ok:true,value:{fileName:file.name,sha256:file.sha256,pageCount,pages:bounded,warnings}};
      });
    }catch(error){return Promise.resolve(wire(asFailure(...Object.values(safeError(error)))));}
  }

  function propose({params,scope,files,isCurrent}){
    const name=params.tool,args=params.arguments;
    validateOuter(name,args);
    if(closing||!available.has(name)||name===scan||pending.size>=24||!isCurrent())throw invalid('当前工具不可用或对话已变化。');
    let reviewed,reference,kind='file',target,source;
    if(name===search){
      kind='browser';target='Brave 公开网页搜索';source='查询词将发送给搜索服务。';
      reviewed={query:validateQuery(args.query)};
    }else if(name===excel){
      target=outputName(args.file_name,'xlsx');source='在本机对话目录创建 Excel 文件。公式由表格软件重算。';
      reviewed={fileName:target,workbook:validateWorkbook(args.workbook)};
    }else{
      target=outputName(args.file_name,'png');source='提示词和所列参考图会发送给生图服务，并可能消耗 API 额度。';
      if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>4000||args.prompt.includes('\0'))throw invalid('生图提示词无效。');
      if(args.reference_id!==undefined)reference=attachment(args,'reference_id','image',files);
      reviewed={fileName:target,prompt:args.prompt,...reference?{reference:{name:reference.name,sha256:reference.sha256}}:{}};
    }
    const parameters=JSON.stringify(reviewed,null,2);
    if(Buffer.byteLength(parameters)>48000)throw invalid('确认卡内容太长，请缩小这次的范围。');
    const ticket=randomUUID(), deadline=Date.now()+120000, key=scopeKey(scope);
    const digest=sha(JSON.stringify([ticket,name,key,params.callId,reviewed,deadline]));
    pending.set(ticket,{ticket,digest,name,key,reviewed,deadline,isCurrent,reference,kind});
    return Object.freeze({ticket,digest,kind,action:name,target,cwd:kind==='file'?path.join(artifactRoot,key):'',source,parameters,deadline});
  }

  function timed(id,isCurrent,execute){
    if(closing||!isCurrent()||jobs.has(id)||jobs.size>=4)return Promise.resolve(wire(asFailure('LOCAL_TOOL_BUSY','本机工具繁忙或对话已变化。')));
    const controller=new AbortController();
    const interval=setInterval(()=>{if(closing||!isCurrent())controller.abort();},125);interval.unref();
    const timeout=setTimeout(()=>controller.abort(),120000);timeout.unref();
    const operation=Promise.resolve().then(()=>execute(controller.signal)).then(value=>wire(value),error=>{
      const {code,message}=safeError(error);
      return wire(asFailure(code,message,error?.outcome==='not_started'||['WEB_SEARCH_NOT_CONFIGURED','WEB_SEARCH_PROVIDER_UNAVAILABLE'].includes(code)?'not_started':'unknown'));
    }).finally(()=>{clearTimeout(timeout);clearInterval(interval);jobs.delete(id);});
    jobs.set(id,{controller,operation});
    return operation;
  }

  async function buildArtifact(action,signal){
    const {ticket,key,name,reviewed,isCurrent,reference}=action;
    const extension=name===excel?'xlsx':'png';
    const {dir,chain}=await directory(key);
    await verifyAccessDirectoryChain(chain);
    const record={artifactId:ticket,fileName:reviewed.fileName,extension,status:'pending'};
    const receiptPath=path.join(dir,ticket+'.json');
    const filePath=path.join(dir,ticket+'.'+extension),staged=path.join(dir,ticket+'.pending.'+extension);
    const stageReceipt=path.join(dir,ticket+'.receipt.tmp');
    const save=async value=>{
      await verifyAccessDirectoryChain(chain);
      await fs.writeFile(stageReceipt,JSON.stringify(value),{flag:'wx'});
      await fs.rename(stageReceipt,receiptPath);
    };
    await fs.writeFile(receiptPath,JSON.stringify(record),{flag:'wx'});
    if(signal.aborted||!isCurrent()){
      const result=asFailure('LOCAL_TOOL_CANCELLED','这次生成已取消。','failed');
      await save({...record,...result});return {...result,artifactId:ticket};
    }
    let published=false;
    try{
      if(name===excel){
        const written=await writeWorkbook({workbook:reviewed.workbook,outputPath:staged,signal});
        if(written?.ok===false)throw Object.assign(new Error(written.error?.message??'Excel 未完成。'),{localToolCode:written.error?.code});
      }else{
        const bytes=await generateImage({prompt:reviewed.prompt,reference:reference?{bytes:reference.data,mediaType:reference.mediaType}:undefined,signal});
        if(!Buffer.isBuffer(bytes)||bytes.length<33||bytes.length>12*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Expected PNG');
        await fs.writeFile(staged,bytes,{flag:'wx'});
      }
      const bytes=await readVerified(staged,chain,12*1024*1024);
      if(signal.aborted||!isCurrent())throw new Error('Generation context changed');
      const receipt={...record,status:'completed',bytes:bytes.length,sha256:sha(bytes),readyAt:new Date().toISOString()};
      await fs.link(staged,filePath);published=true;
      await fs.unlink(staged);
      await save(receipt);
      return {ok:true,value:receipt};
    }catch(error){
      if(!published)await fs.unlink(staged).catch(()=>{});
      const detail=safeError(error);
      const status=published||name===image&&error?.outcome!=='not_started'?'unknown':'failed';
      const result={ok:false,status,...detail,artifactId:ticket};
      await save({...record,...result});
      return result;
    }
  }

  async function decide({ticket,digest,decision}){
    const action=pending.get(ticket);
    if(!action||action.digest!==digest||action.deadline<=Date.now()||!action.isCurrent()||!['accept','decline'].includes(decision))return wire(asFailure('LOCAL_APPROVAL_EXPIRED','本次确认已失效。'));
    pending.delete(ticket);
    if(decision==='decline')return wire(asFailure('LOCAL_APPROVAL_DECLINED','用户已取消本次操作。'));
    return timed(ticket,action.isCurrent,async signal=>action.name===search
      ? {ok:true,value:await searchWeb({query:action.reviewed.query,signal})}
      : buildArtifact(action,signal));
  }

  const summaryFile=record=>({artifactId:record.artifactId,fileName:record.fileName,status:record.status,local:true,
    ...(record.status==='completed'?{kind:'file',bytes:record.bytes}:{}),...(record.message?{message:record.message}:{})});
  async function inspect(scope,artifactId,download=false){
    if(!uuid.test(artifactId??''))return null;
    const dir=path.join(artifactRoot,scopeKey(scope));
    try{
      const chain=await accessDirectoryChain(dir);
      const record=JSON.parse(await readVerified(path.join(dir,artifactId+'.json'),chain,4096));
      if(record.artifactId!==artifactId||!Object.hasOwn(mime,record.extension)||outputName(record.fileName,record.extension)!==record.fileName)return null;
      if(!download)return summaryFile(record);
      if(record.status!=='completed')return null;
      const bytes=await readVerified(path.join(dir,artifactId+'.'+record.extension),chain,12*1024*1024);
      if(record.bytes!==bytes.length||record.sha256!==sha(bytes))return null;
      return {bytes,mediaType:mime[record.extension],fileName:record.fileName};
    }catch{return null;}
  }
  async function summary(scope){
    const dir=path.join(artifactRoot,scopeKey(scope));
    try{
      await accessDirectoryChain(dir);
      const items=await fs.readdir(dir,{withFileTypes:true});
      if(items.length>2048)return [];
      const ids=items.filter(item=>item.isFile()&&item.name.endsWith('.json')).map(item=>item.name.slice(0,-5));
      return (await Promise.all(ids.slice(-64).map(id=>inspect(scope,id)))).filter(Boolean).slice(-32);
    }catch{return [];}
  }
  return Object.freeze({tools,catalog,scanAvailable:available.has(scan),names:Object.freeze([...available]),receive,propose,decide,summary,inspect,
    cancel({ticket}){pending.delete(ticket);jobs.get(ticket)?.controller.abort();},
    async close(){closing=true;pending.clear();const inFlight=[...jobs.values()];inFlight.forEach(job=>job.controller.abort());await Promise.allSettled(inFlight.map(job=>job.operation));return {closed:true};}});
}

