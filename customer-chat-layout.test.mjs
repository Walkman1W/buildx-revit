import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {customerChatLayout,createCustomerChatServer,customerChatConfiguration} from './lib/customer-chat.mjs';

const started=performance.now(),cpuStarted=process.cpuUsage();
const inheritedHomePresent=Object.hasOwn(process.env,'CODEX_HOME'),inheritedHome=process.env.CODEX_HOME;
delete process.env.CODEX_HOME;
test.after(()=>{if(inheritedHomePresent)process.env.CODEX_HOME=inheritedHome;else delete process.env.CODEX_HOME;const cpu=process.cpuUsage(cpuStarted);console.log('CUSTOMER_CHAT_LAYOUT_METRICS '+JSON.stringify({
  scope:'this test worker since metric initialization; pure contracts and unstarted application construction/cleanup only',
  pid:process.pid,node:process.version,wallMs:performance.now()-started,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,
  lifetimePeakRssKiB:process.resourceUsage().maxRSS,processFamilyPeakMemory:null,tokens:null,coldWarmControlled:false}));});

function auth(){
  return Object.fromEntries(['signIn','signUp','verifySession','refresh','signOut','release','close'].map(name=>[name,
    name==='close'?async()=>({ok:true,value:{closed:true}}):async()=>({ok:false,error:{code:'TEST_NOT_USED'}})]));
}
class FakeCodex extends EventEmitter{
  constructor(state={}){super();this.state={mode:'customer-chat',toolCount:0,ready:false,message:'test',...state};}
  async close(){return {closed:true};}
}
const valid={resourceRoot:'C:\\BuildX\\releases\\candidate',dataRoot:'D:\\BuildX Data'};
const root=path.resolve('.');

function withoutIo(action){
  const saved=[],attempts=[];
  const trap=(object,key,label)=>{saved.push([object,key,object[key]]);object[key]=()=>{attempts.push(label);throw new Error('Unexpected application I/O: '+label);};};
  try{
    for(const key of ['readFileSync','writeFileSync','statSync','existsSync','mkdirSync'])trap(fs,key,'fs.'+key);
    for(const key of ['readFile','writeFile','open','mkdir','stat','lstat','realpath','opendir'])trap(fsp,key,'fsp.'+key);
    for(const key of ['spawn','spawnSync'])trap(childProcess,key,'child_process.'+key);
    trap(http.Server.prototype,'listen','server.listen');syncBuiltinESMExports();
    const result=action();assert.deepEqual(attempts,[]);return result;
  }finally{for(const [object,key,original] of saved.reverse())object[key]=original;syncBuiltinESMExports();}
}

test('pure layout produces frozen role facts without observing paths or changing the environment',()=>{
  const beforeHome=process.env.CODEX_HOME;
  const result=withoutIo(()=>customerChatLayout({...valid,codexHome:'c:/Fixture/User/.codex'}));assert.equal(result.ok,true);
  const value=result.value;assert.equal(value.resourceRoot,valid.resourceRoot);assert.equal(value.dataRoot,valid.dataRoot);
  assert.equal(value.runtime,'D:\\BuildX Data\\runtime\\customer-chat');assert.equal(value.codexCwd,'D:\\BuildX Data\\workspace');
  assert.equal(value.codexHome.path,'C:\\Fixture\\User\\.codex');assert.equal(value.requested.codexHome,'c:/Fixture/User/.codex');
  assert.equal(value.separation,'lexical_only');assert.equal(value.observations.physicalIdentity,'not_checked');assert.equal(value.observations.writable,'not_checked');
  assert.equal(value.entryIntegrated,false);assert.equal(value.writeAuthorized,false);assert.equal(value.filesystemInspectionPerformed,false);
  for(const object of [value,value.requested,value.codexHome,value.observations,value.limitations])assert.equal(Object.isFrozen(object),true);
  const fallback=customerChatLayout(valid);assert.equal(fallback.ok,true);assert.equal(fallback.value.codexHome.selection,'existing_core_default_unobserved');assert.equal(fallback.value.codexHome.path,null);assert.equal(fallback.value.codexHome.credentialsRead,false);
  assert.equal(process.env.CODEX_HOME,beforeHome);
});

test('malformed, ambiguous and overlapping directory selections fail as tagged Results before observation',()=>{
  const invalid=withoutIo(()=>[
    ...['relative','C:relative','\\\\server\\share\\data','\\\\?\\C:\\data','C:\\','C:\\data:stream','C:\\data\\..\\other','C:\\data.','C:\\data\\CON.txt','C:\\data\\\\other'].map(dataRoot=>customerChatLayout({...valid,dataRoot})),
    customerChatLayout({...valid,dataRoot:'c:/BUILDX/releases/CANDIDATE'}),
    customerChatLayout({...valid,dataRoot:'C:\\BuildX'}),
    customerChatLayout({...valid,dataRoot:'C:\\BuildX\\releases\\candidate\\data'}),
    ...['','relative',null,undefined].map(codexHome=>customerChatLayout({...valid,codexHome})),
    customerChatLayout({...valid,writeAuthorized:true}),
  ]);
  for(const result of invalid){assert.equal(result.ok,false);assert.equal(result.error.code,'CUSTOMER_LAYOUT_INVALID');}
  let reads=0;const getter={...valid};Object.defineProperty(getter,'dataRoot',{enumerable:true,get(){reads++;return valid.dataRoot;}});
  assert.equal(customerChatLayout(getter).error.code,'CUSTOMER_LAYOUT_INVALID');assert.equal(reads,0);
  const proxy=new Proxy(valid,{getPrototypeOf(){throw new Error('private caller failure');}});
  const rejected=customerChatLayout(proxy);assert.equal(rejected.error.code,'CUSTOMER_LAYOUT_INVALID');assert.doesNotMatch(rejected.error.message,/private caller failure/);
  assert.equal(customerChatLayout({resourceRoot:'C:\\BuildX',dataRoot:'C:\\BuildXData'}).ok,true);
});

test('factory preserves the old default and still refuses scope or application overrides',async()=>{
  const provider=auth(),codex=new FakeCodex();let app;
  try{
    app=withoutIo(()=>createCustomerChatServer({root,accountAuth:provider,codex,port:0}));
    assert.equal(app.server.listening,false);assert.deepEqual(app.snapshot('layout').workspace,{kind:'customer-chat',supportsModelContext:false});
    for(const extra of [{selection:{}},{profile:'model'},{dataRoot:'D:\\Data'},{requireAccount:false}])assert.throws(()=>createCustomerChatServer({root,accountAuth:provider,codex,port:0,...extra}),/固定应用配置/);
    assert.throws(()=>createCustomerChatServer({root,accountAuth:provider,codex:new FakeCodex({toolCount:1}),port:0}),/own profile/);
    let reads=0;const input={root,accountAuth:provider,codex,port:0};Object.defineProperty(input,'codexCwd',{enumerable:true,get(){reads++;return 'D:\\Data\\workspace';}});
    assert.throws(()=>createCustomerChatServer(input),/固定应用配置/);assert.equal(reads,0);
    assert.throws(()=>createCustomerChatServer(new Proxy(input,{getPrototypeOf(){throw new Error('caller details');}})),error=>error.code==='CUSTOMER_APPLICATION_INVALID'&&!error.message.includes('caller details'));
  }finally{if(app)assert.deepEqual(await app.close(),{closed:true});else await provider.close();}
});

test('explicit factory cwd is lexical-only and must be distinct from the resource tree',async()=>{
  const provider=auth(),codex=new FakeCodex();let app;
  try{
    app=withoutIo(()=>createCustomerChatServer({root:valid.resourceRoot,codexCwd:'D:/BuildX Data/workspace',accountAuth:provider,codex,port:0}));
    assert.equal(app.server.listening,false);
    for(const codexCwd of ['relative','\\\\server\\share\\cwd',valid.resourceRoot,'C:\\BuildX','C:\\BuildX\\releases\\candidate\\workspace',undefined])
      assert.throws(()=>createCustomerChatServer({root:valid.resourceRoot,codexCwd,accountAuth:provider,codex,port:0}),error=>error.code==='CUSTOMER_LAYOUT_INVALID');
    assert.throws(()=>createCustomerChatServer({root:valid.resourceRoot,codexCwd:'D:\\Data\\workspace',codex,port:0}),/账号后端/);
  }finally{if(app)assert.deepEqual(await app.close(),{closed:true});else await provider.close();}
});

test('customer factory rejects relative or empty CODEX_HOME without rewriting it; Auth configuration retains its original scope',async()=>{
  const existed=Object.hasOwn(process.env,'CODEX_HOME'),original=process.env.CODEX_HOME,provider=auth(),codex=new FakeCodex();let app;
  try{
    for(const selected of ['relative-codex','','\\config','/config']){
      process.env.CODEX_HOME=selected;
      withoutIo(()=>assert.throws(()=>createCustomerChatServer({root,accountAuth:provider,codex,port:0}),error=>error.code==='CUSTOMER_CODEX_HOME_INVALID'));
      assert.equal(process.env.CODEX_HOME,selected);
    }
    const absolute='C:\\Fixture\\CodexHome';process.env.CODEX_HOME=absolute;
    app=withoutIo(()=>createCustomerChatServer({root,accountAuth:provider,codex,port:0}));assert.equal(process.env.CODEX_HOME,absolute);
    const configuration=withoutIo(()=>customerChatConfiguration({BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture_key_1234567890',BUILDX_DATA_ROOT:'ignored',CODEX_HOME:'ignored-relative'}));
    assert.equal(configuration.mode,'customer');assert.equal(configuration.requireAccount,true);assert.equal(configuration.requireLicense,false);assert.deepEqual(Object.keys(configuration).sort(),['accountAuth','mode','requireAccount','requireLicense']);
    assert.equal((await configuration.accountAuth.close()).value.closed,true);
    assert.throws(()=>customerChatConfiguration({}),/必须/);
  }finally{
    if(existed)process.env.CODEX_HOME=original;else delete process.env.CODEX_HOME;
    if(app)assert.deepEqual(await app.close(),{closed:true});else await provider.close();
  }
});
