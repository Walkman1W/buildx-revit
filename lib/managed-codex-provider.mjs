import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {managedRelayLaunchInfo} from './managed-inference-relay.mjs';

const safe = (v,max=4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const inheritedEnvironment = new Set([
  'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','USERPROFILE',
  'HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA'
]);

export function createManagedCodexProvider({relay,model,codexHome} = {}) {
  const {baseUrl,localToken} = managedRelayLaunchInfo(relay);
  if (!safe(model,200) || !safe(codexHome) || !path.isAbsolute(codexHome)) throw new Error('Invalid managed provider');
  const providerId = 'buildx_managed_' + randomUUID().replaceAll('-','');
  const providerRevision = randomUUID();
  const envKey = 'BUILDX_LOCAL_' + randomUUID().replaceAll('-','');
  const facts = Object.freeze({type:'api_key',providerId,providerRevision,model});
  const provider = `model_providers.${providerId}`;
  const args = [
    '-c', `model_provider=${JSON.stringify(providerId)}`,
    '-c', `${provider}.name="BuildX Managed"`,
    '-c', `${provider}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `${provider}.env_key=${JSON.stringify(envKey)}`,
    '-c', `${provider}.wire_api="responses"`,
    '-c', `${provider}.requires_openai_auth=false`,
    '-c', `${provider}.supports_websockets=false`,
    // An interrupted stream may have already incurred upstream usage.
    '-c', `${provider}.request_max_retries=0`,
    '-c', `${provider}.stream_max_retries=0`,
    '-c', `model=${JSON.stringify(model)}`
  ];
  let secret = localToken, used = false;
  function start({spawn,executable,baseArgs,cwd,env} = {}) {
    if (used || typeof spawn !== 'function' || !safe(executable) || !path.isAbsolute(executable) || !safe(cwd) || !path.isAbsolute(cwd) || !Array.isArray(baseArgs) || baseArgs.some(x=>typeof x !== 'string' || x.includes('\0') || x.includes(secret)) || !env || typeof env !== 'object') throw new Error('Invalid managed launch');
    const childEnv = {};
    for (const [name, value] of Object.entries(env)) {
      if (!name || /[=\0]/.test(name) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid launch environment');
      if (inheritedEnvironment.has(name.toUpperCase())) childEnv[name] = value;
    }
    childEnv.CODEX_HOME = codexHome; childEnv[envKey] = secret; used = true; secret = null;
    return spawn(executable,[...baseArgs,...args],{cwd,env:childEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});
  }
  function dispose() { used = true; secret = null; }
  const describe = () => Object.freeze({identity:facts,baseUrl,wireApi:'responses',status:'unverified'});
  return Object.freeze({describe,start,dispose});
}
