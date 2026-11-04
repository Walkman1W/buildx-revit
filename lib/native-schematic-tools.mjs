import path from 'node:path';
import {commonWrite} from './workbench-contracts.mjs';

const id={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const text=(minLength,maxLength)=>({type:'string',minLength,maxLength});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const savedDocument={...commonWrite.expected_document,maxLength:32768};
export const SCHEMATIC_DRAWING_SCHEMA=object({
  schemaVersion:{type:'integer',enum:[1]},
  documentPath:text(1,32768),documentFingerprint:text(1,512),
  rootElementId:id,rootUniqueId:text(1,512),
  nodes:{type:'array',minItems:1,maxItems:300,items:object({
    key:text(1,16),uniqueId:text(1,512),label:text(0,300),category:text(0,300),elementId:id,
    x:{type:'number',minimum:-1000000,maximum:1000000},y:{type:'number',minimum:-1000000,maximum:1000000}
  })},
  edges:{type:'array',maxItems:800,items:object({source:text(1,16),target:text(1,16)})},
  warnings:{type:'array',maxItems:100,items:text(0,1000)}
});
export const NATIVE_SCHEMATIC_TOOLS=[
  {
    name:'revit_preview_schematic',
    description:'Read a self-authored BuildX physical pipe/duct connector graph from a real start element in a saved current project. Requires host 0.4.0+. Returns the exact editable drawing DTO; x/y are schematic-layout millimetres, not model coordinates. Basic BFS layout only, no engineering calculation. Does not modify Revit or open the WPF editor. Keep identities and topology unchanged; edit only node x/y/label before revit_export_schematic.',
    inputSchema:object({expected_document:savedDocument,start_element_id:id}),
    annotations:{readOnlyHint:true}
  },
  {
    name:'revit_export_schematic',
    description:'Create a native drafting view from a fresh revit_preview_schematic DTO with edited node x/y/label. Requires host 0.4.0+ and an allowed document. Self-authored basic rectangle symbols and text; no recovered Argus runtime or family resources. The host rechecks document fingerprint, source element identities and physical topology. Default rollback; commit only when applying is requested. Does not alter the 3D network or save the project. Returned temporary IDs are invalid after rollback; independently check absence. No automatic retry after unknown outcomes.',
    inputSchema:{type:'object',properties:{...commonWrite,expected_document:savedDocument,drawing:SCHEMATIC_DRAWING_SCHEMA},required:['expected_document','drawing'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}
  }
];
export const NATIVE_SCHEMATIC_OPERATION_BY_TOOL={revit_preview_schematic:'preview_schematic',revit_export_schematic:'export_schematic'};
export const isNativeSchematicTool=name=>Object.hasOwn(NATIVE_SCHEMATIC_OPERATION_BY_TOOL,name);
export function assertNativeSchematicDocument(name,args){
  if(!isNativeSchematicTool(name))return;
  if(!path.win32.isAbsolute(args.expected_document))throw new Error('expected_document must be the saved absolute Windows document path');
  if(name==='revit_export_schematic'&&(!path.win32.isAbsolute(args.drawing.documentPath)||path.win32.normalize(args.drawing.documentPath).toLowerCase()!==path.win32.normalize(args.expected_document).toLowerCase()))
    throw new Error('drawing.documentPath must match expected_document; refresh the preview instead of rewriting its identity');
}
// Validate only this adapter's advertised response contract. C# owns graph semantics.
export function assertNativeSchematicResult(name,result,args,validate){
  const operation=NATIVE_SCHEMATIC_OPERATION_BY_TOOL[name];
  if(!result||result.operation!==operation||!Object.hasOwn(result,'value'))throw new Error('Schematic operation/result mismatch');
  if(name==='revit_preview_schematic'){
    const drawing=validate(SCHEMATIC_DRAWING_SCHEMA,result.value,'preview.value');
    assertNativeSchematicDocument('revit_export_schematic',{expected_document:args.expected_document,drawing});
    if(result.modifiedByOperation!==false||drawing.rootElementId!==args.start_element_id)throw new Error('Preview identity or read-only result mismatch');
    return;
  }
  const value=result.value,n=args.drawing.nodes.length,e=args.drawing.edges.length;
  if(result.mode!==args.mode||typeof result.committed!=='boolean'||result.committed!==(args.mode==='commit'))throw new Error('Schematic transaction outcome mismatch');
  if(!value||!Number.isSafeInteger(value.view_id)||value.view_id<=0||typeof value.view_name!=='string'||!value.view_name
    ||!Array.isArray(value.element_ids)||value.element_ids.length!==5*n+e||new Set(value.element_ids).size!==value.element_ids.length
    ||value.element_ids.some(x=>!Number.isSafeInteger(x)||x<=0)||value.actual_node_count!==n||value.edge_line_count!==e
    ||value.text_count!==n||value.detail_curve_count!==4*n+e||value.symbol_style!=='basic-native-symbols'||value.layout_note!=='layout_bfs_not_engineering_analysis')
    throw new Error('Schematic native read-back contract mismatch');
}
