import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectExistingPanelDirectory} from './panel-audit.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=stat=>{if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.ino===0n)throw new Error('Receipt file identity is unverified');return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;};
const sameChain=(left,right)=>left.length===right.length&&left.every((part,i)=>part.path===right[i].path&&part.identity===right[i].identity);

// Captured only while this request's private .tmp is complete, before rename.
// Neither paths nor request IDs supplied by HTTP can construct this capability.
export function captureReadonlyReceiptOwner({queue,preparedPath,request,payload,host,interpret,requireConfirmation=false}){
  try{
    if(typeof interpret!=='function'||host?.sessionId!==request.targetSession||!Number.isSafeInteger(host.pid)||host.pid<1||path.dirname(preparedPath)!==path.join(queue,'inbox')||path.basename(preparedPath)!==request.id+'.tmp')return null;
    const directories=['', 'inbox','processing','outbox'].map(name=>inspectExistingPanelDirectory(path.join(queue,name)));
    if(directories.some(value=>!value.ok))return null;
    const expectedFile=identity(fs.lstatSync(preparedPath,{bigint:true})),expectedHash=digest(Buffer.from(payload)),session=request.targetSession,id=request.id,expectedHost={pid:host.pid,...typeof host.version==='string'?{version:host.version}:{},...typeof host.startedUtc==='string'?{startedUtc:host.startedUtc}:{}},retained=new Set();
    let closed=false;
    function recovery(value){
      if(!requireConfirmation)return {};
      const handle=request.args?.job_handle??value?.evidence?.jobHandle;
      if(typeof handle!=='string'||!handle.trim()||handle.length>180||/[\r\n\0]/.test(handle)||request.args?.job_handle&&value?.evidence?.jobHandle&&request.args.job_handle!==value.evidence.jobHandle)return {};
      return {recovery:{jobHandle:handle,hostIdentity:{sessionId:session,pid:host.pid,version:host.version,startedUtc:host.startedUtc}}};
    }
    function verifyDirectories(){for(const original of directories){const current=inspectExistingPanelDirectory(original.value.path);if(!current.ok||!sameChain(current.value.chain,original.value.chain))throw new Error('Receipt directory identity changed');}}
    function cleanup(){for(const fd of [...retained]){fs.closeSync(fd);retained.delete(fd);}}
    function read(filename,budget,expectedIdentity=null){
      verifyDirectories();const named=fs.lstatSync(filename,{bigint:true}),namedIdentity=identity(named);if(expectedIdentity!==null&&namedIdentity!==expectedIdentity)throw new Error('Original request file identity changed');if(named.size>BigInt(budget))throw new Error('Receipt read budget exceeded');
      const fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));retained.add(fd);
      try{
        const opened=fs.fstatSync(fd,{bigint:true});if(identity(opened)!==namedIdentity||opened.size!==named.size)throw new Error('Receipt file changed before reading');
        const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;
        while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(count===0)break;length+=count;}
        const after=fs.fstatSync(fd,{bigint:true});verifyDirectories();if(length!==Number(opened.size)||identity(after)!==namedIdentity||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||identity(fs.lstatSync(filename,{bigint:true}))!==namedIdentity)throw new Error('Receipt file changed while reading');
        return bytes.subarray(0,length);
      }finally{fs.closeSync(fd);retained.delete(fd);}
    }
    function inspect(){
      const checkedAt=new Date().toISOString();
      if(closed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};
      try{
        cleanup();verifyDirectories();
        const host=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(path.join(queue,'host.json'),16*1024)));
        if(host.sessionId!==session||Object.entries(expectedHost).some(([key,value])=>host[key]!==value))return {ok:true,value:{status:'host_changed',terminal:false,checkedAt,requestId:id,message:'Revit 宿主已变化，原回执未应用。',canCheckAgain:requireConfirmation}};
        let owned=false;
        for(const folder of ['processing','inbox']){
          try{const bytes=read(path.join(queue,folder,id+'.json'),128*1024,expectedFile);if(digest(bytes)!==expectedHash)throw new Error('Original request bytes changed');if(owned)throw new Error('Original request exists in two locations');owned=true;}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
        if(!owned)return {ok:true,value:{status:'unconfirmed',terminal:false,checkedAt,requestId:id,message:'原请求发布状态尚未核实。',canCheckAgain:true}};
        let bytes;
        try{bytes=read(path.join(queue,'outbox',id+'.json'),3*1024*1024);}
        catch(error){if(error.code==='ENOENT')return {ok:true,value:{status:'pending',terminal:false,checkedAt,requestId:id,message:'尚未收到执行回执。',canCheckAgain:true,...recovery()}};throw error;}
        const value=interpret(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        return {ok:true,value:{...value,checkedAt,requestId:id,canCheckAgain:requireConfirmation?value.terminal!==true:false,...recovery(value)}};
      }catch(error){return {ok:false,error:{code:retained.size?'RECEIPT_CLEANUP_PENDING':'RECEIPT_UNCONFIRMED',message:retained.size?'回执读取清理尚未确认，请再次核对。':'回执或原请求无法核实，结果仍待确认。'}};}
    }
    function close(){try{cleanup();closed=true;return {ok:true,value:{closed:true}};}catch{return {ok:false,error:{code:'RECEIPT_CLEANUP_PENDING',message:'原回执句柄关闭尚未确认。'}};}}
    return Object.freeze({inspect,close});
  }catch{return null;}
}
