// Reconcile reported parameter values with the exact published request. Revit's
// parameter owner still owns storage interpretation and all unit conversion.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=()=>{throw new Error('Parameter write receipt does not match the published changes.');};
function fields(value,expected){if(!plain(value)||Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))fail();}
const elementId=value=>Number.isSafeInteger(value)&&value>0;
const parameterId=value=>Number.isSafeInteger(value)&&value!==0&&value!==-1;
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const typed=(value,storage)=>storage==='Double'?typeof value==='number'&&Number.isFinite(value):storage==='Integer'?int32(value):storage==='String'?typeof value==='string':false;
export function assertParameterWriteResult(value,args){
  fields(value,['updated_count','changes']);
  if(!plain(args)||!Array.isArray(args.changes)||args.changes.length<1||args.changes.length>50||
    !Array.isArray(value.changes)||value.changes.length!==args.changes.length||value.updated_count!==args.changes.length)fail();
  const expected=new Map();
  for(const change of args.changes){
    if(!plain(change)||Object.keys(change).some(key=>!['element_id','parameter_id','value','value_unit'].includes(key))||!elementId(change.element_id)||!parameterId(change.parameter_id)||
      !['string','number'].includes(typeof change.value)||typeof change.value==='number'&&!Number.isFinite(change.value)||
      Object.hasOwn(change,'value_unit')&&change.value_unit!=='internal')fail();
    const key=change.element_id+':'+change.parameter_id;if(expected.has(key))fail();expected.set(key,change);
  }
  for(const row of value.changes){
    fields(row,['element_id','parameter_id','storage_type','data_type','changed','before_internal','after_internal']);
    if(!elementId(row.element_id)||!parameterId(row.parameter_id)||typeof row.data_type!=='string'||typeof row.changed!=='boolean')fail();
    const key=row.element_id+':'+row.parameter_id,change=expected.get(key);if(!change)fail();expected.delete(key);
    if(!typed(change.value,row.storage_type)||!typed(row.after_internal,row.storage_type)||
      row.before_internal!==null&&!typed(row.before_internal,row.storage_type)||
      row.storage_type==='Double'&&change.value_unit!=='internal'||row.after_internal!==change.value||
      row.changed!==(row.before_internal!==row.after_internal))fail();
  }
  if(expected.size)fail();
  return value;
}
