import {randomUUID} from 'node:crypto';
import {workbenchDocumentIdentity,workbenchSelectionSummary} from './workbench-contracts.mjs';

const statusTool='revit_workbench_status',selectionTool='revit_get_selection';
export const MANAGED_WORKBENCH_PILOT_REQUEST_POLICY='managed-workbench-pilot';
const documentRef=Object.freeze({type:'string',description:'Opaque reference from the latest revit_workbench_status response.'});
const statusInputs=Object.freeze({type:'object',properties:Object.freeze({}),additionalProperties:false});
const selectionInputs=Object.freeze({type:'object',properties:Object.freeze({document_ref:documentRef}),required:Object.freeze(['document_ref']),additionalProperties:false});
const annotations=Object.freeze({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
export const MANAGED_WORKBENCH_READ_TOOLS=Object.freeze([
  Object.freeze({name:statusTool,description:'Check whether a Revit document is open and obtain a temporary reference for a saved document.',inputSchema:statusInputs,annotations}),
  Object.freeze({name:selectionTool,description:'Read the selected element IDs and counts using the latest temporary document reference.',inputSchema:selectionInputs,annotations})
]);
export const MANAGED_WORKBENCH_DYNAMIC_TOOL=Object.freeze({
  type:'function',name:'buildx_managed_workbench_read',
  description:'Read Revit workbench status with empty parameters, then pass its temporary documentRef as document_ref to read the current selection.',
  inputSchema:Object.freeze({
    type:'object',additionalProperties:false,required:Object.freeze(['tool','parameters']),
    properties:Object.freeze({
      tool:Object.freeze({type:'string',enum:Object.freeze([statusTool,selectionTool])}),
      parameters:Object.freeze({type:'object',additionalProperties:false,properties:selectionInputs.properties})
    })
  })
});

function notStarted(){
  return Object.assign(new Error('请先读取工作台状态并使用当前已保存文档的临时标识。'),{interruptedBeforeEnqueue:true});
}
function staleResult(result){
  return Object.assign(new Error('工作台状态或托管轮次已变化，请核对原请求。'),{requestId:result?.request_id});
}

export function createManagedWorkbenchReads(invoke,isScopeCurrent){
  if(typeof invoke!=='function'||typeof isScopeCurrent!=='function')throw new TypeError('A trusted managed read scope is required');
  let statusRevision=0,current=null;
  return async (name,args,{scope,shouldContinue:continueRead}={})=>{
    if(args===null||typeof args!=='object'||Array.isArray(args))throw notStarted();
    const shouldContinue=()=>{
      try{
        return typeof scope==='symbol'&&isScopeCurrent(scope)===true&&
          (continueRead===undefined||continueRead()===true);
      }catch{return false;}
    };
    if(!shouldContinue()){
      if(current?.scope===scope)current=null;
      throw notStarted();
    }
    const control={shouldContinue};
    if(name===statusTool&&Object.keys(args).length===0){
      const revision=++statusRevision;
      current=null;
      const result=await invoke(name,{},control);
      if(statusRevision!==revision||!shouldContinue())throw staleResult(result);
      if(result.document===null)return {documentOpen:false,documentRef:null};
      const sourceDocument=workbenchDocumentIdentity(result);
      // An empty path cannot uniquely bind a later query to an unsaved document.
      if(!sourceDocument.path)return {documentOpen:true,documentRef:null};
      current={ref:randomUUID(),sourceDocument,scope};
      return {documentOpen:true,documentRef:current.ref};
    }
    if(name!==selectionTool||Object.keys(args).length!==1||!Object.hasOwn(args,'document_ref')||
      typeof args.document_ref!=='string'||args.document_ref!==current?.ref||current.scope!==scope)throw notStarted();
    const bound=current;
    try{
      const result=await invoke(name,{},{...control,sourceDocument:bound.sourceDocument});
      if(current!==bound||!shouldContinue())throw staleResult(result);
      return workbenchSelectionSummary(result.value);
    }catch(error){
      if(current===bound)current=null;
      throw error;
    }
  };
}
