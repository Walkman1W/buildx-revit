import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelToolDispatcher} from './lib/model-tool-dispatch.mjs';
const identity={hostSession:'f'.repeat(32),document:{title:'sample',path:'D:\\sample.rvt'}};

test('structured scripts require same-host capability and pass values separately',async()=>{
  let capable=false,calls=[];
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>({...identity,capabilities:{structuredScriptParameters:capable}}),invokeWorkbench:async(name,args,options)=>{calls.push({name,args,options});return {...identity};}});
  await assert.rejects(()=>dispatcher.invokeTool('revit_execute_csharp',{expected_document:identity.document.path,code:'return null;',parameters:{width:10}}),/未确认/);
  assert.equal(calls.length,0);capable=true;
  await dispatcher.invokeTool('revit_execute_csharp',{expected_document:identity.document.path,code:'return null;',parameters:{width:10}});
  assert.equal(calls[0].options.expectedHostSession,identity.hostSession);assert.deepEqual(calls[0].args.parameters,{width:10});
});
test('sequence dispatcher binds every step to its initial document and keeps unknown receipt ownership',async()=>{
  let identityChanged=false,stepCalls=0;const owner=Object.freeze({inspect:async()=>({ok:true}),close:async()=>({ok:true,value:{closed:true}})});
  const dispatcher=createModelToolDispatcher({
    invokeAtomicRead:async(name,args,options)=>{if(name==='revit_workbench_status')return {...identity,document:{...identity.document,path:identityChanged?'D:\\other.rvt':identity.document.path},capabilities:{structuredScriptParameters:true}};
      stepCalls++;assert.equal(args.expected_document,identity.document.path);assert.equal(options.expectedHostSession,identity.hostSession);return {...identity,value:{items:[]}};},
    invokeCommand:async(_name,_args,options)=>{
      assert.equal(options.parameterizedScriptsSupported,true);const bound=await options.bindSequence();assert.equal(await options.verifySequence(bound),true);
      await options.executeStep('revit_get_selection',{},bound);identityChanged=true;assert.equal(await options.verifySequence(bound),false);
      const result={execution:{status:'unknown',steps:[{id:'s1',status:'unknown'}]}};Object.defineProperty(result,'receiptOwner',{value:owner});return result;
    }
  });
  const result=await dispatcher.invokeCommand('revit_run_command',{command_id:'sample',revision:'a'.repeat(64)},{confirmed:true});
  assert.equal(stepCalls,1);assert.equal(result.ok,false);assert.equal(result.error.outcome,'unconfirmed');assert.equal(result.receiptOwner,owner);assert.equal(result.evidence.producerResult.execution.steps[0].status,'unknown');
});
