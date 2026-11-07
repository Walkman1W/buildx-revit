// Unregistered test adapter: the injected invoker must execute a trusted native
// helper. A captured root is an identity snapshot, not an authorization.
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function createDwgNativeStoragePrototype({invoke,root}={}){
 if(typeof invoke!=='function'||!plain(root)||typeof root.directory!=='string'||!Array.isArray(root.chain)||root.chain.length<1)throw new TypeError('Native root and invoker are required');
 const saved=structuredClone(root);
 async function call(input){const r=await invoke(input);if(!plain(r)||r.ok!==true||!plain(r.value))throw new Error('Native journal storage failed or is unconfirmed');return r.value;}
 return Object.freeze({
  async append({request_id,revision,previous,bytes}){if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>262144)throw new Error('Invalid journal bytes');return call({operation:'append',root:saved,request_id,revision,previous,bytes_base64:bytes.toString('base64')});},
  async read({request_id,revision}){const value=await call({operation:'read',root:saved,request_id,revision});if(typeof value.bytes_base64!=='string'||!plain(value.receipt))throw new Error('Invalid native journal read');return {receipt:value.receipt,bytes:Buffer.from(value.bytes_base64,'base64')};}
 });
}
