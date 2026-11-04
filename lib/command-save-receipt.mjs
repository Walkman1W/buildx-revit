// The trusted command-store composition supplies both the exact normalized
// identity and the readers. An HTTP/AI client cannot construct this owner or
// choose its backing path. The owner itself never removes or modifies files.
const COMMAND_ID=/^[a-z][a-z0-9-]{0,63}$/;
const REVISION=/^[a-f0-9]{64}$/;
const REQUEST_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const proofKeys=Object.freeze(['status','source_request_id','mode','expected_document','request_created_utc','completed_utc','request_sha256','outcome_sha256','outcome']);

/** A known version can predate this request, so no outcome claims who created
 * it. `readExact` must be the command-store integrity-checking reader bound to
 * this owner; `verifySource` must independently re-read the original request
 * and result and return the store's source-evidence facts, not a user claim. */
export function createCommandSaveReceiptOwner({commandId,revision,sourceRequestId=null,readExact,verifySource=null,publicationState}={}){
  if(typeof commandId!=='string'||!COMMAND_ID.test(commandId)||typeof revision!=='string'||!REVISION.test(revision)||sourceRequestId!==null&&(typeof sourceRequestId!=='string'||!REQUEST_ID.test(sourceRequestId))||typeof readExact!=='function'||verifySource!==null&&typeof verifySource!=='function'||typeof publicationState!=='function')throw new TypeError('Invalid command save receipt owner');
  let closed=false;
  const unknown=message=>({ok:true,value:{status:'unconfirmed',terminal:false,canCheckAgain:true,checkedAt:new Date().toISOString(),evidence:{commandId,revision},message}});
  const settled=async()=>{try{const state=await publicationState();return plain(state)&&state.settled===true&&state.cleanupConfirmed===true;}catch{return false;}};
  async function inspect(){
    if(closed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};
    if(!await settled())return unknown('保存操作或其清理尚未确认结束。');
    let record;try{record=await readExact(commandId,revision);}catch{return closed?{ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}}:unknown('准确版本尚无法核实；不能推断保存未发生。');}
    if(closed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};
    if(!plain(record)||record.command_id!==commandId||record.revision!==revision)return unknown('读取结果与批准的命令版本不一致。');
    let sourceStatus='not_requested';
    if(sourceRequestId!==null){
      if(typeof verifySource!=='function'||!plain(record.verification)||!Array.isArray(record.verification.evidence))return unknown('原执行证据尚无法独立核实。');
      const entries=record.verification.evidence.filter(item=>plain(item)&&item.source_request_id===sourceRequestId);
      if(entries.length!==1)return unknown('指定执行证据尚无法核实。');
      let proof;try{proof=await verifySource(sourceRequestId,record);}catch{return unknown('原执行证据尚无法独立核实。');}
      if(closed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};
      if(!plain(proof)||proof.source_request_id!==sourceRequestId||Object.keys(proof).length!==proofKeys.length||proofKeys.some(key=>!Object.hasOwn(proof,key)||proof[key]!==entries[0][key]))return unknown('原执行证据与该版本记录不一致。');
      sourceStatus='verified';
    }
    if(!await settled())return unknown('保存操作或其清理尚未确认结束。');
    if(closed)return {ok:false,error:{code:'RECEIPT_OWNER_CLOSED',message:'原回执核对入口已结束。'}};
    return {ok:true,value:{status:'version_present',terminal:true,canCheckAgain:false,checkedAt:new Date().toISOString(),
      evidence:{commandId,revision,createdByThisRequest:'unknown',sourceEvidence:sourceStatus,...sourceRequestId?{sourceRequestId}:{}},
      message:'准确命令版本存在；无法判断是否由本次请求新建。'}};
  }
  async function close(){
    if(closed)return {ok:true,value:{closed:true}};
    if(!await settled())return {ok:false,error:{code:'RECEIPT_CLEANUP_PENDING',message:'保存操作或其清理尚未确认结束。'}};
    closed=true;return {ok:true,value:{closed:true}};
  }
  return Object.freeze({inspect,close});
}
