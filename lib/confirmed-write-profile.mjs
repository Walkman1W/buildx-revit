import {readFileSync} from 'node:fs';
import path from 'node:path';
export const CONFIRMED_WRITE_TOOLS=Object.freeze(['revit_set_parameter_value','revit_set_type_parameter','revit_create_group','revit_convert_to_group']);
const scopedAutoApplyOperations=Object.freeze({revit_set_parameter_value:'set_parameter_value',revit_create_group:'create_group',revit_convert_to_group:'create_group'});
export function scopedAutoApplyOperation(tool){return Object.hasOwn(scopedAutoApplyOperations,tool)?scopedAutoApplyOperations[tool]:null;}
export function supportsScopedAutoApply(capabilities,operation){
  const operations=capabilities?.scopedAutoApplyOperations;
  return capabilities?.scopedAutoApplyVersion===1&&Array.isArray(operations)&&
    (operation?operations.includes(operation):Object.values(scopedAutoApplyOperations).every(name=>operations.includes(name)));
}
export const supportsConfirmedWriteCommand=command=>Boolean(command&&(CONFIRMED_WRITE_TOOLS.includes(command.tool)||command.readOnly===true&&!command.tool.startsWith('revit_family_')&&command.tool!=='revit_capture_view'));
export function confirmedWriteProfile(root){
  let raw;try{raw=readFileSync(path.join(root,'buildx-confirmed-write.json'),'utf8');}catch(e){if(e.code==='ENOENT')return false;throw e;}
  let marker;try{marker=JSON.parse(raw);}catch{throw new Error('Invalid confirmed-write marker');}
  if(!marker||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='schemaVersion,scope'||marker.schemaVersion!==1||marker.scope!=='confirmed-write')throw new Error('Invalid confirmed-write marker');
  return true;
}
