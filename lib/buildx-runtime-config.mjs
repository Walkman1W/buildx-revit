import {createBuildxAuth} from './buildx-auth.mjs';

// Read only named application configuration. Never persist the inherited
// environment or inspect the host Codex login files.
export function buildxRuntimeConfig(env=process.env){
  const mode=env.BUILDX_MODE??'research';
  if(!['research','customer'].includes(mode))throw new Error('BUILDX_MODE 只接受 research 或 customer。');
  const licenseSetting=env.BUILDX_REQUIRE_LICENSE??(mode==='customer'?'true':'false');
  if(!['true','false'].includes(licenseSetting))throw new Error('BUILDX_REQUIRE_LICENSE 只接受 true 或 false。');
  if(mode==='customer'&&licenseSetting!=='true')throw new Error('客户模式必须启用软件许可核验。');
  const requireLicense=licenseSetting==='true';
  const url=env.BUILDX_SUPABASE_URL,key=env.BUILDX_SUPABASE_PUBLISHABLE_KEY;
  const hasUrl=url!==undefined,hasKey=key!==undefined;
  if(hasUrl!==hasKey)throw new Error('BuildX Supabase 配置不完整。');
  if(hasUrl&&(typeof url!=='string'||!url||typeof key!=='string'||!key))throw new Error('BuildX Supabase 配置不能为空。');
  if(requireLicense&&!hasUrl)throw new Error('启用许可核验必须先配置 BuildX 专用 Supabase 项目。');
  const accountAuth=hasUrl?createBuildxAuth({url,publishableKey:key}):null;
  if(mode==='customer'&&!accountAuth)throw new Error('客户模式必须先配置 BuildX 专用 Supabase 项目。');
  return Object.freeze({mode,accountAuth,requireAccount:Boolean(accountAuth)||mode==='customer',requireLicense});
}
