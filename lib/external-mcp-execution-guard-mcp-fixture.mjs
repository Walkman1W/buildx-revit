// Test-only stdio fixture. The script and its dependencies are not locked by
// the guard; the test must never treat them as verified inputs.
import {appendFile} from 'node:fs/promises';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';

const marker=process.argv[2];
const server=new McpServer({name:'guard-isolated-fixture',version:'1.0.0'});
server.registerTool('inspect',{inputSchema:z.object({}).strict()},async()=>({content:[{type:'text',text:JSON.stringify({pid:process.pid,bootstrap:Object.hasOwn(process.env,'BUILDX_MCP_GUARD_BOOTSTRAP')})}]}));
server.registerTool('large',{inputSchema:z.object({value:z.string().max(150000)}).strict()},async({value})=>({content:[{type:'text',text:value}]}));
server.registerTool('record',{inputSchema:z.object({value:z.string().max(40)}).strict()},async({value})=>{
  await appendFile(marker,JSON.stringify({value})+'\n');
  await new Promise(resolve=>setTimeout(resolve,1200));
  return {content:[{type:'text',text:'recorded'}]};
});
serveStdio(()=>server);
