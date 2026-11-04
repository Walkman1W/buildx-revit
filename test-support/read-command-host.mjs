// A controlled ExternalEvent peer for the production workbench queue. It owns
// only a caller-created test directory; it never attaches to an actual host.
import fs from 'node:fs/promises';
import path from 'node:path';
import {invokeReadonlyPanelCommand} from '../lib/workbench-client.mjs';
import {createModelWorkspaceFixture} from './model-workspace-preview.mjs';

const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
export async function createReadCommandFixture({directory,history=true,historyDirectory,historyOptions={},required=true,timeout=800,profile='model'}={}){
  if(!path.isAbsolute(directory))throw new Error('An absolute owned fixture directory is required');
  await fs.mkdir(directory,{recursive:true});
  const root=await fs.mkdtemp(path.join(directory,'command-host-')),queue=path.join(root,'queue');
  for(const name of ['inbox','processing','outbox'])await fs.mkdir(path.join(queue,name),{recursive:true});
  const session='a'.repeat(32);
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version:'0.6.1'}));
  let document={title:'命令样例',path:'D:\\isolated-samples\\commands.rvt',activeViewId:12,activeViewType:'FloorPlan',allowedSample:false,modified:false};
  const element=(id,name,category)=>({element_id:id,name,class_name:'FamilyInstance',category,category_id:-2000011,type_id:-1,level_id:2,family_name:null,is_type:false});
  const elements=[element(42,'墙-01','墙'),element(84,'管道-02','管道'),element(126,'设备-03','机械设备')];
  const requests=[],pending=[],errors=[];let stop=false,holdOperation=null,holdSkip=0,mode='normal',loop,fixture;
  const envelope=request=>{
    let doc=document?{...document}:null;
    if(mode==='document-changed'&&request.operation==='status'&&requests.filter(value=>value.operation==='status').length>1&&doc)doc.path='D:\\isolated-samples\\other.rvt';
    if(request.operation==='status')return {hostSession:session,hostVersion:'0.6.1',document:doc};
    const base={hostSession:session,operation:request.operation,document:doc?{title:doc.title,path:doc.path}:null};
    if(!doc||request.args.expected_document!==doc.path)throw new Error('Document identity changed; the query did not run.');
    if(request.operation==='get_selection'){
      const items=mode==='empty-selection'?[]:elements.slice(0,2);return {...base,value:{total:items.length,returned:items.length,truncated:false,items}};
    }
    if(request.operation==='list_levels')return {...base,value:{items:[{element_id:2,name:'一层',elevation_mm:0,project_elevation_mm:1200},{element_id:3,name:'二层',elevation_mm:3600,project_elevation_mm:4800}]}};
    if(request.operation==='search_elements'){
      const categories={OST_Walls:'墙',OST_PipeCurves:'管道',OST_MechanicalEquipment:'机械设备'};
      const all=elements.filter(item=>(!request.args.category||item.category===categories[request.args.category])&&item.name.toLocaleLowerCase().includes(request.args.name_contains.toLocaleLowerCase()));
      const {offset,limit}=request.args;return {...base,value:{total:all.length,offset,limit,has_more:offset+limit<all.length,items:all.slice(offset,offset+limit)}};
    }
    throw new Error('Forbidden fixture operation: '+request.operation);
  };
  async function complete(request){
    let response;
    try{
      if(mode==='host-error'&&request.operation!=='status')response={id:request.id,ok:false,error:{code:'ReadFailed',message:'只读查询未完成'},completedUtc:new Date().toISOString()};
      else if(['typed-expired','typed-not-started','typed-failed','malformed-failure'].includes(mode)&&request.operation!=='status'){
        const started=mode==='typed-failed';
        response={id:request.id,ok:false,hostSession:session,error:{code:mode==='typed-expired'?'WORKBENCH_REQUEST_EXPIRED':'ReadFailed',message:'受控宿主拒绝本次查询。'},execution:{started,phase:started?'dispatch':'validation',reason:mode==='typed-expired'?'expired':null},completedUtc:new Date().toISOString()};
        if(mode==='malformed-failure')response.execution.started=true;
      }
      else if(mode==='malformed'&&request.operation!=='status')response={id:request.id,ok:true,result:{...envelope(request),operation:'execute_csharp'}};
      else response={id:request.id,ok:true,result:envelope(request)};
    }catch(error){response={id:request.id,ok:false,error:{code:'DocumentChanged',message:error.message},completedUtc:new Date().toISOString()};}
    const target=path.join(queue,'outbox',request.id+'.json');await fs.writeFile(target+'.tmp',JSON.stringify(response));await fs.rename(target+'.tmp',target);
  }
  loop=(async()=>{
    while(!stop){
      for(const name of (await fs.readdir(path.join(queue,'inbox'))).filter(name=>name.endsWith('.json'))){
        const source=path.join(queue,'inbox',name),request=JSON.parse(await fs.readFile(source,'utf8'));
        await fs.rename(source,path.join(queue,'processing',name));requests.push(request);
        if(mode==='timeout'||holdOperation===request.operation&&holdSkip--<=0){pending.push(request);continue;}
        await complete(request);
      }
      await pause();
    }
  })().catch(error=>{errors.push(error);});
  try{
    fixture=await createModelWorkspaceFixture({profile,required,historyOptions,historyDirectory:history?(historyDirectory??path.join(root,'history')):undefined,
      invokeReadonlyCommand:(command,parameters,control={})=>invokeReadonlyPanelCommand(command,parameters,{...control,root,timeout})});
  }catch(error){stop=true;await loop;throw error;}
  let closed=false;
  return {...fixture,queueRoot:root,queueRequests:requests,queuePending:pending,queueErrors:errors,
    setMode(value){mode=value;},hold(operation,occurrence=1){holdOperation=operation;holdSkip=occurrence-1;},
    setNativeDocument(value){document=value===null?null:{...value};},
    async release(){holdOperation=null;for(const request of pending.splice(0))await complete(request);},
    async close(){if(closed)return;await fixture.close();stop=true;await loop;closed=true;if(errors.length)throw errors[0];}
  };
}
