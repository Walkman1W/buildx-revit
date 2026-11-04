import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planCustomerInstall} from './lib/customer-install-plan.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
const usage='只接受 --plan --artifact <候选绝对路径> --target-root <Windows绝对路径> [--operation install|upgrade|rollback]；本入口不提供 --apply。';
const invalid=()=>({ok:false,error:{code:'INVALID_ARGUMENTS',message:usage}});
const names=new Map([['--artifact','artifact'],['--target-root','targetRoot'],['--operation','operation']]);
let input=null;
if(args[0]==='--plan'&&args.length>=5&&args.length%2===1){
  const options={root};let valid=true;
  for(let index=1;index<args.length;index+=2){
    const key=names.get(args[index]),value=args[index+1];
    if(!key||Object.hasOwn(options,key)||typeof value!=='string'||!value||value.startsWith('--')){valid=false;break;}
    options[key]=value;
  }
  if(valid&&Object.hasOwn(options,'artifact')&&Object.hasOwn(options,'targetRoot'))input=options;
}
const result=input?await planCustomerInstall(input):invalid();
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!result.ok)process.exitCode=1;
