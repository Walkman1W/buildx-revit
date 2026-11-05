import {parseExactIdValue} from './command-fields.mjs';

// Presentation checks only. The server's immutable approval owner binds these
// facts and the native setter revalidates them before changing the type.
export const TYPE_PARAMETER_REVIEW_MAX_CHARACTERS=60000;
export const TYPE_PARAMETER_REVIEW_MAX_BYTES=100000;
const positiveId={anyOf:[{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^[1-9]\\d{0,18}$',maxLength:19}]};
const parameterId={anyOf:[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(?:0|[1-9]\\d{0,18})$',maxLength:20}],not:{enum:[0,-1,'0','-1']}};
const invalid=()=>{throw new Error('类型参数审阅事实不完整，请重新核对当前模型。');};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fields=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const text=(value,max,empty=true)=>typeof value==='string'&&value.length<=max&&(empty||value.length>0);
const nullableText=(value,max)=>value===null||text(value,max);
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const typed=(value,storage)=>storage==='String'?text(value,8192):storage==='Integer'?int32(value):storage==='Double'?typeof value==='number'&&Number.isFinite(value):false;
function exactId(value,signed=false){
  const normalized=parseExactIdValue(signed?parameterId:positiveId,value),id=BigInt(normalized);
  if(id>9223372036854775807n||id<(signed?-9223372036854775808n:1n))invalid();
  return id;
}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export function parseTypeParameterWriteReview(serialized){
  if(typeof serialized!=='string'||serialized.length>TYPE_PARAMETER_REVIEW_MAX_CHARACTERS||
    new TextEncoder().encode(serialized).length>TYPE_PARAMETER_REVIEW_MAX_BYTES)invalid();
  let value;try{value=JSON.parse(serialized);}catch{invalid();}
  if(!fields(value,['schema_version','document','type_id','type_name','parameter','mode','value','value_unit','instance_ids','instance_count','scope','indirect_effects'])||value.schema_version!==1||
    !fields(value.document,['session','title','path'])||!text(value.document.session,160,false)||!text(value.document.title,1024,false)||!text(value.document.path,32768,false)||
    [value.document.session,value.document.title,value.document.path].some(part=>/[\0\r\n]/.test(part))||!nullableText(value.type_name,1024)||
    !['rollback','commit'].includes(value.mode)||![null,'internal'].includes(value.value_unit)||
    !fields(value.parameter,['parameter_id','name','storage_type','is_read_only','has_value','data_type','unit_type','value_internal','value_display']))invalid();
  const parameter=value.parameter;
  const typeId=exactId(value.type_id);exactId(parameter.parameter_id,true);
  if(!text(parameter.name,1024)||!['String','Integer','Double'].includes(parameter.storage_type)||parameter.is_read_only!==false||typeof parameter.has_value!=='boolean'||
    !nullableText(parameter.data_type,1024)||!nullableText(parameter.unit_type,1024)||!nullableText(parameter.value_display,8192)||
    parameter.has_value===false&&parameter.value_internal!==null||parameter.value_internal!==null&&!typed(parameter.value_internal,parameter.storage_type)||
    !typed(value.value,parameter.storage_type)||parameter.storage_type==='Double'&&value.value_unit!=='internal'||
    !Array.isArray(value.instance_ids)||value.instance_ids.length>500||!Number.isSafeInteger(value.instance_count)||value.instance_count!==value.instance_ids.length||
    value.scope!=='current_document_direct_type_references'||value.indirect_effects!=='not_assessed')invalid();
  let previous=0n;
  for(const id of value.instance_ids){
    if(typeof id!=='string')invalid();
    const exact=exactId(id);if(exact<=previous||exact===typeId)invalid();previous=exact;
  }
  return freeze(value);
}

const raw=value=>value===null?'null（原始值）':typeof value==='string'?value===''?'空字符串（""）':'字符串：'+JSON.stringify(value):String(value);
export function renderTypeParameterWriteReview(document,review){
  const make=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
  const card=make('section');card.className='type-parameter-write-review';
  card.setAttribute('aria-label','本次类型参数修改审阅');
  const detail=make('dl'),parameter=review.parameter,shown=review.instance_ids.slice(0,50);
  const rows=[['模型名称',review.document.title],['模型路径',review.document.path],['宿主会话',review.document.session],
    ['类型名称',review.type_name===null?'未知（null）':raw(review.type_name)],['类型 ID',String(review.type_id)],
    ['参数名称',parameter.name],['参数 ID',String(parameter.parameter_id)],['存储类型',parameter.storage_type],
    ['数据类型',parameter.data_type===null?'未知（null）':raw(parameter.data_type)],['单位标识',parameter.unit_type===null?'未知或不适用（null）':raw(parameter.unit_type)],
    ['是否有值（HasValue）',parameter.has_value?'是（true）':'否（false）'],['写前原始内部值',raw(parameter.value_internal)],
    ['写前显示值',parameter.value_display===null?'未知（null）':raw(parameter.value_display)],['拟议原始内部值',raw(review.value)],
    ['拟议值单位',review.value_unit==='internal'?'Revit 内部单位（internal）':'未指定；字符串或整数值不作单位转换'],
    ['执行方式',review.mode==='commit'?'应用修改（commit）；保留模型修改，不自动保存文件':'回滚预览（rollback）；不保留本次模型事务修改'],
    ['直接实例数',String(review.instance_count)],['核查范围','当前文档中直接引用该类型的实例'],['间接影响','未评估'],
    ['直接实例 ID','显示 '+shown.length+' / '+review.instance_count+' 个'+(shown.length?'：'+shown.join(', '):'（当前文档无直接实例；间接影响仍未评估）')]];
  for(const [label,text] of rows){const value=make('dd',text);value.tabIndex=0;detail.append(make('dt',label),value);}
  card.append(make('strong','请逐项审阅本次类型参数修改'),detail,
    make('p','本次修改作用于所列类型。只读影响核查不授予写权限；即使当前为自动应用，也需要在这里确认本次操作。间接影响未评估。'));
  return card;
}
