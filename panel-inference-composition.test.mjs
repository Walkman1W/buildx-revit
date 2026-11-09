import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createPanelInferenceComposition} from './lib/panel-inference-composition.mjs';
import {buildxRuntimeConfig} from './lib/buildx-runtime-config.mjs';
import {MODEL_WORKSPACE_SESSION_PROFILE,MODEL_READONLY_SESSION_PROFILE} from './lib/codex-profile.mjs';
const root=process.cwd(),home=path.resolve('test-home'),deployment=Object.freeze({origin:'https://inference.example.test',model:'fixture-model'});
const account=Object.freeze({openInferenceTurn:async()=>({ok:false,error:{code:'AUTH_DENIED'}}),finishInferenceTurn:async()=>({ok:true,value:{closed:true}})});
test('self supplied Codex keeps original profile and no managed owner',()=>{
 const result=createPanelInferenceComposition({root,profile:MODEL_WORKSPACE_SESSION_PROFILE,runtimeDependencies:{}});
 assert.equal(result.codex.profile.id,MODEL_WORKSPACE_SESSION_PROFILE);assert.equal(result.managedInference,null);
});
test('managed composition fails closed until its exact Codex connection is ready',async()=>{
 const result=createPanelInferenceComposition({root,profile:MODEL_WORKSPACE_SESSION_PROFILE,runtimeDependencies:{},accountAuth:account,managedDeployment:deployment,codexHome:home});
 assert.equal(result.codex.profile.id,MODEL_WORKSPACE_SESSION_PROFILE);assert.equal(result.managedInference.isCurrent({account:{verified:true},connection:{}}),false);
 await assert.rejects(result.managedInference.beginTurn({account:{verified:true},connection:{},requestGrant:()=>null}));
 assert.deepEqual(await result.managedInference.close(),{closed:true});
});
test('managed mode rejects mutable config, unsupported profiles and substituted provider',()=>{
 const base={root,profile:MODEL_WORKSPACE_SESSION_PROFILE,runtimeDependencies:{},accountAuth:account,managedDeployment:deployment,codexHome:home};
 for(const change of [{managedDeployment:{...deployment}},{profile:MODEL_READONLY_SESSION_PROFILE},{runtimeDependencies:{apiProviderFactory:{}}},{accountAuth:{...account}}]) assert.throws(()=>createPanelInferenceComposition({...base,...change}));
});

test('runtime mode defaults to local Codex and cannot select an unapproved cloud from the environment',()=>{
  const local=buildxRuntimeConfig({});
  assert.equal(local.inferenceMode,undefined);
  assert.equal(local.managedDeployment,undefined);
  const env={BUILDX_MODE:'customer',BUILDX_INFERENCE_MODE:'buildx-managed',
    BUILDX_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',
    BUILDX_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    BUILDX_MANAGED_INFERENCE_ORIGIN:'https://untrusted.example.test'};
  assert.throws(()=>buildxRuntimeConfig(env),/尚未核准/);
  assert.throws(()=>buildxRuntimeConfig({...env,BUILDX_INFERENCE_MODE:'unknown'}),/模式无效/);
  assert.throws(()=>buildxRuntimeConfig({...env,BUILDX_MODE:'research'},deployment),/需要客户账号模式/);
  for(const origin of ['http://inference.example.test','https://inference.example.test/custom','https://127.0.0.1']){
    assert.throws(()=>buildxRuntimeConfig(env,Object.freeze({...deployment,origin})),/配置无效/);
  }
  const managed=buildxRuntimeConfig(env,deployment);
  assert.equal(managed.inferenceMode,'buildx-managed');
  assert.equal(managed.managedDeployment.origin,deployment.origin);
  assert.equal(managed.requireAccount,true);
  assert.equal(typeof managed.accountAuth.openInferenceTurn,'function');
  managed.accountAuth.close();
});
