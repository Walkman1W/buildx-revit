import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {invokeWorkbench,READONLY_WORKBENCH_TOOL_NAMES,workbenchFailureEvidence} from './lib/workbench-client.mjs';
import {PANEL_WORKBENCH_TOOLS,LEGACY_PANEL_WORKBENCH_TOOLS} from './lib/panel-tools.mjs';
import {isCommandTool,invokeCommand} from './lib/command-store.mjs';
import {sanitizePanelAudit} from './lib/panel-audit.mjs';
import {isNativeModelQuery} from './lib/native-model-queries.mjs';
import {isNativeParameterQuery} from './lib/native-parameter-queries.mjs';
import {isNativeReadonlyTest} from './lib/native-readonly-test-scope.mjs';

const flags=process.argv.slice(2);
if(flags.length!==0&&(flags.length!==1||!['--read-only','--workspace','--managed-readonly'].includes(flags[0]))){
  process.stderr.write('Usage: node workbench-mcp.mjs [--read-only|--workspace|--managed-readonly]\n');process.exit(2);
}
const readOnly=flags[0]==='--read-only',workspace=flags[0]==='--workspace',managed=flags[0]==='--managed-readonly';
// The managed candidate is opt-in and has its own two-tool catalog. The
// product workspace launch keeps its existing full catalog and receipts.
const readOnlyNames=new Set(READONLY_WORKBENCH_TOOL_NAMES);
if (await isNativeReadonlyTest(fileURLToPath(new URL('.', import.meta.url))) && !readOnly) {
  process.stderr.write('BuildX 内部测试包只支持 --read-only。\n');
  process.exit(2);
}
const receiptBridge=workspace?await import('./lib/chat-read-receipts.mjs'):null;
const receiptProducer=receiptBridge?.createChatReadReceiptProducer({
  key:process.env[receiptBridge.CHAT_READ_RECEIPT_KEY_ENV],port:Number(process.env[receiptBridge.CHAT_READ_RECEIPT_PORT_ENV])
});
// Legacy/read-only entries retain their original dependency boundary.
const workspaceDispatch=workspace||managed?(await import('./lib/model-tool-dispatch.mjs')).invokeModelTool:null;
const managedModule=managed?await import('./lib/managed-workbench-reads.mjs'):null;
// The standalone candidate exists for isolated probes only. A managed product
// caller needs a scope tied to its active panel turn.
const probeScope=managed?Symbol():null;
const managedRead=managedModule?.createManagedWorkbenchReads(workspaceDispatch,scope=>scope===probeScope);
const workspaceTools=workspace?(await import('./lib/panel-tools.mjs')).MODEL_AI_READ_TOOLS:null;
const tools=readOnly?READONLY_WORKBENCH_TOOL_NAMES.map(name=>{
  const matches=PANEL_WORKBENCH_TOOLS.filter(tool=>tool.name===name);
  if(matches.length!==1||matches[0].annotations?.readOnlyHint!==true)throw new Error('Read-only workbench catalog does not match its named contracts');
  return matches[0];
}):managed?managedModule.MANAGED_WORKBENCH_READ_TOOLS:workspace?workspaceTools:LEGACY_PANEL_WORKBENCH_TOOLS;
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
        const name=request.params.name,args=managed
          ?(Object.hasOwn(request.params,'arguments')?request.params.arguments:{})
          :(request.params.arguments||{});
        if(!exposedNames.has(name)||readOnly&&!readOnlyNames.has(name))throw new Error('此会话不提供该工具。');
        const onTiming=value=>{const data=sanitizePanelAudit('phase-timing.jsonl',value);if(data&&events.length<8)events.push(data);};
        retainReceiptOwner=Boolean(receiptProducer&&(isNativeModelQuery(name)||isNativeParameterQuery(name)));
        const value=managed?await managedRead(name,args,{scope:probeScope}):
          workspace?await workspaceDispatch(name,args,{onTiming,...retainReceiptOwner?{retainReceiptOwner:true}:{}}):
          isCommandTool(name)?await invokeCommand(name,args,{execute:invokeWorkbench}):await invokeWorkbench(name,args,readOnly?{onTiming}:{});
        if(retainReceiptOwner)await value?.receiptOwner?.close();
        result={content:[{type:'text',text:JSON.stringify(value)}],...(managed||isNativeModelQuery(name)||isNativeParameterQuery(name)?{structuredContent:value}:{}),isError:false};
      }
      catch(error){
        // MCP's isError describes a failed tool call, not necessarily a failed
        // Revit operation. Only the transport's typed algebra can establish a
        // definite outcome; all other exceptions remain unconfirmed.
        const {outcome,requestIds,receiptOwner}=workbenchFailureEvidence(error);
        if(retainReceiptOwner&&outcome==='unconfirmed'&&requestIds.length===1)
          receiptProof=receiptProducer.retain(request.params.name,requestIds[0],receiptOwner);
        if(!receiptProof)await receiptOwner?.close();
        const message=managed
          ?outcome==='not_started'?'查询尚未开始。请核对工具参数和当前文档的临时标识。':'查询没有返回可用结果。请在本机核对原请求，勿自动重试。'
          :receiptProof?'Revit 查询的原回执尚未确认，请勿自动重试。':error.message;
        result={content:[{type:'text',text:!managed&&error.producerResult?JSON.stringify({error:{message,outcome:error.modelOutcome},result:error.producerResult}):message}],isError:true,
          structuredContent:{buildxToolOutcome:{schemaVersion:1,outcome:['not_started','expired','failed'].includes(outcome)?outcome:'unconfirmed'}}};
      }
      if(events.length||receiptProof)result._meta={...events.length?{'buildx/phaseTiming':{schemaVersion:1,events}}:{},
        ...receiptProof?{[receiptBridge.CHAT_READ_RECEIPT_META]:receiptProof}:{}};
    }else{send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}});return;}
    send({jsonrpc:'2.0',id:request.id,result});
  }catch(error){send({jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:managed?'无效的 MCP 请求。':error.message}});}
});
