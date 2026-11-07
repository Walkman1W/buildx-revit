// Research-only provider contract. The caller must independently protect the pin;
// same-user writable files and environment variables do not constitute trust.
import {readFile} from 'node:fs/promises';
import {createHash, timingSafeEqual} from 'node:crypto';
export function fileAnchorProvider(file){return Object.freeze({read:()=>readFile(file)});}
export async function readPinnedAnchor(provider,pin){
 if(!provider||typeof provider.read!=='function'||typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw Error('anchor unavailable');
 const data=await provider.read();if(!Buffer.isBuffer(data)||data.length>1024)throw Error('anchor invalid');
 const digest=createHash('sha256').update(data).digest();if(!timingSafeEqual(digest,Buffer.from(pin,'hex')))throw Error('anchor changed');
 const identity=data.toString('utf8');if(!/^\d+:\d+:\d+$/.test(identity))throw Error('anchor invalid');return identity;
}
