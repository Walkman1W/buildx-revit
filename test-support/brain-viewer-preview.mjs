import {createModelWorkspaceFixture} from './model-workspace-preview.mjs';
import {createModelViewerService} from '../lib/model-viewer-service.mjs';
const document={title:'隔离样例',path:'D:\\isolated\\sample.rvt'},hostSession='f'.repeat(32);
const capture=async()=>({hostSession,document,value:{schemaVersion:1,geometry:'triangle_mesh_with_bounds',units:'mm',coordinateSystem:'revit_internal',items:[{element_id:'42',unique_id:'fixture-42',name:'隔离构件',category:'墙',min:{x:0,y:0,z:0},max:{x:2000,y:200,z:3000},meshStatus:'partial',mesh:[0,0,0,2000,0,0,0,0,3000]}],coverage:{examined:1,exported:1,missingBoundingBox:0,failed:0,truncated:false,enumerationComplete:true,order:'revit_collector',triangles:1,meshComplete:0,meshMissing:0,meshPartial:1,meshFailed:0,triangleLimit:2400,elementTriangleLimit:300,objectLimit:5000,elapsedLimitMs:2500}}});
const viewerService=createModelViewerService({capture,readStatus:async()=>({hostSession,document})});
const fixture=await createModelWorkspaceFixture({required:false,viewerService});
console.log(JSON.stringify({origin:fixture.origin,scope:'isolated synthetic model viewer; no Revit'}));
process.stdin.setEncoding('utf8');process.stdin.on('data',async data=>{if(data.trim()==='close'){await fixture.close();process.exit(0);}});
setTimeout(async()=>{await fixture.close();process.exit(0);},300000).unref();
