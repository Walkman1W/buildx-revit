import {createHash} from 'node:crypto';
import {workbenchDocumentIdentity, sameWorkbenchDocumentIdentity} from './workbench-contracts.mjs';
import {workbenchFailureEvidence} from './workbench-client.mjs';

const fail=(code,message)=>({ok:false,error:{code,message}});
const point=p=>p && typeof p==='object' && ['x','y','z'].every(k=>typeof p[k]==='number' && Number.isFinite(p[k]) && Math.abs(p[k])<=1e9);
const short=(v,max)=>typeof v==='string' && v.length<=max;

// The capture dependency must execute one bounded Revit API callback and return
// its identity and value together; no accumulated pages are treated as atomic.
export function createModelViewerService({capture,readStatus,now=()=>new Date().toISOString()}={}) {
  if(typeof capture!=='function'||typeof readStatus!=='function')throw new TypeError('capture and readStatus are required');
  let snapshot=null, busy=false;
  async function refresh({limit=200}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>300)return fail('INVALID_LIMIT','limit must be an integer from 1 to 300.');
    if(busy)return fail('CAPTURE_BUSY','A snapshot capture is already running.');
    busy=true;
    try {
      let result;
      try { result=await capture({limit}); }
      catch(error) {
        const facts=workbenchFailureEvidence(error);
        const outcome=error?.interruptedBeforeEnqueue?'not_started':facts.outcome;
        const response={ok:false,error:{code:'CAPTURE_REQUEST_FAILED',message:outcome==='unconfirmed'?'Capture outcome is unknown; inspect the original receipt before retrying.':'Capture did not complete.',outcome},evidence:{requestIds:facts.requestIds,...facts.nativeFailure?{nativeFailure:facts.nativeFailure}:{},...facts.unpublishedRequest?{unpublishedRequest:facts.unpublishedRequest}:{}}};
        // Receipt ownership is retained for the HTTP/application owner without
        // attempting to serialize its internal handle to the browser.
        if(facts.receiptOwner)Object.defineProperty(response,'receiptOwner',{value:facts.receiptOwner,enumerable:false});
        return response;
      }
      const identity=workbenchDocumentIdentity(result), value=result.value;
      if(!value||value.schemaVersion!==1||!['axis_aligned_bounding_box','triangle_mesh_with_bounds'].includes(value.geometry)||value.units!=='mm'||value.coordinateSystem!=='revit_internal'||!Array.isArray(value.items)||value.items.length>limit)throw new Error('Invalid native snapshot.');
      const coverage=value.coverage;
      if(!coverage||!['examined','exported','missingBoundingBox','failed'].every(k=>Number.isSafeInteger(coverage[k])&&coverage[k]>=0)||coverage.examined>limit||coverage.exported!==value.items.length||coverage.examined!==coverage.exported+coverage.missingBoundingBox+coverage.failed+(coverage.omittedBudget??0)||typeof coverage.truncated!=='boolean'||coverage.enumerationComplete!==!coverage.truncated||coverage.order!=='revit_collector')throw new Error('Invalid coverage.');
      if(coverage.omittedBudget!==undefined&&(!Number.isSafeInteger(coverage.omittedBudget)||coverage.omittedBudget<0))throw new Error('Invalid budget omissions.');
      const meshSnapshot=value.geometry==='triangle_mesh_with_bounds';
      let triangleCount=0;const meshCounts={complete:0,missing:0,partial:0,failed:0};
      if(meshSnapshot&&(!['triangles','meshComplete','meshMissing','meshPartial','meshFailed'].every(k=>Number.isSafeInteger(coverage[k])&&coverage[k]>=0)||coverage.triangleLimit!==2400||coverage.elementTriangleLimit!==300||coverage.objectLimit!==5000||coverage.elapsedLimitMs!==2500))throw new Error('Invalid mesh coverage.');
      if(meshSnapshot&&coverage.serializationLimit!==undefined&&(coverage.serializationLimit!==250000||!Number.isSafeInteger(coverage.serializationReserved)||coverage.serializationReserved<0||coverage.serializationReserved>250000||!Number.isSafeInteger(coverage.meshBudgetLimited)||coverage.meshBudgetLimited<0||coverage.meshBudgetLimited>coverage.meshPartial))throw new Error('Invalid serialization budget.');
      const ids=new Set(),uids=new Set();
      for(const item of value.items) {
        if(!item||!short(item.element_id,19)||!/^[1-9]\d*$/.test(item.element_id)||BigInt(item.element_id)>9223372036854775807n||!short(item.unique_id,256)||!item.unique_id||!short(item.name??'',1000)||!(item.category===null||short(item.category,1000))||!point(item.min)||!point(item.max)||['x','y','z'].some(k=>item.min[k]>item.max[k])||ids.has(item.element_id)||uids.has(item.unique_id))throw new Error('Invalid element identity or bounds.');
        if(meshSnapshot){
          if(!Object.hasOwn(meshCounts,item.meshStatus)||!Array.isArray(item.mesh)||item.mesh.length%9!==0||item.mesh.length>2700||!item.mesh.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9)||item.meshStatus==='missing'&&item.mesh.length!==0||item.meshStatus==='complete'&&item.mesh.length===0)throw new Error('Invalid element mesh.');
          triangleCount+=item.mesh.length/9;meshCounts[item.meshStatus]++;
        }
        ids.add(item.element_id);uids.add(item.unique_id);
      }
      if(meshSnapshot&&(triangleCount>2400||coverage.triangles!==triangleCount||coverage.meshComplete!==meshCounts.complete||coverage.meshMissing!==meshCounts.missing||coverage.meshPartial!==meshCounts.partial||coverage.meshFailed!==meshCounts.failed))throw new Error('Invalid mesh coverage.');
      const payload=structuredClone({identity,value});
      if(Buffer.byteLength(JSON.stringify(payload),'utf8')>1024*1024)throw new Error('Snapshot exceeds byte budget.');
      const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      snapshot={snapshotId:digest,capturedAt:now(),...payload};
      return {ok:true,value:structuredClone(snapshot)};
    } catch(error) { return fail('CAPTURE_FAILED',error instanceof Error?error.message:'Capture failed.'); }
    finally { busy=false; }
  }
  async function status() {
    if(!snapshot)return {ok:true,value:{state:'empty'}};
    try {
      const identity=workbenchDocumentIdentity(await readStatus());
      // Matching document identity cannot establish that geometry has not changed.
      const state=sameWorkbenchDocumentIdentity(snapshot.identity,identity)?'freshness_unknown':'different_document';
      return {ok:true,value:{state,snapshotId:snapshot.snapshotId,capturedAt:snapshot.capturedAt,coverage:structuredClone(snapshot.value.coverage)}};
    } catch { return {ok:true,value:{state:'freshness_unknown',snapshotId:snapshot.snapshotId,capturedAt:snapshot.capturedAt,coverage:structuredClone(snapshot.value.coverage)}}; }
  }
  function get(snapshotId) {
    if(!snapshot||snapshotId!==snapshot.snapshotId)return fail('SNAPSHOT_NOT_FOUND','Snapshot is unavailable or has been replaced.');
    return {ok:true,value:structuredClone(snapshot)};
  }
  function locate(snapshotId,elementId) {
    const found=get(snapshotId);if(!found.ok)return found;
    const item=found.value.value.items.find(v=>v.element_id===elementId);
    return item?{ok:true,value:{snapshotId,identity:found.value.identity,item}}:fail('ELEMENT_NOT_IN_SNAPSHOT','Element was not captured in this snapshot.');
  }
  return Object.freeze({refresh,status,get,locate});
}
