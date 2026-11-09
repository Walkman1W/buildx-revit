import {createBuildxAuth} from './buildx-auth.mjs';

// Set only after the BuildX gateway, model and client data boundary pass the
// release checks. Environment configuration can select a mode, not a host.
const APPROVED_MANAGED_INFERENCE_DEPLOYMENT = null;

function selectManagedDeployment(input){
  if(!input||!Object.isFrozen(input)||Reflect.ownKeys(input).length!==2||
    typeof Object.getOwnPropertyDescriptor(input,'origin')?.value!=='string'||
    typeof Object.getOwnPropertyDescriptor(input,'model')?.value!=='string')throw new Error('BuildX 托管推理部署尚未核准。');
  const {origin,model}=input;
  let url;try{url=new URL(origin);}catch{throw new Error('BuildX 托管推理地址无效。');}
  if(url.protocol!=='https:'||url.origin!==origin||url.port||url.username||url.password||
    !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(model))
    throw new Error('BuildX 托管推理部署配置无效。');
  return input;
}

// Read only named application configuration. Never persist the inherited
// environment or inspect the host Codex login files.
export function buildxRuntimeConfig(env=process.env,approvedManagedDeployment=APPROVED_MANAGED_INFERENCE_DEPLOYMENT){
  const mode=env.BUILDX_MODE??'research';
  if(!['research','customer'].includes(mode))throw new Error('BUILDX_MODE 只接受 research 或 customer。');
  const licenseSetting=env.BUILDX_REQUIRE_LICENSE??(mode==='customer'?'true':'false');
  if(!['true','false'].includes(licenseSetting))throw new Error('BUILDX_REQUIRE_LICENSE 只接受 true 或 false。');
  if(mode==='customer'&&licenseSetting!=='true')throw new Error('客户模式必须启用软件许可核验。');
  const requireLicense=licenseSetting==='true';
  const inferenceMode=env.BUILDX_INFERENCE_MODE??'local-codex';
  if(!['local-codex','buildx-managed'].includes(inferenceMode))throw new Error('BuildX 推理模式无效。');
  const managedDeployment=inferenceMode==='buildx-managed'?selectManagedDeployment(approvedManagedDeployment):null;
  if(managedDeployment&&mode!=='customer')throw new Error('BuildX 托管推理需要客户账号模式。');
  const url=env.BUILDX_SUPABASE_URL,key=env.BUILDX_SUPABASE_PUBLISHABLE_KEY;
  const hasUrl=url!==undefined,hasKey=key!==undefined;
  if(hasUrl!==hasKey)throw new Error('BuildX Supabase 配置不完整。');
  if(hasUrl&&(typeof url!=='string'||!url||typeof key!=='string'||!key))throw new Error('BuildX Supabase 配置不能为空。');
  if(requireLicense&&!hasUrl)throw new Error('启用许可核验必须先配置 BuildX 专用 Supabase 项目。');
  const accountAuth=hasUrl?createBuildxAuth({url,publishableKey:key,...managedDeployment?{inferenceGrantOrigin:managedDeployment.origin}:{}}):null;
  if(mode==='customer'&&!accountAuth)throw new Error('客户模式必须先配置 BuildX 专用 Supabase 项目。');
  return Object.freeze({mode,accountAuth,requireAccount:Boolean(accountAuth)||mode==='customer',requireLicense,
    ...(managedDeployment?{inferenceMode,managedDeployment}:{})});
}
