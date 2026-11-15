import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,opendir} from 'node:fs/promises';
import path from 'node:path';

const millimetres=(minimum,maximum)=>Object.freeze({type:'number',minimum,maximum});
const systems=Object.freeze(['hydronic_supply','hydronic_return','domestic_cold_water']);
const pumpProperties=Object.freeze({
  file_name:Object.freeze({type:'string',minLength:1,maxLength:48,description:'Output name without extension; letters, numbers, spaces, underscores and hyphens. Start and end with a letter or number.'}),
  width_mm:millimetres(150,6000), depth_mm:millimetres(150,6000), height_mm:millimetres(150,6000),
  inlet_diameter_mm:millimetres(10,1200), outlet_diameter_mm:millimetres(10,1200),
  system:Object.freeze({type:'string',enum:systems})
});
export const PUMP_FILE_PARAMETER_SCHEMA=Object.freeze({type:'object',properties:pumpProperties,
  required:Object.freeze(Object.keys(pumpProperties)),additionalProperties:false});

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value);
const plain=value=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const namePattern=/^[\p{L}\p{N}](?:[\p{L}\p{N} _-]*[\p{L}\p{N}])?$/u;
const reservedName=/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const maxArtifactBytes=64*1024*1024;
const maxRecordBytes=8192;

export function readPumpFileParameters(value){
  const invalid=()=>new TypeError('泵族参数无效。请核对文件名、设备尺寸、管口口径与系统分类。');
  if(!plain(value)||Reflect.ownKeys(value).length!==PUMP_FILE_PARAMETER_SCHEMA.required.length)throw invalid();
  const entries=[];
  for(const key of PUMP_FILE_PARAMETER_SCHEMA.required){
    const property=Object.getOwnPropertyDescriptor(value,key);
    if(!property||!Object.hasOwn(property,'value'))throw invalid();
    const field=property.value,spec=pumpProperties[key];
    if(spec.type==='number'&&(!Number.isFinite(field)||field<spec.minimum||field>spec.maximum))throw invalid();
    entries.push([key,field]);
  }
  const checked=Object.fromEntries(entries);
  if(typeof checked.file_name!=='string'||checked.file_name.length>48||!namePattern.test(checked.file_name)||reservedName.test(checked.file_name)||!systems.includes(checked.system))throw invalid();
  const maximumDiameter=0.30*Math.min(checked.width_mm,checked.depth_mm,checked.height_mm);
  if(checked.inlet_diameter_mm>maximumDiameter||checked.outlet_diameter_mm>maximumDiameter)throw invalid();
  return Object.freeze(checked);
}

function ownerKey(scope){
  const {conversationId,accountId}=scope??{};
  if(typeof conversationId!=='string'||!conversationId||conversationId.length>256||
    !(accountId===null||typeof accountId==='string'&&accountId.length>0&&accountId.length<=2048))throw new TypeError('Generated file scope is invalid.');
  return digest(JSON.stringify([conversationId,accountId]));
}

const fileNameFor=(parameters,id)=>parameters.file_name+'-'+id.replaceAll('-','')+'.rfa';
const validBytes=value=>Number.isSafeInteger(value)&&value>0&&value<=maxArtifactBytes;
const sameFile=(first,next)=>first.dev===next.dev&&first.ino===next.ino&&first.size===next.size&&first.mtimeNs===next.mtimeNs&&first.ctimeNs===next.ctimeNs;
const unsafeFile=()=>new Error('生成文件的路径或内容无法核实。');
function canContinue(check){
  try{return check===undefined||typeof check==='function'&&check()===true;}
  catch{return false;}
}

async function directoryChain(directory){
  const chain=[];
  for(let cursor=directory;;cursor=path.dirname(cursor)){
    chain.unshift(cursor);
    if(cursor===path.dirname(cursor))break;
  }
  return Promise.all(chain.map(async filename=>{
    const stats=await lstat(filename,{bigint:true});
    if(!stats.isDirectory()||stats.isSymbolicLink())throw unsafeFile();
    return {filename,stats};
  }));
}

async function verifyDirectories(records){
  for(const {filename,stats} of records){
    const current=await lstat(filename,{bigint:true});
    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==stats.dev||current.ino!==stats.ino)throw unsafeFile();
  }
}

async function readCheckedFile(filename,maxBytes,expected){
  const directories=await directoryChain(path.dirname(filename));
  await verifyDirectories(directories);
  const before=await lstat(filename,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(maxBytes)||
    expected&&before.size!==BigInt(expected.bytes))throw unsafeFile();
  const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await file.stat({bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||!sameFile(before,opened))throw unsafeFile();
    const data=Buffer.alloc(Number(opened.size));
    for(let offset=0;offset<data.length;){
      const {bytesRead}=await file.read(data,offset,data.length-offset,offset);
      if(!bytesRead)throw unsafeFile();
      offset+=bytesRead;
    }
    const after=await file.stat({bigint:true}),named=await lstat(filename,{bigint:true});
    if(after.nlink!==1n||named.nlink!==1n||named.isSymbolicLink()||!sameFile(opened,after)||!sameFile(opened,named))throw unsafeFile();
    await verifyDirectories(directories);
    if(expected&&digest(data)!==expected.sha256)throw unsafeFile();
    return data;
  }finally{await file.close();}
}

async function readRecord(filename){
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCheckedFile(filename,maxRecordBytes)));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function writeRecord(filename,value){
  const directories=await directoryChain(path.dirname(filename));
  await verifyDirectories(directories);
  const file=await open(filename,'wx',0o600);
  try{
    // A partial claim remains present and fails closed. No process may publish it twice.
    await file.writeFile(JSON.stringify(value),'utf8');
    await file.sync();
    await verifyDirectories(directories);
    const opened=await file.stat({bigint:true}),named=await lstat(filename,{bigint:true});
    if(!named.isFile()||named.isSymbolicLink()||opened.nlink!==1n||named.nlink!==1n||!sameFile(opened,named))throw unsafeFile();
  }finally{await file.close();}
}

export function createGeneratedFileOwner({dataRoot}={}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot!==path.resolve(dataRoot))throw new TypeError('Absolute BuildX data root required.');
  const outputDirectory=path.join(dataRoot,'workbench','family-artifacts');
  const indexDirectory=path.join(dataRoot,'generated-file-jobs');
  const claimName=id=>path.join(indexDirectory,id+'.request.json');
  const resultName=id=>path.join(indexDirectory,id+'.result.json');
  const unknown=id=>({status:'unknown',artifactId:id,code:'GENERATED_FILE_RESULT_UNCONFIRMED'});
  const failed=(id,code)=>({status:'failed',artifactId:id,code});

  async function ensureIndexDirectory(){
    const directories=await directoryChain(dataRoot);
    try{await mkdir(indexDirectory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    await directoryChain(indexDirectory);
    await verifyDirectories(directories);
  }

  async function getClaim(id,key){
    const claim=await readRecord(claimName(id));
    if(!plain(claim)||claim.version!==1||claim.requestId!==id||claim.ownerKey!==key||!Number.isSafeInteger(claim.createdAt))return null;
    return {...claim,parameters:readPumpFileParameters(claim.parameters)};
  }

  function publicResult(result,claim){
    const {requestId,parameters}=claim;
    if(!plain(result)||result.version!==1||result.requestId!==requestId||result.ownerKey!==claim.ownerKey)return unknown(requestId);
    if(result.status==='failed'&&validCode(result.code))return failed(requestId,result.code);
    const {fileName,bytes,sha256}=result;
    if(result.status!=='completed'||fileName!==fileNameFor(parameters,requestId)||!validBytes(bytes)||!hex(sha256))return unknown(requestId);
    return {status:'completed',artifactId:requestId,artifact:{kind:'file',artifactId:requestId,fileName,bytes,sha256}};
  }

  async function persistResult(claim,result){
    const {requestId,ownerKey}=claim;
    const filename=resultName(requestId);
    const record={version:1,requestId,ownerKey,...result};
    try{await writeRecord(filename,record);return publicResult(record,claim);}
    catch(error){if(error.code!=='EEXIST')throw error;return publicResult(await readRecord(filename),claim);}
  }

  async function settle(claim,receipt){
    const {requestId,parameters}=claim;
    if(receipt?.ok===false&&(receipt.outcome==='not_started'||receipt.outcome==='failed'&&receipt.artifactCreated===false)){
      try{await lstat(path.join(outputDirectory,fileNameFor(parameters,requestId)));return unknown(requestId);}
      catch(error){if(error.code!=='ENOENT')throw error;}
      const fallback=receipt.outcome==='not_started'?'GENERATED_FILE_NOT_STARTED':'GENERATED_FILE_HOST_FAILED';
      return persistResult(claim,{status:'failed',code:validCode(receipt.code)?receipt.code:fallback});
    }
    const value=receipt?.value;
    if(receipt?.ok!==true||value?.reopened!==true||value.file_name!==fileNameFor(parameters,requestId)||!validBytes(value.bytes)||!hex(value.sha256))return unknown(requestId);
    const file={fileName:value.file_name,bytes:value.bytes,sha256:value.sha256};
    await readCheckedFile(path.join(outputDirectory,file.fileName),maxArtifactBytes,file);
    return persistResult(claim,{status:'completed',...file});
  }

  async function reserveSpec(claim){
    const spec=digest(JSON.stringify([claim.ownerKey,claim.parameters]));
    // A terminal slot remains immutable so a contender never deletes a newer lock.
    for(let sequence=0;sequence<4096;sequence++){
      const filename=path.join(indexDirectory,spec+'-'+sequence+'.spec.json');
      let slot=await readRecord(filename);
      if(slot===null){
        try{await writeRecord(filename,{version:1,requestId:claim.requestId});return null;}
        catch(error){if(error.code!=='EEXIST')throw error;slot=await readRecord(filename);}
      }
      if(slot?.version!==1||!uuid(slot.requestId))throw unsafeFile();
      const original=await getClaim(slot.requestId,claim.ownerKey);
      if(!original||JSON.stringify(original.parameters)!==JSON.stringify(claim.parameters))throw unsafeFile();
      const result=publicResult(await readRecord(resultName(slot.requestId)),original);
      if(result.status==='unknown')return slot.requestId;
    }
    throw unsafeFile();
  }

  async function execute({scope,requestId,parameters,invoke,shouldContinue}={}){
    if(!uuid(requestId)||typeof invoke!=='function')throw new TypeError('Generated file job is invalid.');
    const key=ownerKey(scope),checked=readPumpFileParameters(parameters);
    const claim={version:1,requestId,ownerKey:key,parameters:checked,createdAt:Date.now()};
    if(!canContinue(shouldContinue))return failed(requestId,'GENERATED_FILE_NOT_STARTED');
    try{
      await ensureIndexDirectory();
      try{await writeRecord(claimName(requestId),claim);}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const existing=await getClaim(requestId,key);
        if(!existing||JSON.stringify(existing.parameters)!==JSON.stringify(checked))return unknown(requestId);
        const result=publicResult(await readRecord(resultName(requestId)),existing);
        return canContinue(shouldContinue)?result:unknown(requestId);
      }
      if(!canContinue(shouldContinue))return persistResult(claim,{status:'failed',code:'GENERATED_FILE_NOT_STARTED'});
      const originalId=await reserveSpec(claim);
      if(originalId){
        await persistResult(claim,{status:'failed',code:'GENERATED_FILE_DUPLICATE_PENDING'});
        return unknown(originalId);
      }
      if(!canContinue(shouldContinue))return persistResult(claim,{status:'failed',code:'GENERATED_FILE_NOT_STARTED'});
      const receipt=await invoke({requestId,parameters:checked,shouldContinue});
      const result=await settle(claim,receipt);
      return canContinue(shouldContinue)?result:unknown(requestId);
    }catch{return unknown(requestId);}
  }

  async function recover({scope,artifactId,observe,shouldContinue}={}){
    if(!uuid(artifactId)||typeof observe!=='function'||!canContinue(shouldContinue))return null;
    const key=ownerKey(scope);
    try{
      const claim=await getClaim(artifactId,key);
      if(!claim)return null;
      const existing=publicResult(await readRecord(resultName(artifactId)),claim);
      if(!canContinue(shouldContinue))return null;
      if(existing.status!=='unknown')return existing;
      const receipt=await observe({requestId:artifactId,parameters:claim.parameters,shouldContinue});
      const result=await settle(claim,receipt);
      return canContinue(shouldContinue)?result:null;
    }catch{return unknown(artifactId);}
  }

  async function read({scope,artifactId,shouldContinue}={}){
    if(!uuid(artifactId)||!canContinue(shouldContinue))return null;
    const key=ownerKey(scope);
    try{
      const claim=await getClaim(artifactId,key);
      if(!claim)return null;
      const {artifact}=publicResult(await readRecord(resultName(artifactId)),claim);
      if(!artifact||!canContinue(shouldContinue))return null;
      const filename=path.join(outputDirectory,artifact.fileName);
      const data=await readCheckedFile(filename,maxArtifactBytes,artifact);
      return canContinue(shouldContinue)?{...artifact,path:filename,data}:null;
    }catch{return null;}
  }

  async function listRecords({scope,shouldContinue}={}){
    const key=ownerKey(scope),records=[];
    if(!canContinue(shouldContinue))return [];
    try{
      await directoryChain(indexDirectory);
      for await(const entry of await opendir(indexDirectory)){
        if(!canContinue(shouldContinue))return [];
        if(!entry.name.endsWith('.request.json')||!entry.isFile())continue;
        const id=entry.name.slice(0,-'.request.json'.length);
        if(!uuid(id))continue;
        try{
          const claim=await getClaim(id,key);
          if(!claim)continue;
          const result=publicResult(await readRecord(resultName(id)),claim);
          records.push({result,createdAt:claim.createdAt,fileName:fileNameFor(claim.parameters,id)});
        }catch{/* A damaged record cannot grant access to a file. */}
      }
    }catch{return [];}
    return canContinue(shouldContinue)?records.sort((left,right)=>right.createdAt-left.createdAt):[];
  }

  async function list(options){
    return (await listRecords(options)).filter(record=>record.result.status==='completed').map(record=>record.result.artifact);
  }

  async function pending(options){
    return (await listRecords(options)).filter(record=>record.result.status==='unknown').map(record=>({artifactId:record.result.artifactId,fileName:record.fileName}));
  }

  return Object.freeze({outputDirectory,execute,recover,read,list,pending});
}
