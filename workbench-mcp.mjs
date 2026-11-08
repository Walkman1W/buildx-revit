import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {confirmedWriteProfile} from './lib/confirmed-write-profile.mjs';
import readline from 'node:readline';
import {invokeWorkbench,READONLY_WORKBENCH_TOOL_NAMES,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {PANEL_WORKBENCH_TOOLS,LEGACY_PANEL_WORKBENCH_TOOLS} from './lib/panel-tools.mjs';
import {isCommandTool,invokeCommand} from './lib/command-store.mjs';
import {sanitizePanelAudit} from './lib/panel-audit.mjs';
import {isNativeModelQuery} from './lib/native-model-queries.mjs';
import {isNativeParameterQuery} from './lib/native-parameter-queries.mjs';
import {SNAPSHOT_DELTA_NAME} from './lib/native-snapshot-delta.mjs';
import {BATCH_PREVIEW_NAME} from './lib/batch-filter-preview.mjs';

// Keep the producing receipt owner for every named native read that the chat
// inbox accepts, including the explicitly started snapshot baseline.
const recoverableNativeRead=name=>name===SNAPSHOT_DELTA_NAME||name===BATCH_PREVIEW_NAME||isNativeModelQuery(name)||isNativeParameterQuery(name);

const flags=process.argv.slice(2);
if(flags.length!==0&&(flags.length!==1||!['--read-only','--workspace'].includes(flags[0]))){
  process.stderr.write('Usage: node workbench-mcp.mjs [--read-only|--workspace]\n');process.exit(2);
}
const guarded=confirmedWriteProfile(path.dirname(fileURLToPath(import.meta.url)));
const readOnly=flags[0]==='--read-only',workspace=flags[0]==='--workspace'||guarded&&!readOnly,readOnlyNames=new Set(READONLY_WORKBENCH_TOOL_NAMES);
const receiptBridge=workspace?await import('./lib/chat-read-receipts.mjs'):null;
const receiptProducer=receiptBridge?.createChatReadReceiptProducer({
  key:process.env[receiptBridge.CHAT_READ_RECEIPT_KEY_ENV],port:Number(process.env[receiptBridge.CHAT_READ_RECEIPT_PORT_ENV])
});
// Legacy/read-only entries retain their original dependency boundary.
const workspaceDispatch=workspace?(await import('./lib/model-tool-dispatch.mjs')).invokeModelTool:null;
const workspaceTools=workspace?(await import('./lib/panel-tools.mjs')).MODEL_AI_READ_TOOLS:null;
const tools=readOnly?READONLY_WORKBENCH_TOOL_NAMES.map(name=>{
  const matches=PANEL_WORKBENCH_TOOLS.filter(tool=>tool.name===name);
  if(matches.length!==1||matches[0].annotations?.readOnlyHint!==true)throw new Error('Read-only workbench catalog does not match its named contracts');
  return matches[0];
}):workspace?workspaceTools:LEGACY_PANEL_WORKBENCH_TOOLS;
const exposedNames=new Set(tools.map(tool=>tool.name));
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',async line=>{
  let request;
  try{
    if(Buffer.byteLength(line)>140000)throw new Error('Request too large');
    request=JSON.parse(line);
    if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'revit-workbench',version:'0.6.0'}};
    else if(request.method==='ping')result={};
    else if(request.method==='tools/list')result={tools};
    else if(request.method==='tools/call'){
      const events=[];let receiptProof=null,retainReceiptOwner=false;
      try{
        const name=request.params.name,args=request.params.arguments||{};
        if(!exposedNames.has(name)||readOnly&&!readOnlyNames.has(name))throw new Error('此会话不提供该工具。');
        const onTiming=value=>{const data=sanitizePanelAudit('phase-timing.jsonl',value);if(data&&events.length<8)events.push(data);};
        retainReceiptOwner=Boolean(receiptProducer&&recoverableNativeRead(name));
        const value=workspace?await workspaceDispatch(name,args,{onTiming,...retainReceiptOwner?{retainReceiptOwner:true}:{}}):isCommandTool(name)?await invokeCommand(name,args,{execute:invokeWorkbench}):await invokeWorkbench(name,args,readOnly?{onTiming}:{});
        if(retainReceiptOwner)await value?.receiptOwner?.close();
        result={content:[{type:'text',text:JSON.stringify(value)}],...(recoverableNativeRead(name)?{structuredContent:value}:{}),isError:false};
      }
      catch(error){
        // MCP's isError describes a failed tool call, not necessarily a failed
        // Revit operation. Only the transport's typed algebra can establish a
        // definite outcome; all other exceptions remain unconfirmed.
        const {outcome,requestIds,receiptOwner}=workbenchFailureEvidence(error);
        if(retainReceiptOwner&&outcome==='unconfirmed'&&requestIds.length===1)
          receiptProof=receiptProducer.retain(request.params.name,requestIds[0],receiptOwner);
        if(!receiptProof)await receiptOwner?.close();
        const message=receiptProof?'Revit 查询的原回执尚未确认，请勿自动重试。':error.message;
        result={content:[{type:'text',text:error.producerResult?JSON.stringify({error:{message,outcome:error.modelOutcome},result:error.producerResult}):message}],isError:true,
          structuredContent:{buildxToolOutcome:{schemaVersion:1,outcome:['not_started','expired','failed'].includes(outcome)?outcome:'unconfirmed'}}};
      }
      if(events.length||receiptProof)result._meta={...events.length?{'buildx/phaseTiming':{schemaVersion:1,events}}:{},
        ...receiptProof?{[receiptBridge.CHAT_READ_RECEIPT_META]:receiptProof}:{}};
    }else{send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}});return;}
    send({jsonrpc:'2.0',id:request.id,result});
  }catch(error){send({jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:error.message}});}
});
