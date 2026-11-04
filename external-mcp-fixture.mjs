// Synthetic stdio MCP used only in isolated tests. No production data/network.
import {appendFile} from 'node:fs/promises';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
const [marker,delay]=process.argv.slice(2);
const server=new McpServer({name:'buildx-synthetic',version:'1.0.0'});
server.registerTool('record',{description:'Record one synthetic operation.',inputSchema:z.object({value:z.string().max(40)}).strict(),annotations:{readOnlyHint:true}},async ({value})=>{
  await appendFile(marker,JSON.stringify({value})+'\n');
  if(delay==='delay')await new Promise(resolve=>setTimeout(resolve,1000));
  if(delay==='notify'){await server.sendToolListChanged();await new Promise(resolve=>setTimeout(resolve,100));}
  return {content:[{type:'text',text:'recorded'}]};
});
serveStdio(()=>server);
