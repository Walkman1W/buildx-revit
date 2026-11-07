import fs from 'node:fs';import {createRequire} from 'node:module';import readline from 'node:readline';
const [first,second]=process.argv.slice(2),req=createRequire(import.meta.url);const original=req(first);
try{fs.renameSync(first,first+'.loaded');fs.copyFileSync(second,first,fs.constants.COPYFILE_EXCL);}catch(e){console.log('replace-blocked:'+e.code);process.exit(0);}
console.log('replaced');const reader=readline.createInterface({input:process.stdin});reader.once('line',()=>{const result=req(first);process.stdout.write((result===original&&typeof result.close==='function'&&typeof result.position!=='function'?'cached-original':'different')+'\n',()=>process.exit(0));reader.close();});
