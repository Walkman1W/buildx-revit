import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planCustomerAssets,buildCustomerAssets,verifyCustomerAssets} from './lib/customer-assets.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
let result;
if(args.length===0||args.length===1&&args[0]==='--plan')result=await planCustomerAssets({root});
else if(args.length===2&&['--build','--verify'].includes(args[0]))result=await (args[0]==='--build'?buildCustomerAssets:verifyCustomerAssets)({root,output:args[1]});
else result={ok:false,error:{code:'INVALID_ARGUMENTS',message:'只接受 --plan、--build <新产物绝对路径> 或 --verify <产物绝对路径>。不会安装、发布或控制服务。'}};
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!result.ok)process.exitCode=1;
