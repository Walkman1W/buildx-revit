import {sameWorkbenchDocumentIdentity} from './workbench-contracts.mjs';

const fields=Object.freeze({revit_create_wall:'element_id',revit_create_pipe:'element_id',revit_copy_elements:'created_element_ids',revit_place_family_instance:'created_ids',revit_place_door:'created_ids',revit_place_window:'element_id',revit_create_floor:'created_ids'});
const requestId=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const scopeKey=scope=>scope&&typeof scope.account==='string'&&typeof scope.conversationId==='string'?JSON.stringify([scope.account,scope.conversationId]):null;

// Only the named producer's creation field is interpreted here. Generic C#
// return objects cannot establish that an arbitrary ID was newly created.
export function createCreatedElementLedger({maximum=200}={}){
  const records=new Map();
  function record(tool,result,document,scope){
    if(!Object.hasOwn(fields,tool)||!requestId(result?.request_id)||!['commit','rollback'].includes(result?.mode)||result.committed!==(result.mode==='commit')||result.document!==document?.title)return null;
    const raw=result.value?.[fields[tool]],ids=Array.isArray(raw)?raw:[raw];
    if(!ids.length||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length)return null;
    const value=Object.freeze({schema_version:1,source_request_id:result.request_id,tool,document:Object.freeze({...document}),mode:result.mode,committed:result.committed,valid_for_inspection:result.committed,element_ids:Object.freeze([...ids])});
    if(!records.has(result.request_id)&&records.size>=maximum)records.delete(records.keys().next().value);
    records.set(result.request_id,{value,scope:scopeKey(scope)});return value;
  }
  function resolve(id,document,scope){
    const stored=records.get(id),key=scopeKey(scope);
    if(!stored||key===null||stored.scope!==key||!sameWorkbenchDocumentIdentity(stored.value.document,document))throw new Error('创建来源不属于当前账号、对话、宿主或模型，请使用已核实的当前元素 ID。');
    if(!stored.value.valid_for_inspection)throw new Error('该创建操作已回滚，临时元素 ID 不可用于事后视觉复核。');
    return stored.value;
  }
  return Object.freeze({record,resolve});
}
