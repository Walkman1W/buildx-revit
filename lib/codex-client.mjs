import {CodexClientCore} from './codex-client-core.mjs';
import {createCodexSessionProfile} from './codex-profile.mjs';
import {customerSkillCatalog} from './buildx-skills.mjs';
export {READ_TOOLS,ALL_PANEL_TOOLS} from './panel-tools.mjs';

// The product adapter owns the customer skill policy. The generic transport
// core receives a frozen callable and stays usable without product modules.
const CUSTOMER_SKILL_OWNER=Object.freeze({catalog:customerSkillCatalog});
function productDependencies(input){
  if(!input||typeof input!=='object')return input;
  const mode=Object.getOwnPropertyDescriptor(input,'skillCatalogMode');
  if(!mode||!Object.hasOwn(mode,'value')||mode.value!=='customer')return input;
  if(Object.hasOwn(input,'skillCatalogOwner'))throw new Error('客户技能目录由产品适配器提供。');
  const copy=Object.create(Object.getPrototypeOf(input));
  Object.defineProperties(copy,Object.getOwnPropertyDescriptors(input));
  Object.defineProperty(copy,'skillCatalogOwner',{value:CUSTOMER_SKILL_OWNER,enumerable:true});
  return copy;
}

// Research/model composition stays at this existing entry. The transport core
// neither imports tool catalogs nor chooses a profile or application prompt.
export class CodexClient extends CodexClientCore {
  constructor(root,options={},internalDependencies){
    super(root,createCodexSessionProfile(root,options),productDependencies(internalDependencies));
  }
}
