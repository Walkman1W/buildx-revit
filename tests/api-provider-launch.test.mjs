import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createApiProviderLaunch,validateApiProvider,ISOLATED_API_FIXTURE_KEY} from '../lib/api-provider-launch.mjs';

const config={baseUrl:'http://127.0.0.1:23119/v1',model:'example-model',apiKey:ISOLATED_API_FIXTURE_KEY,allowLoopbackHttp:true};
const fakeRuntime=Object.freeze({executable:process.execPath,cwd:process.cwd(),baseArgs:['app-server','--listen','stdio://','--strict-config']});
const envName=launch=>JSON.parse(launch.configOverrides.find(value=>value.startsWith(`model_providers.${launch.describe().identity.providerId}.env_key=`)).split('=')[1]);

test('separate API selections have random identities and no credential in public facts or arguments',()=>{
  const a=createApiProviderLaunch(config),b=createApiProviderLaunch(config);
  assert.deepEqual(a.describe().identity,{type:'api_key',providerId:a.describe().identity.providerId,providerRevision:a.describe().identity.providerRevision,model:'example-model'});
  assert.match(a.describe().identity.providerId,/^buildx_api_[a-f0-9]{32}$/);
  assert.notEqual(a.describe().identity.providerId,b.describe().identity.providerId);
  assert.notEqual(a.describe().identity.providerRevision,b.describe().identity.providerRevision);
  assert.equal(a.describe().status,'unverified');
  assert.equal(JSON.stringify(a.describe()).includes(config.apiKey),false);
  assert.equal(JSON.stringify(a.configOverrides).includes(config.apiKey),false);
  assert.ok(a.configOverrides.includes(`model_providers.${a.describe().identity.providerId}.wire_api="responses"`));
  assert.match(envName(a),/^BUILDX_API_[a-f0-9]{32}$/);
  assert.notEqual(envName(a),envName(b));
});

test('remote launch and non-fixture keys are rejected before a launcher exists',()=>{
  assert.throws(()=>createApiProviderLaunch({baseUrl:'https://provider.example/v1',model:'example-model',apiKey:config.apiKey}),{code:'API_REMOTE_DISABLED'});
  assert.throws(()=>createApiProviderLaunch({...config,baseUrl:'http://192.0.2.1:8080/v1'}));
  assert.throws(()=>createApiProviderLaunch({...config,apiKey:'not-the-public-fixture-marker'}),{code:'API_FIXTURE_KEY_REQUIRED'});
});

test('random provider IDs never merge a pre-existing fixed provider table',()=>{
  const launch=createApiProviderLaunch(config),providerId=launch.describe().identity.providerId;
  assert.notEqual(providerId,'buildx_api_provider');
  assert.equal(launch.configOverrides.some(value=>value.startsWith('model_providers.buildx_api_provider.')),false);
  assert.ok(launch.configOverrides.includes(`model_provider="${providerId}"`));
});

test('one trusted fake app-server spawn gets the synthetic key via child environment only',()=>{
  const launch=createApiProviderLaunch(config);let calls=0,observed;
  const spawn=(executable,args,options)=>{calls++;observed={executable,args,options};return {fixture:true};};
  const env={PATH:'test-bin','ProgramFiles(x86)':'test-windows-path',OPENAI_API_KEY:'discard-me',CODEX_API_KEY:'discard-me-too',BUILDX_PROVIDER_API_KEY:'old-value'};
  assert.deepEqual(launch.start({...fakeRuntime,spawn,env}),{fixture:true});
  assert.equal(calls,1);assert.equal(observed.options.env[envName(launch)],config.apiKey);
  assert.equal(Object.hasOwn(observed.options.env,'BUILDX_PROVIDER_API_KEY'),false);
  assert.equal(observed.options.env['ProgramFiles(x86)'],'test-windows-path');
  assert.equal(Object.hasOwn(observed.options.env,'OPENAI_API_KEY'),false);
  assert.equal(Object.hasOwn(observed.options.env,'CODEX_API_KEY'),false);
  assert.equal(env.OPENAI_API_KEY,'discard-me');
  assert.equal(JSON.stringify(observed.args).includes(config.apiKey),false);
  assert.throws(()=>launch.start({...fakeRuntime,spawn,env}));assert.equal(calls,1);
});

test('invalid endpoint, model or credential is rejected before spawn',()=>{
  for(const baseUrl of ['http://example.org/v1','https://user:password@example.org/v1','https://example.org/v1?key=secret','https://example.org/v1#fragment','file:///etc/passwd','https://example.org/v1?',' https://example.org'])
    assert.throws(()=>createApiProviderLaunch({...config,baseUrl}));
  for(const value of ['', ' model', 'name\nother'])assert.throws(()=>createApiProviderLaunch({...config,model:value}));
  for(const value of ['', ' key', 'key\nother'])assert.throws(()=>createApiProviderLaunch({...config,apiKey:value}));
  assert.throws(()=>createApiProviderLaunch({...config,baseUrl:`https://example.org/${config.apiKey}`}));
  assert.throws(()=>createApiProviderLaunch({...config,model:config.apiKey}));
  assert.throws(()=>validateApiProvider(Object.defineProperty({model:'m'},'baseUrl',{get(){throw new Error('must not invoke getter');},enumerable:true})),/API/);
  assert.deepEqual({...validateApiProvider({baseUrl:'http://127.0.0.1:12345/v1',model:'fixture',allowLoopbackHttp:true})},{baseUrl:'http://127.0.0.1:12345/v1',model:'fixture'});
});

test('dispose and spawn errors never permit credential replay',()=>{
  const a=createApiProviderLaunch(config);a.dispose();assert.throws(()=>a.start({...fakeRuntime,spawn(){throw new Error('should not run');},env:{}}));
  const c=createApiProviderLaunch(config);assert.throws(()=>c.start({...fakeRuntime,baseArgs:[config.apiKey],spawn(){throw new Error('should not run');},env:{}}),/API/);
  const b=createApiProviderLaunch(config);assert.throws(()=>b.start({...fakeRuntime,spawn(){throw new Error(config.apiKey);},env:{}}),/API 服务启动失败/);
  assert.throws(()=>b.start({...fakeRuntime,spawn(){throw new Error('should not run');},env:{}}),/API/);
});

test('a real isolated fixture process sees a synthetic key without the key appearing in arguments or output',async()=>{
  // This is a fake app-server, not Codex and not a model or network request.
  const program="const name=JSON.parse(process.argv.find(v=>v.includes('.env_key=')).split('=')[1]);process.stdout.write(JSON.stringify({hasKey:!!process.env[name],hasKeyInArgs:process.argv.some(v=>v.includes(process.env[name])),hasResponseArg:process.argv.some(v=>v.includes('wire_api'))}))";
  const env={};if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  const child=createApiProviderLaunch(config).start({spawn,executable:process.execPath,cwd:process.cwd(),baseArgs:['-e',program,'--'],env});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});
  const [code]=await once(child,'close');assert.equal(code,0);
  assert.deepEqual(JSON.parse(output),{hasKey:true,hasKeyInArgs:false,hasResponseArg:true});
  assert.equal(output.includes(config.apiKey),false);
});
