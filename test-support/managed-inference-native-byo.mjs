import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readlink,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {CodexClientCore} from '../lib/codex-client-core.mjs';

const backendCredentials=new WeakMap();
const maxBodyBytes=16*1024*1024;
const fixturePaths=new Set(['/backend-api/wham/accounts/check','/backend-api/wham/config/bundle',
  '/backend-api/codex/models','/backend-api/codex/responses']);

function encode(value){return Buffer.from(JSON.stringify(value)).toString('base64url');}

export function createNativeByoBackend({streamForTurn}={}){
  assert.equal(typeof streamForTurn,'function');
  const accountId=randomUUID(),accountEmail='fixture-native-byo@example.invalid';
  const now=Math.floor(Date.now()/1000);
  // Unsigned test claims with an invalid signature. No real auth is loaded.
  const token=`${encode({alg:'none',typ:'JWT'})}.${encode({email:accountEmail,iat:now,exp:now+3600,
    'https://api.openai.com/profile':{email:accountEmail},
    'https://api.openai.com/auth':{chatgpt_account_id:accountId,chatgpt_plan_type:'free',chatgpt_user_id:'fixture-native-byo-user'}
  })}.${Buffer.from('fixture-invalid-signature').toString('base64url')}`;
  const authFile={auth_mode:'chatgpt',OPENAI_API_KEY:null,
    tokens:{id_token:token,access_token:token,refresh_token:'fixture-unusable-refresh',account_id:accountId},
    last_refresh:new Date().toISOString()};
  const requests=[],routes=[];
  let accountChecks=0;
  const json=(res,status,value)=>{
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(value));
  };
  const accountMatches=req=>req.headers.authorization==='Bearer '+token&&req.headers['chatgpt-account-id']===accountId;
  async function serve(req,res,pathname){
    if(req.socket.remoteAddress!=='127.0.0.1'){json(res,403,{error:'fixture_loopback_required'});return;}
    if(req.method==='GET'&&pathname==='/backend-api/wham/accounts/check'){
      if(!accountMatches(req)){json(res,401,{error:'fixture_account_mismatch'});return;}
      accountChecks++;
      json(res,200,{accounts:[{id:accountId,workspace_backend_origin:'https://chatgpt.com',
        account_routing_override:'NO_CONSTRAINT'}]});
      return;
    }
    if(req.method==='GET'&&pathname==='/backend-api/wham/config/bundle'){json(res,200,{});return;}
    if(req.method==='GET'&&pathname==='/backend-api/codex/models'){json(res,200,{models:[]});return;}
    if(req.method!=='POST'||pathname!=='/backend-api/codex/responses'){
      json(res,404,{error:'fixture_route_not_found'});return;
    }
    if(!accountMatches(req)||req.headers['x-buildx-turn-id']!==undefined){
      json(res,401,{error:'fixture_account_mismatch'});return;
    }
    let bytes=0;
    const chunks=[];
    for await(const chunk of req){
      bytes+=chunk.length;
      if(bytes>maxBodyBytes){json(res,413,{error:'fixture_request_too_large'});return;}
      chunks.push(chunk);
    }
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!body||typeof body!=='object'||Array.isArray(body)){json(res,400,{error:'fixture_body_invalid'});return;}
    requests.push(body);
    const stream=await streamForTurn(requests.length);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
    await pipeline(Readable.fromWeb(stream),res);
  }
  const backend=Object.freeze({
    requests,routes,accountEmail,get accountChecks(){return accountChecks;},
    handle(req,res){
      if(!req.url?.startsWith('/backend-api/'))return false;
      const pathname=req.url.split('?',1)[0];
      res.once('finish',()=>routes.push({path:fixturePaths.has(pathname)?pathname:'other_backend_api',status:res.statusCode}));
      void serve(req,res,pathname).catch(()=>{
        if(!res.headersSent&&!res.destroyed)json(res,500,{error:'fixture_backend_failed'});
        else if(!res.destroyed)res.destroy();
      });
      return true;
    }
  });
  backendCredentials.set(backend,authFile);
  return backend;
}

export async function createNativeByoClients({dir,root,trustedProfile,codexExecutable,base,backend,model}){
  const authFile=backendCredentials.get(backend);
  assert.ok(authFile,'use the isolated BYO backend');
  assert.equal(process.platform,'linux');
  assert.match(process.env.BUILDX_PARENT_NET??'',/^net:\[\d+\]$/);
  assert.notEqual(await readlink('/proc/self/ns/net'),process.env.BUILDX_PARENT_NET);
  const endpoint=new URL(base);
  assert.equal(endpoint.origin,base);
  assert.equal(endpoint.protocol,'http:');
  assert.equal(endpoint.hostname,'127.0.0.1');
  assert.ok(endpoint.port&&path.isAbsolute(codexExecutable));
  assert.equal(typeof model,'string');
  const owner=await realpath(dir),stage=await realpath(root),relative=path.relative(owner,stage);
  assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));
  assert.equal(trustedProfile.groups[0].entry,path.join(stage,'workbench-mcp.mjs'));
  const children=new WeakMap();

  async function create(label){
    const privateRoot=await mkdtemp(path.join(owner,'native-byo-'+label+'-'));
    const home=path.join(privateRoot,'home'),codexHome=path.join(privateRoot,'codex-home');
    const workspace=path.join(privateRoot,'workspace');
    await Promise.all([home,codexHome,workspace].map(directory=>mkdir(directory,{mode:0o700})));
    await writeFile(path.join(codexHome,'auth.json'),JSON.stringify(authFile),{mode:0o600,flag:'wx'});
    const launchConfig=['-c','cli_auth_credentials_store="file"',
      '-c',`chatgpt_base_url=${JSON.stringify(base+'/backend-api')}`,
      '-c','model_provider="fixture_byo"',
      '-c','model_providers.fixture_byo.name="BuildX BYO test backend"',
      '-c',`model_providers.fixture_byo.base_url=${JSON.stringify(base+'/backend-api/codex')}`,
      '-c','model_providers.fixture_byo.wire_api="responses"',
      '-c','model_providers.fixture_byo.requires_openai_auth=true',
      '-c','model_providers.fixture_byo.supports_websockets=false',
      '-c','model_providers.fixture_byo.request_max_retries=0',
      '-c','model_providers.fixture_byo.stream_max_retries=0',
      '-c',`model=${JSON.stringify(model)}`];
    const client=new CodexClientCore(workspace,trustedProfile,{
      resolveRuntimes:()=>({codex:codexExecutable,python:'unused'}),
      readConfiguredNames:()=>[],
      closeTimeoutMs:2500,killTimeoutMs:1000,
      spawn(cmd,args,options){
        const child=spawn(cmd,[...args,...launchConfig],{...options,
          env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,CODEX_HOME:codexHome,TMPDIR:privateRoot}});
        const observed={exited:false};
        children.set(client,observed);
        child.once('close',()=>{observed.exited=true;});
        return child;
      }
    });
    return client;
  }
  const original=await create('before'),returned=await create('after');
  return {original,returned,exited:client=>children.get(client)?.exited===true};
}
