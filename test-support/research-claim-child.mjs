import {claim} from '../lib/research-durable-claim.mjs';
import {appendFile} from 'node:fs/promises';
const [root,id,signal,mode]=process.argv.slice(2);
await claim(root,id,Buffer.from('immutable request'));
if(mode==='after_publish')await appendFile(signal,'published\n');
process.send('claimed');
setInterval(()=>{},1000);
