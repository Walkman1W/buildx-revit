// Shared contracts for native operations and script-backed modelling tools.
import {sameCadDocumentPath} from './cad-document-path.mjs';

function plain(value){return value&&typeof value==='object'&&!Array.isArray(value);}
export function workbenchDocumentIdentity(status){
  if(!plain(status)||typeof status.hostSession!=='string'||!status.hostSession||!plain(status.document)||typeof status.document.title!=='string'||typeof status.document.path!=='string')throw new Error('工作台未返回可核对的当前文档和会话');
  return {session:status.hostSession,title:status.document.title,path:status.document.path};
}
export function sameWorkbenchDocumentIdentity(a,b){return a.session===b.session&&a.title===b.title&&(a.path===b.path||(a.path!==''&&sameCadDocumentPath(a.path,b.path)));}
export function workbenchElementIdString(value){if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);if(typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n)return value;throw new Error('选择结果包含无法精确保留的元素 ID');}
export function workbenchSelectionSummary(value){
  if(!plain(value)||!Number.isSafeInteger(value.total)||value.total<0||!Number.isSafeInteger(value.returned)||value.returned<0||value.returned>200||!Array.isArray(value.items)||value.items.length!==value.returned||value.total<value.returned||typeof value.truncated!=='boolean'||value.truncated!==(value.total>value.returned))throw new Error('选择结果不完整或格式无效');
  const elementIds=value.items.map(item=>workbenchElementIdString(item.element_id));
  if(new Set(elementIds).size!==elementIds.length)throw new Error('选择结果包含重复元素 ID');
  return {elementIds,count:value.total,returned:value.returned,truncated:value.truncated};
}

export const expectedDocument = {type:'string',description:'Exact document.path returned by workbench status. An empty string matches an unsaved current document for read-only queries.'};
export const commonWrite = {
  expected_document:{...expectedDocument,minLength:1,description:'Exact path returned by workbench status; must be in the host allowed-document list.'},
  mode:{type:'string',enum:['rollback','commit'],default:'rollback',description:'rollback reads the result then undoes model changes; commit keeps changes in memory without saving.'}
};
export const elementId = {type:'integer',minimum:1};
export const elementIds = {type:'array',items:elementId,minItems:1,maxItems:50,uniqueItems:true};
export const pointMm = {type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'}},required:['x','y','z'],additionalProperties:false,description:'Finite x/y/z coordinates in millimetres in the Revit internal coordinate system.'};
