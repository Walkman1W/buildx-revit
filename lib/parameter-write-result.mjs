// Reconcile reported parameter values with the exact published request. Revit's
// parameter owner still owns storage interpretation and all unit conversion.
import {nativeModelQueryExactId} from './native-model-queries.mjs';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=()=>{throw new Error('Parameter write receipt does not match the published changes.');};
function fields(value,expected){if(!plain(value)||Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))fail();}
const elementId=value=>Number.isSafeInteger(value)&&value>0;
const parameterId=value=>Number.isSafeInteger(value)&&value!==0&&value!==-1;
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const typed=(value,storage)=>storage==='Double'?typeof value==='number'&&Number.isFinite(value):storage==='Integer'?int32(value):storage==='String'?typeof value==='string':false;
export function assertParameterWriteResult(value,args,{exactIds=false}={}){
  const validId=(value,signed=false)=>{if(!exactIds)return signed?parameterId(value):elementId(value);try{const id=nativeModelQueryExactId(value,{signed});return !signed||id!==0n&&id!==-1n;}catch{return false;}};
  const rowId=(value,signed=false)=>validId(value,signed)&&(!exactIds||typeof value==='string');
  fields(value,['updated_count','changes']);
  if(!plain(args)||!Array.isArray(args.changes)||args.changes.length<1||args.changes.length>50||
    !Array.isArray(value.changes)||value.changes.length!==args.changes.length||value.updated_count!==args.changes.length)fail();
  const expected=new Map();
  for(const change of args.changes){
    if(!plain(change)||Object.keys(change).some(key=>!['element_id','parameter_id','value','value_unit',...(exactIds?['expected_state']:[])].includes(key))||!validId(change.element_id)||!validId(change.parameter_id,true)||
      !['string','number'].includes(typeof change.value)||typeof change.value==='number'&&!Number.isFinite(change.value)||
      Object.hasOwn(change,'value_unit')&&change.value_unit!=='internal')fail();
    const key=change.element_id+':'+change.parameter_id;if(expected.has(key))fail();expected.set(key,change);
  }
  for(const row of value.changes){
    fields(row,['element_id','parameter_id','storage_type','data_type','changed','before_internal','after_internal']);
    if(!rowId(row.element_id)||!rowId(row.parameter_id,true)||!(typeof row.data_type==='string'||exactIds&&row.data_type===null)||typeof row.changed!=='boolean')fail();
    const key=row.element_id+':'+row.parameter_id,change=expected.get(key);if(!change)fail();expected.delete(key);
    if(!typed(change.value,row.storage_type)||!typed(row.after_internal,row.storage_type)||
      row.before_internal!==null&&!typed(row.before_internal,row.storage_type)||
      row.storage_type==='Double'&&change.value_unit!=='internal'||row.after_internal!==change.value||
      row.changed!==(row.before_internal!==row.after_internal))fail();
  }
  if(expected.size)fail();
  return value;
}
