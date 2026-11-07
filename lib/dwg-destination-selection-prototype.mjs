import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Unregistered prototype. It proves only that this process received a result
// from its injected picker and directory inspector. It is NOT user approval,
// a Revit staging owner, or authority to publish a file.
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const identity=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\u0000-\u001f\u007f]/u.test(x);
const local=x=>typeof x==='string'&&x.length<30000&&/^[a-zA-Z]:\\/.test(x)&&!x.includes('/')&&x.indexOf(':',2)<0&&path.win32.normalize(x).toLowerCase()===x.toLowerCase();
export function createDwgDestinationSelectionPrototype({picker,inspectDirectory,now=Date.now}={}){
 if(!picker||typeof picker.pick!=='function'||typeof inspectDirectory!=='function'||typeof now!=='function')throw new TypeError('Trusted picker and directory inspector are required');
 const records=new WeakMap();
 const instant=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER-120000)throw new Error('Destination selection clock is invalid');return value;};
 function entry(token,requestId){const record=records.get(token);if(!record||record.used||record.requestId!==requestId||record.expires<=instant())throw new Error('Destination selection is unavailable or expired');return record;}
 return Object.freeze({
  async choose(input){
   if(!exact(input,['request_id'])||!uuid(input.request_id))throw new Error('Only an original request ID is accepted');
   const picked=await picker.pick({kind:'directory'});if(!picked?.ok||!plain(picked.value)||!local(picked.value.path))throw new Error('A local directory must be selected by the picker');
   const facts=await inspectDirectory(picked.value.path);if(!plain(facts)||!identity(facts.identity))throw new Error('Selected directory identity is unavailable');
   const token=Object.freeze(Object.create(null));records.set(token,{requestId:input.request_id,path:picked.value.path,identity:facts.identity,selectionId:randomUUID(),expires:instant()+120000,used:false});return token;
  },
  review(token,input){if(!exact(input,['request_id']))throw new Error('Original request is required');const r=entry(token,input.request_id);return Object.freeze({request_id:r.requestId,selection_id:r.selectionId,destination_path:r.path,destination_directory_identity:r.identity,expires:r.expires,status:'selection_only_not_approval'});},
  async consumeForBinding(token,input){
   if(!exact(input,['request_id']))throw new Error('Original request is required');const r=entry(token,input.request_id);r.used=true;
   const observed=await inspectDirectory(r.path);if(!plain(observed)||observed.identity!==r.identity||r.expires<=instant())throw new Error('Selected directory identity changed or expired');
   return Object.freeze({request_id:r.requestId,selection_id:r.selectionId,destination_path:r.path,destination_directory_identity:r.identity,status:'selection_only_not_approval'});
  }
 });
}
