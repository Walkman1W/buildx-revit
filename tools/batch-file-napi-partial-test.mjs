import {createRequire} from 'node:module';import fs from 'node:fs';
const [addon,file]=process.argv.slice(2),bridge=createRequire(import.meta.url)(addon);
if(bridge.create(file,true)!==undefined)throw Error('partial creation returned a capability');
if(fs.readFileSync(file,'utf8')!=='identical controlled request')throw Error('controlled partial evidence missing');
if(bridge.create(file,false)!==undefined)throw Error('CREATE_NEW accepted an existing partial file');
console.log('PASS partial creation returns no handle and existing file is not reused');
