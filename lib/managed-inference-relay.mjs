import http from 'node:http';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isDeepStrictEqual} from 'node:util';
import {MANAGED_WORKBENCH_DYNAMIC_TOOL} from './managed-workbench-reads.mjs';

const relayOwners = new WeakMap();
export function managedRelayLaunchInfo(relay) {
  const launch = relayOwners.get(relay);
  if (!launch) throw new Error('Invalid managed relay owner');
  return launch;
}
const MAX_BODY = 16 * 1024 * 1024;
const pilotTool=Object.freeze({
  type:'function',name:MANAGED_WORKBENCH_DYNAMIC_TOOL.name,
  description:MANAGED_WORKBENCH_DYNAMIC_TOOL.description,strict:false,
  parameters:MANAGED_WORKBENCH_DYNAMIC_TOOL.inputSchema
});

function projectPilotContext(request,workspace){
  if(!Array.isArray(request.input))return;
  const index=request.input.findIndex(item=>item?.role==='user');
  const item=request.input[index],part=item?.content?.[0];
  if(item?.type!=='message'||!Array.isArray(item.content)||item.content.length!==1||
    part?.type!=='input_text'||typeof part.text!=='string'||
    !request.input.slice(index+1).some(item=>item?.type==='message'&&item.role==='user'))return;
  const lines=part.text.split('\n');
  const filesystem='  <filesystem><workspace_roots><root>';
  const rootEnd='</root></workspace_roots>';
  if(lines.length!==7||lines[0]!=='<environment_context>'||lines[6]!=='</environment_context>'||
    lines[1]!==`  <cwd>${workspace}</cwd>`||!/^  <shell>[^<>]+<\/shell>$/.test(lines[2])||
    !/^  <current_date>\d{4}-\d{2}-\d{2}<\/current_date>$/.test(lines[3])||
    !/^  <timezone>[^<>]+<\/timezone>$/.test(lines[4])||
    !lines[5].startsWith(filesystem+workspace+rootEnd)||!lines[5].endsWith('</filesystem>'))return;
  const permission=lines[5].slice((filesystem+workspace+rootEnd).length,-'</filesystem>'.length);
  if(!/^<permission_profile\b[^>]*>[\s\S]*<\/permission_profile>$/.test(permission))return;
  const display='[BuildX managed workspace]';
  lines[1]=`  <cwd>${display}</cwd>`;
  lines[5]=filesystem+display+rootEnd+permission+'</filesystem>';
  part.text=lines.join('\n');
  // Codex appends the local catalog to the developer message that also
  // carries BuildX instructions. Keep all other parts of that message.
  const developer=request.input[index-1];
  if(developer?.type!=='message'||developer.role!=='developer'||!Array.isArray(developer.content))return;
  developer.content=developer.content.filter(part=>{
    const skillText=part?.text;
    return !(part?.type==='input_text'&&typeof skillText==='string'&&
      skillText.startsWith('<skills_instructions>\n## Skills\n')&&skillText.includes('\n### Skill roots\n')&&
      skillText.endsWith('\n</skills_instructions>'));
  });
  if(!developer.content.length)request.input.splice(index-1,1);
}

function pilotRequestBody(bytes,workspace){
  const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!request||!Array.isArray(request.tools)||request.tools.length<1||request.tools.length>2||
    request.tool_choice!==undefined&&!['auto','none'].includes(request.tool_choice))
    throw new Error('Unverified managed pilot tool selection');
  const approved=request.tools.filter(tool=>isDeepStrictEqual(tool,pilotTool));
  if(approved.length!==1||request.tools.some(tool=>tool!==approved[0]&&
    (tool?.type!=='function'||tool.name!=='request_user_input')))
    throw new Error('Unverified managed pilot tool catalog');
  // Only the approved definition crosses the gateway. Reserialize so the
  // upstream receives the same JSON structure the local policy inspected.
  projectPilotContext(request,workspace);
  const serialized=JSON.stringify({...request,tools:[pilotTool]});
  const privateRoot=path.dirname(workspace);
  const pathValues=process.platform==='win32'?[privateRoot,privateRoot.replaceAll('\\','/')]:[privateRoot];
  const comparable=process.platform==='win32'?serialized.toLowerCase():serialized;
  for(const value of pathValues){
    const escaped=JSON.stringify(process.platform==='win32'?value.toLowerCase():value).slice(1,-1);
    if(comparable.includes(escaped))throw new Error('Unverified managed pilot workspace context');
  }
  return Buffer.from(serialized);
}

// A single trusted callback provides both the grant and its turn association.
export async function createManagedInferenceRelay({getCloudAuthorization, origin = null, testOnly = null,workbenchPilot=false,pilotWorkspace} = {}) {
  if (typeof getCloudAuthorization !== 'function'||typeof workbenchPilot!=='boolean') throw new Error('Invalid relay owner');
  if(workbenchPilot&&(typeof pilotWorkspace!=='string'||!path.isAbsolute(pilotWorkspace)||
    path.dirname(pilotWorkspace)===path.parse(pilotWorkspace).root||
    pilotWorkspace!==path.normalize(pilotWorkspace)||/[\x00-\x1f<>]/.test(pilotWorkspace)))
    throw new Error('Invalid managed pilot workspace');
  let target, request = globalThis.fetch;
  if (testOnly !== null) {
    if (!testOnly || typeof testOnly.fetch !== 'function' || typeof testOnly.url !== 'string') throw new Error('Invalid test transport');
    const u = new URL(testOnly.url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/v1/responses' || u.search || u.hash || u.username || u.password) throw new Error('Test transport must be loopback');
    target = u.href; request = testOnly.fetch;
  } else if(origin!==null) {
    // The product composition selects the approved HTTPS origin. The panel,
    // Codex and request headers never supply the destination.
    const url = new URL(origin);
    if(typeof origin!=='string'||url.origin!==origin||url.protocol!=='https:'||url.port||url.username||url.password||
        !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname)) throw new Error('Invalid managed inference gateway');
    target = url.origin+'/v1/responses';
  }
  if (!target) throw Object.assign(new Error('Managed inference gateway is not configured'), {code:'MANAGED_GATEWAY_UNCONFIGURED'});
  const token = randomBytes(32).toString('base64url'), tokenBytes = Buffer.from(token);
  let closing;
  const controllers = new Set();
  const server = http.createServer(async (req,res) => {
    const fail = status => { if (!res.headersSent) { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end('{"error":"relay_request_failed"}'); } else res.destroy(); };
    const supplied = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    const candidate = Buffer.from(supplied || '');
    if (closing || req.socket.remoteAddress !== '127.0.0.1' || !supplied || candidate.length !== tokenBytes.length || !timingSafeEqual(candidate,tokenBytes)) { fail(401); return; }
    if (req.method !== 'POST' || req.url !== '/v1/responses' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { fail(404); return; }
    const controller = new AbortController(); controllers.add(controller);
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { fail(413); return; } chunks.push(chunk); }
      if (controller.signal.aborted || closing) return;
      let body=Buffer.concat(chunks);
      if(workbenchPilot){
        try{body=pilotRequestBody(body,pilotWorkspace);}catch{fail(400);return;}
        if(body.length>MAX_BODY){fail(413);return;}
      }
      const grant = await getCloudAuthorization({signal:controller.signal});
      if (!grant || typeof grant.token !== 'string' || !/^[A-Za-z0-9_.~+\/=-]{1,8192}$/.test(grant.token) ||
          typeof grant.turnId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(grant.turnId)) {
        fail(403);
        return;
      }
      if (controller.signal.aborted || closing) return;
      const headers = {'content-type':'application/json','accept':'text/event-stream, application/json',
        'authorization':`Bearer ${grant.token}`,'x-buildx-turn-id':grant.turnId};
      const upstream = await request(target, {method:'POST',headers,body,signal:controller.signal,redirect:'error'});
      if (controller.signal.aborted || closing) return;
      const contentType = upstream.headers.get('content-type');
      res.writeHead(upstream.status, {'content-type':contentType || 'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body),res,{signal:controller.signal}); else res.end();
    } catch { if (!controller.signal.aborted) fail(502); } finally { controllers.delete(controller); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  function close() {
    if (closing) return closing;
    relayOwners.delete(owner);
    closing = new Promise(resolve => server.close(resolve));
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    return closing;
  }
  const owner = Object.freeze({baseUrl,close});
  relayOwners.set(owner, Object.freeze({baseUrl,localToken:token}));
  return owner;
}
