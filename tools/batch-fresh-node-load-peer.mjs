import fs from 'node:fs';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import readline from 'node:readline';
const [image]=process.argv.slice(2),req=createRequire(import.meta.url),resolved=req.resolve(image);
const cachedBefore=Object.hasOwn(req.cache,resolved),digest=createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
const addon=req(resolved);console.log(JSON.stringify({cachedBefore,digest,hasClose:typeof addon.close==='function',resolved}));
const input=readline.createInterface({input:process.stdin});input.once('line',()=>process.exit(0));
