import {CodexClient} from './lib/codex-client.mjs';
const client=new CodexClient(new URL('.',import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''));
client.on('diagnostic',data=>{if(data.code==='revit_tool_catalog'||data.code==='revit_tools_verified')console.log(JSON.stringify(data));});
let stderr=''; let exitCode=null;
const task=client.start();
client.child?.stderr.on('data',b=>{if(stderr.length<16000)stderr+=String(b).slice(0,16000-stderr.length);});
client.child?.on('exit',code=>{exitCode=code;});
try{await task;console.log(JSON.stringify({ready:client.state.ready}));}
catch(error){console.log(JSON.stringify({ready:false,error:error.message,exitCode,rpcCode:error.rpcCode||null,stderrBytes:Buffer.byteLength(stderr),recognized:['unexpected argument','invalid value','unknown variant','unknown field','config','stdio','listen','permission','sandbox','thread','panic','app-server'].filter(x=>stderr.toLowerCase().includes(x))}));
 const lines=stderr.split(/\r?\n/).filter(x=>/unexpected argument|invalid value|unknown variant|unknown field|error loading|error parsing/i.test(x));
 console.log(JSON.stringify({configurationDiagnostics:lines.map(x=>x.replace(/(token|secret|api.?key|password)\s*[:=]\s*\S+/ig,'$1=[redacted]').slice(0,250))}));}
finally{client.close();}
