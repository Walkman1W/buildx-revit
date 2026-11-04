import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planCustomerChatPackage,buildCustomerChatPackage,verifyCustomerChatPackage,verifyKnownCustomerChatRelease} from './lib/customer-chat-package.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
let result;
if(args.length===0||args.length===1&&args[0]==='--plan')result=await planCustomerChatPackage({root});
else if(args.length===2&&['--build','--verify'].includes(args[0]))result=await (args[0]==='--build'?buildCustomerChatPackage:verifyCustomerChatPackage)({root,output:args[1]});
else if(args.length===3&&args[0]==='--verify-known')result=await verifyKnownCustomerChatRelease({root,releaseId:args[1],output:args[2]});
else result={ok:false,error:{code:'INVALID_ARGUMENTS',message:'只接受 --plan、--build <新组件绝对路径>、--verify <组件绝对路径> 或 --verify-known <登记的BUILD SHA> <组件绝对路径>。不会安装、启动、发布或控制服务。'}};
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!result.ok)process.exitCode=1;
