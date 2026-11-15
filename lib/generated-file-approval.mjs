import {createHash,randomUUID} from 'node:crypto';
import {PUMP_FILE_PARAMETER_SCHEMA,readPumpFileParameters} from './generated-file-owner.mjs';
import {generatedFileFailureView} from './generated-file-diagnostic.mjs';

export const GENERATED_FILE_TOOL=Object.freeze({type:'function',name:'buildx_generate_file',
  description:'Propose producing one local file through a BuildX confirmation card. Currently supports an independent Revit 2024 horizontal end-suction pump RFA. Collect the required dimensions, connector sizes and piping system from the user or selected files. The user approves the displayed file and destination once. Do not report success before the file receipt. Never retry an unknown result.',
  inputSchema:Object.freeze({type:'object',properties:Object.freeze({format:Object.freeze({type:'string',enum:Object.freeze(['rfa'])}),parameters:PUMP_FILE_PARAMETER_SCHEMA}),required:Object.freeze(['format','parameters']),additionalProperties:false})});

const systems=Object.freeze({hydronic_supply:'水系统供水',hydronic_return:'水系统回水',domestic_cold_water:'生活冷水'});
const error=(code,message)=>Object.assign(new Error(message),{fileApprovalCode:code});
const reply=(data)=>({success:data.ok===true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]});

export function createGeneratedFileApproval({owner,transport}){
  const entries=new Map();
  const outputs=new Set();
  let closing=false;
  return Object.freeze({
    propose({params,scope,isCurrent}){
      if(params.tool!==GENERATED_FILE_TOOL.name||closing||!isCurrent())throw error('FILE_ACTION_UNAVAILABLE','当前对话无法发起文件生成。');
      const args=params.arguments;
      if(!args||Object.keys(args).length!==2||args.format!=='rfa'||!Object.hasOwn(args,'parameters'))throw error('FILE_FORMAT_UNSUPPORTED','当前可生成机械设备水泵族 RFA，请使用该格式和参数。');
      let parameters;
      try{parameters=readPumpFileParameters(args.parameters);}catch{throw error('PUMP_SPEC_INVALID','请核实文件名、外形尺寸、进出口径及系统类型。尺寸单位为 mm。');}
      const host=transport.inspectHost();
      if(!host)throw error('PUMP_HOST_UNAVAILABLE','当前 Revit 宿主未连接或不支持水泵族，请打开已更新的 Revit 2024 BuildX 面板。');
      if(entries.size>=16||outputs.size)throw error('FILE_ACTION_BUSY','请等当前文件制作完成。');
      const ticket=randomUUID(),deadline=Date.now()+90000;
      const ownedScope=Object.freeze({conversationId:scope.conversationId,accountId:scope.account?.userId??null});
      const digest=createHash('sha256').update(JSON.stringify({ticket,ownedScope,host,parameters,deadline})).digest('hex');
      entries.set(ticket,{ownedScope,host,parameters,deadline,digest,isCurrent});
      return Object.freeze({ticket,digest,deadline,kind:'file',action:GENERATED_FILE_TOOL.name,
        target:parameters.file_name+'-'+ticket.replaceAll('-','')+'.rfa',cwd:owner.outputDirectory,
        source:'本机 Revit 2024 · 制作、保存并重开校验 · 独立族文件',
        parameters:`卧式端吸泵\n宽 × 深 × 高：${parameters.width_mm} × ${parameters.depth_mm} × ${parameters.height_mm} mm\n进水口：${parameters.inlet_diameter_mm} mm · 出水口：${parameters.outlet_diameter_mm} mm\n系统：${systems[parameters.system]}`});
    },
    async decide({ticket,digest,decision}){
      const entry=entries.get(ticket);
      if(!entry||entry.digest!==digest||closing||entry.deadline<=Date.now()||!entry.isCurrent()||!['accept','decline'].includes(decision))return reply({ok:false,status:'not_started',message:'生成文件授权已失效。'});
      entries.delete(ticket);
      if(decision==='decline')return reply({ok:false,status:'declined',message:'用户取消了文件生成。'});
      if(outputs.size)return reply({ok:false,status:'not_started',message:'请等当前文件制作完成。'});
      const shouldContinue=()=>!closing&&entry.isCurrent();
      const work=owner.execute({scope:entry.ownedScope,requestId:ticket,parameters:entry.parameters,shouldContinue,
        invoke:job=>transport.invoke({...job,host:entry.host})});
      outputs.add(work);
      try{
        const result=await work;
        const status=result.status;
        return reply({ok:status==='completed',status,artifactId:result.artifactId??ticket,
          ...(status==='completed'?{fileName:result.artifact.fileName,bytes:result.artifact.bytes,reopened:true}:{code:result.code??null,...generatedFileFailureView(result)})});
      }finally{outputs.delete(work);}
    },
    cancel({ticket}){return entries.delete(ticket);},
    async close(){closing=true;entries.clear();await Promise.allSettled([...outputs]);return {closed:true};},
  });
}
