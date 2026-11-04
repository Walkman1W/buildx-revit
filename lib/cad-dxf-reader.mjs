import {createHash} from 'node:crypto';

// v1 offline preview resource budgets, not DXF format limits.
export const ASCII_DXF_LIMITS = Object.freeze({maxBytes:2*1024*1024,maxEntities:20000,maxLineCharacters:4096});
const UNITS=new Map([[1,['inches',25.4]],[2,['feet',304.8]],[4,['millimetres',1]],[5,['centimetres',10]],[6,['metres',1000]]]);
const NUMBER=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const fail=(code,message,sourceLine)=>({ok:false,error:{code,message,...(sourceLine===undefined?{}:{sourceLine})}});
const issue=(code,message)=>({code,message});
function scalar(values,code,required,issues){
  const entries=values.get(code)||[];
  if(entries.length===0){
    if(required)issues.push(issue('MISSING_COORDINATE','LINE is missing coordinate group '+code+'.'));
    return required?null:0;
  }
  if(entries.length!==1){
    issues.push(issue('DUPLICATE_COORDINATE','LINE coordinate group '+code+' is not single-valued.'));
    return null;
  }
  const raw=entries[0].trim(),value=NUMBER.test(raw)?Number(raw):NaN;
  if(!Number.isFinite(value)){
    issues.push(issue('INVALID_COORDINATE','LINE coordinate group '+code+' is not a finite decimal number.'));
    return null;
  }
  return value;
}
function entityResult(entity){
  const {ordinal,type,sourceLine,values}=entity,issues=[];
  const layers=values.get(8)||[],handles=values.get(5)||[];
  let layer=null,handle=null;
  if(layers.length===0||layers[0].trim()==='')issues.push(issue('MISSING_LAYER','Entity has no explicit nonempty layer.'));
  else if(layers.length!==1)issues.push(issue('DUPLICATE_LAYER','Entity layer is not single-valued.'));
  else layer=layers[0];
  if(handles.length===1&&handles[0].trim()!=='')handle=handles[0];
  else if(handles.length>1)issues.push(issue('DUPLICATE_HANDLE','Entity handle is not single-valued.'));
  else if(handles.length===1)issues.push(issue('EMPTY_HANDLE','Entity handle is empty.'));
  const spaces=values.get(67)||[],layouts=values.get(410)||[];
  if(spaces.length>1||spaces.some(v=>!['0','1'].includes(v.trim())))
    issues.push(issue('INVALID_SPACE','Entity paper/model-space flag is invalid or repeated.'));
  else if(spaces[0]?.trim()==='1'||layouts.some(v=>v.trim()!=='Model'))
    issues.push(issue('PAPER_SPACE_ENTITY','Paper-space entity must not be used as a model axis.'));
  if(layouts.length>1)issues.push(issue('DUPLICATE_LAYOUT','Entity layout is not single-valued.'));
  if(entity.applicationGroupUnsupported)issues.push(issue('APPLICATION_GROUP_UNSUPPORTED','Entity contains application-defined group 102 data. Its contents are skipped and the entity cannot become a modelling candidate.'));
  let geometry=null;
  if(type==='LINE'){
    const from=[scalar(values,10,true,issues),scalar(values,20,true,issues),scalar(values,30,false,issues)];
    const to=[scalar(values,11,true,issues),scalar(values,21,true,issues),scalar(values,31,false,issues)];
    if([...from,...to].every(v=>v!==null))geometry={kind:'line',from,to};
  }else issues.push(issue('UNSUPPORTED_ENTITY','Entity type '+type+' is retained but not interpreted; INSERT/BLOCK geometry is not expanded.'));
  const result={ordinal,type,layer,handle,sourceLine,geometry,issues};
  if(type==='TEXT'||type==='MTEXT'){
    const parts=entity.textParts, terminal=parts.filter(part=>part.code===1);
    // MTEXT continuation group 3 precedes its single final group 1. Keep DXF
    // escape and formatting sequences literal: interpreting them needs a
    // format-aware text renderer and cannot be inferred from ASCII alone.
    const valid=terminal.length===1&&parts.at(-1)?.code===1&&
      (type==='MTEXT'||parts.length===1);
    const layouts=values.get(410)||[];
    result.textFact={status:valid?'raw':'invalid',raw:valid?parts.map(part=>part.value).join(''):null,
      sourceLines:valid?parts.map(part=>part.sourceLine):[],layout:layouts.length===1&&layouts[0].trim()?layouts[0]:null,
      representation:'literal-dxf-groups',formattingInterpreted:false};
  }
  return result;
}

/**
 * Reads direct ENTITIES/LINE coordinates in WCS without a transform or scale.
 * Development ASCII-DXF preview only; this does not read DWG or import Revit.
 * LINE reference: https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-FCEF5726-53AE-4C43-B4EA-C84EB8686A66.htm
 * Application group reference: https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-3610039E-27D1-4E23-B6D3-7E60B22BB5BD.htm
 * INSUNITS reference: https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-A58A87BB-482B-4042-A00A-EEF55A2B4FD8.htm
 */
export function readAsciiDxf(input,options={}){
  if(options===null||typeof options!=='object'||Array.isArray(options)||(Object.getPrototypeOf(options)!==Object.prototype&&Object.getPrototypeOf(options)!==null))
    return fail('INVALID_OPTIONS','Options must be a plain object.');
  const sourceName=options.sourceName===undefined?'<memory>':options.sourceName;
  if(!Buffer.isBuffer(input)&&typeof input!=='string')return fail('INVALID_INPUT','Input must be a Buffer or string.');
  if(typeof sourceName!=='string')return fail('INVALID_SOURCE_NAME','sourceName must be a string.');
  const size=input.length;
  if(size>ASCII_DXF_LIMITS.maxBytes)return fail('BYTE_LIMIT','ASCII-DXF preview exceeds the 2 MiB v1 resource budget.');
  const prefix=Buffer.isBuffer(input)?input.subarray(0,22).toString('ascii'):input.slice(0,22);
  if(prefix.startsWith('AutoCAD Binary DXF'))return fail('BINARY_DXF','Binary DXF is not supported by the ASCII preview reader.');
  for(let i=0;i<size;i++){
    const n=typeof input==='string'?input.charCodeAt(i):input[i];
    if(n!==9&&n!==10&&n!==13&&(n<32||n>126))
      return fail('NON_ASCII_INPUT','Only printable ASCII plus tab and line endings is supported.');
  }
  // The byte limit and ASCII validation precede the only complete text conversion.
  const text=Buffer.isBuffer(input)?input.toString('ascii'):input;
  const source={name:sourceName,sha256:createHash('sha256').update(input).digest('hex'),byteLength:size,format:'ascii-dxf'};
  let offset=0,lineNumber=0,lineFailure=null;
  function line(){
    if(offset===text.length)return null;
    const start=offset;
    while(offset<text.length&&text.charCodeAt(offset)!==10&&text.charCodeAt(offset)!==13){
      offset++;
      if(offset-start>ASCII_DXF_LIMITS.maxLineCharacters){
        lineFailure=fail('LINE_LIMIT','ASCII-DXF preview line exceeds the 4096-character v1 resource budget.',lineNumber+1);
        return null;
      }
    }
    const value=text.slice(start,offset);lineNumber++;
    if(offset<text.length){const ending=text.charCodeAt(offset++);if(ending===13&&text.charCodeAt(offset)===10)offset++;}
    return {text:value,line:lineNumber};
  }
  function pair(){
    const key=line();if(lineFailure)return lineFailure;if(key===null)return null;
    const val=line();if(lineFailure)return lineFailure;
    if(val===null)return fail('ODD_LINE_COUNT','DXF group code has no following value.',key.line);
    const codeText=key.text.trim();
    if(!/^\d{1,4}$/.test(codeText)||Number(codeText)>1071)
      return fail('INVALID_GROUP_CODE','DXF group code must be an integer from 0 through 1071.',key.line);
    return {code:Number(codeText),value:val.text,sourceLine:key.line};
  }
  const entities=[],warnings=[issue('OFFLINE_DXF_SCOPE','Only direct ENTITIES/LINE is interpreted. No DWG, INSERT/BLOCK expansion, Revit import, model creation or transformation is performed.')];
  let section=null,awaitSection=false,seenHeader=false,seenEntities=false,eof=false,entity=null;
  let headerVariable=null,unitsSeen=false,unitValues=[],unitsCode=null,skippedSection=false;
  const retainedCodes=new Set([5,8,10,20,30,11,21,31,67,410]);
  function flushEntity(){if(entity!==null){entities.push(entityResult(entity));entity=null;}}
  function flushVariable(){
    if(headerVariable?.name!=='$INSUNITS')return null;
    if(unitValues.length!==1||unitValues[0].code!==70||!/^\d+$/.test(unitValues[0].value.trim())||!Number.isSafeInteger(Number(unitValues[0].value.trim())))
      return fail('INVALID_INSUNITS','$INSUNITS must have exactly one nonnegative integer group 70 value.',headerVariable.sourceLine);
    unitsCode=Number(unitValues[0].value.trim());return null;
  }
  while(true){
    const current=pair();if(current?.ok===false)return current;if(current===null)break;
    const {code,value,sourceLine}=current,marker=value.trim();
    if(eof)return fail('DATA_AFTER_EOF','DXF has group data after EOF.',sourceLine);
    if(code===999)continue;
    // Group 102 owns its payload: application tags must not be interpreted as
    // entity fields. A group cannot cross an entity or structural boundary.
    if(section==='ENTITIES'&&entity!==null){
      if(entity.applicationGroup!==null&&code===0)
        return fail('UNCLOSED_APPLICATION_GROUP','Application-defined group 102 reaches an entity or section boundary without closing.',sourceLine);
      if(code===102){
        if(entity.applicationGroup!==null){
          if(marker==='}')entity.applicationGroup=null;
          else if(marker.startsWith('{'))return fail('NESTED_APPLICATION_GROUP','Nested application-defined group 102 is not supported.',sourceLine);
          else return fail('INVALID_APPLICATION_GROUP','Application-defined group 102 must close with }.',sourceLine);
        }else{
          if(!/^\{[^{}]+$/.test(marker))return fail('INVALID_APPLICATION_GROUP','Application-defined group 102 must open with {application_name.',sourceLine);
          entity.applicationGroup={sourceLine};
          entity.applicationGroupUnsupported=true;
        }
        continue;
      }
      if(entity.applicationGroup!==null)continue;
    }
    if(awaitSection){
      if(code!==2||!/^[A-Za-z0-9_]+$/.test(marker))return fail('INVALID_SECTION_NAME','SECTION must be followed by a nonempty group 2 section name.',sourceLine);
      section=marker;awaitSection=false;
      if(section==='HEADER'){
        if(seenHeader)return fail('DUPLICATE_HEADER','Only one HEADER section is supported.',sourceLine);
        seenHeader=true;
      }else if(section==='ENTITIES'){
        if(seenEntities)return fail('DUPLICATE_ENTITIES','Only one ENTITIES section is supported.',sourceLine);
        seenEntities=true;
      }else if(!skippedSection){
        warnings.push(issue('UNINSPECTED_SECTIONS','Sections other than HEADER and ENTITIES are not interpreted, including BLOCKS and TABLES.'));skippedSection=true;
      }
      continue;
    }
    if(code===0&&marker==='SECTION'){
      if(section!==null)return fail('NESTED_SECTION','A SECTION cannot start before ENDSEC.',sourceLine);
      awaitSection=true;continue;
    }
    if(code===0&&marker==='ENDSEC'){
      if(section===null)return fail('UNEXPECTED_ENDSEC','ENDSEC has no open SECTION.',sourceLine);
      if(section==='HEADER'){const error=flushVariable();if(error)return error;headerVariable=null;}
      if(section==='ENTITIES')flushEntity();
      section=null;continue;
    }
    if(code===0&&marker==='EOF'){
      if(section!==null)return fail('EOF_IN_SECTION','EOF occurs before ENDSEC.',sourceLine);
      eof=true;continue;
    }
    if(section===null)return fail('DATA_OUTSIDE_SECTION','Expected SECTION or EOF outside a section.',sourceLine);
    if(section==='HEADER'){
      if(code===0)return fail('INVALID_HEADER','HEADER cannot contain an entity marker.',sourceLine);
      if(code===9){
        const error=flushVariable();if(error)return error;
        headerVariable={name:marker,sourceLine};unitValues=[];
        if(marker==='$INSUNITS'){
          if(unitsSeen)return fail('DUPLICATE_INSUNITS','$INSUNITS is repeated.',sourceLine);
          unitsSeen=true;
        }
      }else{
        if(headerVariable===null)return fail('INVALID_HEADER','HEADER values must follow a group 9 variable name.',sourceLine);
        if(headerVariable.name==='$INSUNITS'){
          // Retain at most two values: enough to prove a single-value violation.
          if(unitValues.length<2)unitValues.push({code,value});
        }
      }
    }else if(section==='ENTITIES'){
      if(code===0){
        flushEntity();
        if(!/^[A-Za-z0-9_]+$/.test(marker))return fail('INVALID_ENTITY_TYPE','Entity group 0 must contain a nonempty type name.',sourceLine);
        if(entities.length>=ASCII_DXF_LIMITS.maxEntities)return fail('ENTITY_LIMIT','ASCII-DXF preview exceeds the 20000-entity v1 resource budget.',sourceLine);
        entity={ordinal:entities.length+1,type:marker,sourceLine,values:new Map(),textParts:[],applicationGroup:null,applicationGroupUnsupported:false};
      }else{
        if(entity===null)return fail('ENTITY_DATA_WITHOUT_TYPE','ENTITIES values must follow an entity group 0.',sourceLine);
        if(((entity.type==='TEXT'&&code===1)||(entity.type==='MTEXT'&&(code===1||code===3)))&&entity.textParts.length>=1024)
          return fail('TEXT_PART_LIMIT','One text entity exceeds the 1024-part resource budget.',sourceLine);
        if((entity.type==='TEXT'&&code===1)||(entity.type==='MTEXT'&&(code===1||code===3)))
          entity.textParts.push({code,value,sourceLine});
        if(retainedCodes.has(code)){
          const values=entity.values.get(code)||[];
          // Only the first two values are needed to preserve single-value uncertainty.
          if(values.length<2)values.push(value);
          entity.values.set(code,values);
        }
      }
    }
  }
  if(entity?.applicationGroup!==null&&entity?.applicationGroup!==undefined)return fail('UNCLOSED_APPLICATION_GROUP','DXF ends before application-defined group 102 closes.',entity.applicationGroup.sourceLine);
  if(awaitSection)return fail('MISSING_SECTION_NAME','SECTION has no following name.');
  if(section!==null)return fail('MISSING_ENDSEC','DXF ends before ENDSEC.');
  if(!eof)return fail('MISSING_EOF','DXF ends without EOF.');
  if(!seenEntities)return fail('MISSING_ENTITIES','DXF has no ENTITIES section.');
  const supported=UNITS.get(unitsCode),units={code:unitsCode,name:supported?.[0]??null,millimetresPerUnit:supported?.[1]??null};
  if(!supported)warnings.push(issue(unitsCode===null?'MISSING_UNITS':'UNKNOWN_UNITS',unitsCode===null?'$INSUNITS is absent; no unit scale is assumed.':'$INSUNITS '+unitsCode+' is not resolved by this v1 reader; no unit scale is assumed.'));
  const lineCount=entities.filter(e=>e.type==='LINE').length;
  return {ok:true,value:{source,units,entities,warnings,coverage:{entityCount:entities.length,lineCount,unsupportedCount:entities.length-lineCount,invalidLineCount:entities.filter(e=>e.type==='LINE'&&e.geometry===null).length}}};
}
