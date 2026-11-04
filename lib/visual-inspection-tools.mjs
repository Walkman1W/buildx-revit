import path from 'node:path';
import {expectedDocument,elementId,elementIds,sameWorkbenchDocumentIdentity} from './workbench-contracts.mjs';

const positiveIds={...elementIds,maxItems:50};
const pixelSize={type:'integer',minimum:256,maximum:2048,default:1280,description:'Requested longest export dimension in pixels. Actual verified dimensions are returned; PNG files are bounded to 2 MiB each.'};
const document={...expectedDocument,minLength:1,description:'Exact saved, allowed document path from current workbench status. The native callback rechecks identity.'};
const contract=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties:{expected_document:document,...properties},required:['expected_document',...required],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}});
export const VISUAL_OPERATION_BY_TOOL=Object.freeze({revit_capture_view:'capture_view',revit_inspect_elements:'inspect_elements',revit_restore_visual_session:'restore_visual_session'});
export const VISUAL_INSPECTION_TOOLS=Object.freeze([
  contract('revit_capture_view','Export the specified or current native Revit view to a verified PNG in the workbench-owned artifact directory. Does not change the active view, selection or source view visibility; creates a local image, not a pure read.',{view_id:elementId,pixel_size:pixelSize},[]),
  contract('revit_inspect_elements','Isolate targets and explicit context in an owned temporary 3D inspection view, frame their real bounds, export up to three orientations, then roll back the temporary view in finally. Source view visibility, orientation, zoom and selection remain untouched. Use actual element_ids or a source_request_id from this process\'s committed creation receipt; never replay unknown outcomes.',{element_ids:positiveIds,source_request_id:{type:'string',minLength:36,maxLength:36,description:'Exact request_id of a committed supported creation operation in this conversation/process. Rollback or foreign-document creation receipts cannot be inspected.'},context_element_ids:{type:'array',items:elementId,maxItems:100,uniqueItems:true,default:[]},source_view_id:elementId,orientations:{type:'array',items:{type:'string',enum:['isometric','front','side']},minItems:1,maxItems:3,uniqueItems:true,default:['isometric']},pixel_size:pixelSize},[]),
  contract('revit_restore_visual_session','Retry cleanup of the exact pending visual-session handle in the same Revit host and document. No new capture, model save or arbitrary file operation.',{session_handle:{type:'string',minLength:1,maxLength:180}},['session_handle'])
]);
export const isVisualInspectionTool=name=>Object.hasOwn(VISUAL_OPERATION_BY_TOOL,name);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const validId=v=>Number.isSafeInteger(v)&&v>0;
const validRequestId=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const fail=message=>{throw new Error(message);};
export function assertVisualArguments(name,args,{allowCreationSource=true}={}){
  if(!isVisualInspectionTool(name))fail('Unknown visual inspection tool');
  if(name==='revit_inspect_elements'){
    const ids=Object.hasOwn(args,'element_ids'),source=Object.hasOwn(args,'source_request_id');
    if(!ids&&!source||source&&(!allowCreationSource||!validRequestId(args.source_request_id)))fail('Inspection requires actual element_ids or a supported committed source_request_id.');
  }
  if(name==='revit_restore_visual_session'&&!/^[a-zA-Z0-9_-]{1,180}$/.test(args.session_handle))fail('Invalid visual restoration handle');
}
function sameIds(actual,expected){return Array.isArray(actual)&&actual.length===expected.length&&actual.every((v,i)=>validId(v)&&v===expected[i]);}
export function assertVisualArtifact(image,{hostSession,requestId,root}={}){
  if(!plain(image)||typeof image.artifact_id!=='string'||!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(image.artifact_id)||typeof image.path!=='string'||!path.isAbsolute(image.path)||typeof image.sha256!=='string'||!/^[a-f0-9]{64}$/.test(image.sha256)||!Number.isSafeInteger(image.bytes)||image.bytes<1||image.bytes>2*1024*1024||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width>4096||image.height>4096||image.width*image.height>16000000||!validId(image.view_id)||typeof image.view_name!=='string'||image.view_name.length>1024||!['current','isometric','front','side'].includes(image.orientation)||typeof image.captured_at!=='string'||!Number.isFinite(Date.parse(image.captured_at)))fail('Invalid native visual artifact');
  if(hostSession&&requestId&&root){
    const directory=path.resolve(root,'visual-captures',hostSession,requestId),absolute=path.resolve(image.path),relative=path.relative(directory,absolute);
    if(!relative||path.isAbsolute(relative)||relative.includes(path.sep)||relative==='..'||!relative.toLowerCase().endsWith('.png'))fail('Visual artifact is outside its exact host/request directory');
  }
  return image;
}
export function assertVisualResult(name,result,args,{hostSession,requestId,root,sourceDocument}={}){
  const operation=VISUAL_OPERATION_BY_TOOL[name],body=result?.value;
  if(!operation||!plain(result)||result.operation!==operation||result.hostSession!==hostSession||!plain(result.document)||typeof result.document.title!=='string'||result.document.title.length>1024||typeof result.document.path!=='string'||result.document.path!==args.expected_document||!plain(body)||body.schema_version!==1||body.operation!==operation||body.host_session!==hostSession||!plain(body.document)||body.document.path!==result.document.path||body.document.title!==result.document.title||typeof body.success!=='boolean'||typeof body.cleanup_pending!=='boolean'||typeof body.code!=='string'||body.code.length>160||typeof body.outcome!=='string'||body.outcome.length>160)fail('Visual result host, operation or document identity mismatch');
  if(sourceDocument&&!sameWorkbenchDocumentIdentity(sourceDocument,{session:hostSession,title:result.document.title,path:result.document.path}))fail('Visual result belongs to another source document');
  const restoration=body.restoration;
  if(!plain(restoration)||!['unchanged','restored','pending'].includes(restoration.status)||restoration.source_view_unchanged!==true)fail('Visual restoration outcome is incomplete');
  if(restoration.status==='pending'){
    if(typeof restoration.session_handle!=='string'||!restoration.session_handle||body.cleanup_pending!==true||body.success!==false)fail('Pending restoration must retain its exact recovery handle');
  }else if(restoration.session_handle!==null||body.cleanup_pending!==false)fail('Completed restoration cannot retain an unknown cleanup state');
  if(!Array.isArray(body.images)||body.images.length>3||!Array.isArray(body.target_ids)||!body.target_ids.every(validId)||!Array.isArray(body.context_ids)||!body.context_ids.every(validId))fail('Invalid visual result coverage');
  if(name==='revit_inspect_elements'&&(!sameIds(body.target_ids,args.element_ids)||!sameIds(body.context_ids,args.context_element_ids??[])))fail('Visual result target identities changed');
  const seen=new Set();
  for(const image of body.images){assertVisualArtifact(image,{hostSession,requestId,root});if(seen.has(image.artifact_id))fail('Duplicate visual artifact identity');seen.add(image.artifact_id);}
  if(body.success){
    if(name==='revit_capture_view'&&(body.images.length!==1||restoration.status!=='unchanged'||body.images[0].orientation!=='current'||args.view_id!==undefined&&body.images[0].view_id!==args.view_id))fail('View capture is missing its requested image or unchanged-source evidence');
    if(name==='revit_inspect_elements'&&(body.images.length!==(args.orientations??['isometric']).length||restoration.status!=='restored'||body.images.some((image,i)=>image.orientation!==(args.orientations??['isometric'])[i])))fail('Inspection orientations or restoration are incomplete');
    if(name==='revit_restore_visual_session'&&(body.images.length!==0||restoration.status!=='restored'))fail('Restore did not complete');
  }
  return result;
}
