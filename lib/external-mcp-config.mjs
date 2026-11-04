import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createExternalMcpOwner} from './external-mcp-owner.mjs';

// An ephemeral editor, not an execution or configuration-persistence owner.
// Only a trusted host may call prepare: it produces an unstarted owner whose
// ordinary per-launch and per-call approvals remain required.
const isDataObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const exact=(obj,keys)=>isDataObject(obj)&&Reflect.ownKeys(obj).length===keys.length&&keys.every(key=>Object.hasOwn(obj,key));
const clean=(value,max,empty=false)=>typeof value==='string'&&(empty||value.length>0)&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const bad=()=>{throw new TypeError('Invalid local MCP configuration');};
const copyView=entry=>({id:entry.id,revision:entry.revision,name:entry.name,command:entry.command,cwd:entry.cwd,args:entry.args.map(arg=>({value:arg.sensitive?'[REDACTED]':arg.value,sensitive:arg.sensitive}))});

function parse(input,previous){
  if(!exact(input,['name','command','cwd','args'])||!clean(input.name,128)||!clean(input.command,2048)||!path.isAbsolute(input.command)||
    process.platform==='win32'&&path.extname(input.command).toLowerCase()!=='.exe'||!clean(input.cwd,2048)||!path.isAbsolute(input.cwd)||
    !Array.isArray(input.args)||input.args.length>32||Reflect.ownKeys(input.args).length!==input.args.length+1||
    Array.from({length:input.args.length},(_,i)=>Object.getOwnPropertyDescriptor(input.args,String(i))).some(d=>!d||!Object.hasOwn(d,'value')))bad();
  const args=input.args.map(item=>{
    if(exact(item,['value','sensitive'])&&typeof item.sensitive==='boolean'&&clean(item.value,8192,true))return Object.freeze({value:item.value,sensitive:item.sensitive});
    if(exact(item,['preserveSensitiveAt'])&&Number.isSafeInteger(item.preserveSensitiveAt)&&item.preserveSensitiveAt>=0){
      const prior=previous?.args[item.preserveSensitiveAt];if(prior?.sensitive===true)return prior;
    }
    return bad();
  });
  if(Buffer.byteLength(JSON.stringify(args.map(arg=>arg.value)))>8192)bad();
  // An explicitly marked value must not escape through another display field
  // or another unmarked argument, including the later launch proposal.
  for(const arg of args)if(arg.sensitive&&arg.value&&[input.name,input.command,input.cwd,...args.filter(a=>!a.sensitive).map(a=>a.value)].some(v=>v.includes(arg.value)))bad();
  return {name:input.name,command:input.command,cwd:input.cwd,args:Object.freeze(args)};
}

/**
 * Store at most 32 selected local commands for the life of this one registry.
 * `ownerDependencies` is a trusted composition dependency, never request JSON.
 * This registry deliberately neither reads nor writes Codex settings, disk,
 * credentials, permissions, environment variables, processes, or MCP servers.
 */
export function createExternalMcpConfigRegistry({ownerDependencies}={}){
  if(!isDataObject(ownerDependencies)||Reflect.ownKeys(ownerDependencies).some(key=>!['approvalOwner','receiptOwner','executionGuard'].includes(key))||!Object.hasOwn(ownerDependencies,'approvalOwner')||!Object.hasOwn(ownerDependencies,'receiptOwner'))bad();
  const dependencies=Object.freeze({...ownerDependencies}),entries=new Map();let closed=false;
  const available=()=>{if(closed)throw new Error('Local MCP configuration registry is closed');};
  const existing=(id,revision)=>{if(typeof id!=='string'||!Number.isSafeInteger(revision)||revision<1)bad();const entry=entries.get(id);if(!entry||entry.revision!==revision)throw new Error('Local MCP configuration changed or is unavailable');return entry;};
  return Object.freeze({
    list(){available();return [...entries.values()].map(copyView);},
    add(input){available();if(entries.size>=32)throw new Error('Local MCP configuration limit');const parsed=parse(input,null);const entry={...parsed,id:randomUUID(),revision:1};entries.set(entry.id,entry);return copyView(entry);},
    replace({id,revision,configuration}={}){available();const old=existing(id,revision),parsed=parse(configuration,old),entry={...parsed,id,revision:old.revision+1};entries.set(id,entry);return copyView(entry);},
    remove({id,revision}={}){available();const entry=existing(id,revision);entries.delete(entry.id);return {removed:true};},
    prepare({id,revision}={}){
      available();const entry=existing(id,revision);
      // The owner copies arguments synchronously. No launch, disk access, or
      // user approval is performed by constructing it.
      const launchLease=Object.freeze({current:()=>!closed&&entries.get(entry.id)===entry});
      return createExternalMcpOwner({command:entry.command,cwd:entry.cwd,args:entry.args.map(arg=>arg.value),sensitiveArgumentIndexes:entry.args.flatMap((arg,index)=>arg.sensitive?[index]:[]),...dependencies,launchLease});
    },
    close(){closed=true;entries.clear();return {closed:true};}
  });
}
