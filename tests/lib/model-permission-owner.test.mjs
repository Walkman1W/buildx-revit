import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPermissionOwner,modelPermissionErrorView} from '../../lib/model-permission-owner.mjs';
import {supportsModelPermissionTool} from '../../lib/model-operation-effects.mjs';

const scope=()=>({client:'client',conversationId:'conversation',generation:1,revision:2,account:'account',document:{session:'host',path:'C:\\model.rvt',title:'Model'}});
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(extra={}){
  const calls=[];let live=true;
  const owner=createModelPermissionOwner({verifyDocument:async()=>true,invoke:async(...args)=>{calls.push(args);return {ok:true,value:'done'};},...extra});
  const bind=level=>owner.setLevel({level,scope:scope(),isCurrent:()=>live});
  const propose=(parameters={},id='call')=>owner.propose({scope:scope(),callId:id,tool:'revit_move_elements',parameters:{element_ids:[1],delta_mm:{x:1,y:0,z:0},...parameters},isCurrent:()=>live});
  return {owner,calls,bind,propose,stop:()=>{live=false;}};
}

test('levels bound transaction authority; explicit and default preview never become a commit',async()=>{
  for(const level of ['rollback','confirm','automatic'])for(const requested of [undefined,'rollback','commit']){
    const f=fixture();f.bind(level);const p=f.propose(requested?{mode:requested}:{});
    const expected=level==='rollback'?'rollback':requested??'rollback';
    assert.equal(p.parameters.mode,expected);assert.equal(p.requiresApproval,level==='confirm'&&expected==='commit');
    const out=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
    assert.equal(out.status,'completed');assert.equal(f.calls[0][1].mode,expected);
    assert.equal(f.calls[0][2].sourceDocument.session,'host');
    assert.equal(await f.owner.close().then(x=>x.closed),true);
  }
  const f=fixture();f.bind('automatic');assert.throws(()=>f.propose({mode:'other'}));assert.throws(()=>f.propose({mode:null}));
});

test('unclassified and unsupported side-effecting tools cannot enter this owner',()=>{
  const f=fixture();f.bind('automatic');
  for(const tool of ['unknown','revit_family_create_cabinet','revit_family_save_cabinet','revit_family_close_cabinet','revit_workbench_status'])assert.throws(()=>f.owner.propose({scope:scope(),callId:tool,tool,parameters:{mode:'commit'},isCurrent:()=>true}),/separate authorization/);
  for(const tool of ['revit_family_create_valve','revit_family_save_job','revit_family_close_job'].filter(name=>!supportsModelPermissionTool(name)))assert.throws(()=>f.owner.propose({scope:scope(),callId:tool,tool,parameters:{mode:'commit'},isCurrent:()=>true}),/separate authorization/);
  assert.throws(()=>f.propose({expected_document:'C:\\other.rvt'}),/mismatch/);
  assert.throws(()=>f.owner.propose({scope:{...scope(),account:'other'},callId:'other',tool:'revit_move_elements',parameters:{},isCurrent:()=>true}),/authorization/);
});

test('proposal failures identify the producing boundary without exposing arbitrary exception text',()=>{
  const f=fixture();f.bind('automatic');
  const base={scope:scope(),callId:'typed',tool:'revit_move_elements',parameters:{mode:'commit'},isCurrent:()=>true};
  const cases=[
    [{...base,tool:'revit_save_document'},'MODEL_OPERATION_UNSUPPORTED'],
    [{...base,scope:{...scope(),account:'other'}},'MODEL_PERMISSION_SCOPE_MISMATCH'],
    [{...base,parameters:{mode:'other'}},'MODEL_TRANSACTION_MODE_INVALID'],
    [{...base,parameters:{expected_document:'C:\\other.rvt'}},'MODEL_DOCUMENT_MISMATCH'],
    [{...base,parameters:[]},'MODEL_OPERATION_PARAMETERS_INVALID'],
    [{...base,tool:'revit_execute_csharp',parameters:{code:42}},'MODEL_SCRIPT_PARAMETERS_INVALID'],
    [{...base,isCurrent:()=>false},'MODEL_PERMISSION_CHANGED'],
  ];
  for(const [input,code] of cases)assert.throws(()=>f.owner.propose(input),cause=>{
    assert.equal(cause.code,code);assert.equal(modelPermissionErrorView(cause).code,code);assert.equal(modelPermissionErrorView(cause).outcome,'not_started');return true;
  });
  const unknown=modelPermissionErrorView(new Error('private upstream body'));
  assert.equal(unknown.code,'MODEL_OPERATION_PROPOSAL_FAILED');assert.equal(JSON.stringify(unknown).includes('private upstream body'),false);
});

test('stage observer errors cannot alter authorization, dispatch or completed outcome',async()=>{
  const f=fixture();f.bind('automatic');const phases=[];
  const p=f.owner.propose({scope:scope(),callId:'diagnostic',tool:'revit_move_elements',parameters:{mode:'commit',element_ids:[1],delta_mm:{x:1,y:0,z:0}},isCurrent:()=>true,onStage:event=>{phases.push(event.phase);throw new Error('diagnostic writer failed');}});
  const result=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
  assert.equal(result.status,'completed');assert.equal(f.calls.length,1);assert.deepEqual(phases,['verifying','dispatching','completed']);
});

test('family create requires separate review in each level and does not claim a preapproved template hash',{skip:!supportsModelPermissionTool('revit_family_create_valve')},async()=>{
  for(const level of ['rollback','confirm','automatic']){
    const f=fixture();f.bind(level);const p=f.owner.propose({scope:scope(),callId:'family-create',tool:'revit_family_create_valve',parameters:{template_id:'metric-generic-model'},isCurrent:()=>true});
    assert.equal(p.requiresApproval,true);assert.equal(Object.hasOwn(p.parameters,'mode'),false);assert.equal(p.parameters.length_mm,300);assert.equal(p.parameters.diameter_mm,100);assert.match(p.notice,/宿主执行时选择并核验/);assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');
  }
});

test('family save and close remain denied until the host can enforce approved job facts',()=>{
  const f=fixture();f.bind('automatic');for(const tool of ['revit_family_save_job','revit_family_close_job'])assert.throws(()=>f.owner.propose({scope:scope(),callId:tool,tool,parameters:{job_handle:'job'},isCurrent:()=>true}),/separate authorization/);
});

test('external annotation and schematic always require review, including rollback and automatic',async()=>{
  for(const tool of ['revit_smart_annotate','revit_build_schematic'])for(const level of ['rollback','confirm','automatic']){
    const f=fixture();f.bind(level);const parameters=tool==='revit_smart_annotate'?{mode:'commit',element_ids:[1],view_id:2,tag_type_id:3}:{mode:'commit',start_element_id:1,schematic_type:'pipe'};
    const p=f.owner.propose({scope:scope(),callId:tool,tool,parameters,isCurrent:()=>true});assert.equal(p.effect,'external_model_operation');assert.equal(p.requiresApproval,true);assert.match(p.notice,/事务外副作用/);
    assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(f.calls[0][1].mode,level==='rollback'?'rollback':'commit');
  }
});

test('family load always needs approval and rechecks the exact approved project and RFA',async()=>{
  for(const level of ['rollback','confirm','automatic']){
    let verified=0;const f=fixture({verifyFamily:async facts=>{verified++;return facts.save.sha256==='a'.repeat(64);}});f.bind(level);
    const reviewedFamily={job_handle:'job',project_handle:'project',project_fingerprint:'fingerprint',save:{path:'C:\\family.rfa',sha256:'a'.repeat(64)}};
    const p=f.owner.propose({scope:scope(),callId:'family',tool:'revit_family_load_job',parameters:{job_handle:'job',mode:'commit'},reviewedFamily,isCurrent:()=>true});
    reviewedFamily.save.sha256='b'.repeat(64);assert.equal(p.requiresApproval,true);assert.equal(p.effect,'family_load');assert.equal(p.reviewedFamily.save.sha256,'a'.repeat(64));
    assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(verified,1);
    assert.equal(f.calls[0][1].mode,level==='rollback'?'rollback':'commit');assert.equal(f.calls[0][2].approvedFamily.save.sha256,'a'.repeat(64));
  }
  const f=fixture({verifyFamily:async()=>false});f.bind('automatic');const facts={job_handle:'job',project_handle:'project',project_fingerprint:'fingerprint',save:{path:'C:\\family.rfa',sha256:'a'.repeat(64)}};
  const p=f.owner.propose({scope:scope(),callId:'family',tool:'revit_family_load_job',parameters:{job_handle:'job'},reviewedFamily:facts,isCurrent:()=>true});assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'not_started');assert.equal(f.calls.length,0);
});

test('running a personal command binds its full exact revision and always requires review',async()=>{
  const f=fixture();f.bind('automatic');const revision='a'.repeat(64),args={command_id:'wall',revision,mode:'commit',parameters:{width:1}};
  assert.throws(()=>f.owner.propose({scope:scope(),callId:'absent',tool:'revit_run_command',parameters:args,isCurrent:()=>true}),/revision unavailable/);
  const record={schema_version:5,command_id:'wall',revision,name:'墙',description:'示例',code:'return parameters["width"];',parameters:{width:'number'},parameter_options:{width:{kind:'enum',values:[1,3]}}};
  const p=f.owner.propose({scope:scope(),callId:'run',tool:'revit_run_command',parameters:args,reviewedCommand:record,isCurrent:()=>true});
  record.code='changed';record.parameter_options.width.values.push(4);args.parameters.width=2;
  assert.equal(p.requiresApproval,true);assert.equal(p.effect,'run_command');assert.equal(p.reviewedCommand.code,'return parameters["width"];');assert.equal(p.parameters.parameters.width,1);assert.match(p.notice,/事务回滚不能撤销/);
  assert.deepEqual(p.reviewedCommand.parameter_options.width.values,[1,3]);assert.equal(p.reviewedCommand.schema_version,5);
  assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(f.calls[0][1].revision,revision);assert.equal(f.calls[0][1].parameters.width,1);
  assert.throws(()=>f.owner.propose({scope:scope(),callId:'mismatch',tool:'revit_run_command',parameters:args,reviewedCommand:{...record,revision:'b'.repeat(64)},isCurrent:()=>true}),/revision unavailable/);
});

test('saving a validated personal command always needs independent approval and never runs it',async()=>{
  for(const level of ['rollback','confirm','automatic']){
    const f=fixture();f.bind(level);
    const input={command_id:'make-wall',name:'创建墙',description:'新命令',code:'return 42;',parameters:{width:'number'},parameter_labels:{width:'宽度'},parameter_options:{width:{kind:'enum',values:[10,20]}}};
    const p=f.owner.propose({scope:scope(),callId:'save',tool:'revit_save_command',parameters:input,isCurrent:()=>true});
    input.code='return 999;';assert.equal(p.requiresApproval,true);assert.equal(p.effect,'save_command');assert.match(p.notice,/保存不会运行/);
    assert.equal(p.parameters.code,'return 42;');assert.equal(Object.hasOwn(p.parameters,'mode'),false);
    assert.deepEqual(p.parameters.parameter_options.width.values,[10,20]);
    assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');
    assert.equal(f.calls[0][0],'revit_save_command');assert.equal(f.calls[0][1].code,'return 42;');
  }
  const f=fixture();f.bind('automatic');
  assert.throws(()=>f.owner.propose({scope:scope(),callId:'invalid',tool:'revit_save_command',parameters:{command_id:'../unsafe',name:'bad',description:'bad',code:'return 1;'},isCurrent:()=>true}));
});

test('C# requires explicit review in every level, including rollback and automatic',async()=>{
  for(const level of ['rollback','confirm','automatic'])for(const requested of ['rollback','commit']){
    const f=fixture();f.bind(level);
    const input={mode:requested,code:'return parameters["height"];',parameters:{height:2}};
    const p=f.owner.propose({scope:scope(),callId:'script',tool:'revit_execute_csharp',parameters:input,isCurrent:()=>true});
    input.code='altered';input.parameters.height=999;
    assert.equal(p.effect,'csharp');assert.equal(p.requiresApproval,true);
    assert.match(p.notice,/事务回滚不能撤销/);assert.match(p.notice,/文件、网络/);
    assert.equal(p.parameters.code,'return parameters["height"];');assert.equal(p.parameters.parameters.height,2);
    assert.equal(p.parameters.mode,level==='rollback'?'rollback':requested);
    const result=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
    assert.equal(result.status,'completed');assert.equal(f.calls[0][1].code,p.parameters.code);assert.equal(f.calls[0][1].parameters.height,2);
  }
});

test('C# rejects malformed or ambiguous script input before review',()=>{
  const f=fixture();f.bind('automatic');let id=0;
  const propose=parameters=>f.owner.propose({scope:scope(),callId:'script-'+(++id),tool:'revit_execute_csharp',parameters,isCurrent:()=>true});
  for(const parameters of [{},{code:''},{code:'x'.repeat(64001)},{code:'ok',unexpected:true},{code:'ok',parameters:{value:null}},{code:'ok',parameters:{value:{nested:true}}}])assert.throws(()=>propose(parameters));
  assert.equal(propose({code:'return null;'}).requiresApproval,true);
});

test('decision is one shot, bound to immutable parameters and cannot be replayed',async()=>{
  const wait=defer(),calls=[];const f=fixture({invoke:async(...args)=>{calls.push(args);return wait.promise;}});f.bind('confirm');
  const input={mode:'commit',element_ids:[1],delta_mm:{x:1,y:2,z:3}};const p=f.propose(input);input.element_ids[0]=2;
  assert.throws(()=>{p.parameters.mode='rollback';},TypeError);
  const pending=f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
  await Promise.resolve();await assert.rejects(f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}));
  wait.resolve({ok:true,value:'done'});assert.equal((await pending).status,'completed');assert.deepEqual(calls[0][1].element_ids,[1]);
  assert.throws(()=>f.propose({},'call'),/Duplicate/);
});

test('changed identity, revocation and deadline stop before publishing, including during validation',async()=>{
  for(const change of ['revoke','identity','timeout']){
    const wait=defer(),calls=[];const f=fixture({approvalTimeoutMs:change==='timeout'?10:60000,verifyDocument:()=>wait.promise,invoke:async(...a)=>{calls.push(a);return {ok:true};}});f.bind('automatic');const p=f.propose({mode:'commit'});
    const pending=f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
    if(change==='revoke')f.owner.revoke();else if(change==='identity')f.stop();else await new Promise(r=>setTimeout(r,20));
    wait.resolve(true);assert.equal((await pending).status,'not_started');assert.equal(calls.length,0);
  }
});

test('once dispatched, an interrupted or failed request stays unconfirmed and cannot be resubmitted',async()=>{
  const wait=defer();let invoked;const started=new Promise(r=>{invoked=r;});
  const f=fixture({invoke:async(...args)=>{invoked(args);return wait.promise;}});f.bind('automatic');const p=f.propose({mode:'commit'});
  const run=f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});const args=await started;
  f.owner.revoke();assert.equal(args[2].shouldContinue(),false);wait.resolve({ok:true,value:'completed'});
  assert.deepEqual(await run,{status:'unconfirmed',ticket:p.ticket});assert.equal((await f.owner.close()).closed,false);
  const receipt=await f.owner.inspect({ticket:p.ticket,scope:scope()});assert.equal(receipt.value.terminal,true);
  assert.deepEqual(await f.owner.acknowledge({ticket:p.ticket,scope:scope(),expected:receipt.value}),{closed:true});
  assert.equal((await f.owner.close()).closed,true);
});

test('exceptions and owned receipts are retained; decline does not invoke',async()=>{
  const f=fixture({invoke:async()=>{throw new Error('unknown dispatch outcome');}});f.bind('confirm');const p=f.propose({mode:'commit'});
  assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'decline'})).status,'declined');
  const q=f.propose({mode:'commit'},'next');assert.equal((await f.owner.decide({ticket:q.ticket,digest:q.digest,decision:'accept'})).status,'unconfirmed');
  assert.equal((await f.owner.close()).closed,false);
  const receipt=await f.owner.inspect({ticket:q.ticket,scope:scope()});
  assert.deepEqual(receipt,{ok:true,value:{status:'unconfirmed',terminal:false,originalReceiptUnavailable:true}});
  await assert.rejects(f.owner.acknowledge({ticket:q.ticket,scope:scope(),expected:receipt.value}),/changed or unconfirmed/);
  assert.equal((await f.owner.close()).closed,false);
});

test('a thrown transport error retains its original receipt owner until cleanup succeeds',async()=>{
  let closeCalls=0;
  const original={
    inspect:async()=>({ok:true,value:{terminal:true,status:'received',requestId:'original'}}),
    close:async()=>++closeCalls===1?{ok:false,error:{message:'temporary cleanup failure'}}:{ok:true,value:{closed:true}},
  };
  const f=fixture({invoke:async()=>{const error=new Error('reply lost');error.receiptOwner=original;throw error;}});
  f.bind('automatic');const p=f.propose({mode:'commit'});
  assert.deepEqual(await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}),{status:'unconfirmed',ticket:p.ticket});
  const receipt=await f.owner.inspect({ticket:p.ticket,scope:scope()});
  await assert.rejects(f.owner.acknowledge({ticket:p.ticket,scope:scope(),expected:receipt.value}),/cleanup unconfirmed/);
  assert.equal((await f.owner.close()).closed,false);
  assert.deepEqual(await f.owner.acknowledge({ticket:p.ticket,scope:scope(),expected:receipt.value}),{closed:true});
  assert.equal((await f.owner.close()).closed,true);assert.equal(closeCalls,2);
});

test('a verified successful receipt is released only while the grant remains current',async()=>{
  let closed=0;const owner={close:async()=>{closed++;return {ok:true,value:{closed:true}};}};
  const f=fixture({invoke:async()=>({ok:true,value:'done',receiptOwner:owner})});f.bind('automatic');const p=f.propose({mode:'commit'});
  assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(closed,1);assert.equal((await f.owner.close()).closed,true);
  const wait=defer(),starting=defer();const late={close:async()=>{starting.resolve();return wait.promise;}};
  const g=fixture({invoke:async()=>({ok:true,value:'done',receiptOwner:late})});g.bind('automatic');const q=g.propose({mode:'commit'});
  const run=g.owner.decide({ticket:q.ticket,digest:q.digest,decision:'accept'});await starting.promise;g.owner.revoke();wait.resolve({ok:true,value:{closed:true}});
  assert.deepEqual(await run,{status:'unconfirmed',ticket:q.ticket});const receipt=await g.owner.inspect({ticket:q.ticket,scope:scope()});assert.equal(receipt.value.terminal,true);
  assert.deepEqual(await g.owner.acknowledge({ticket:q.ticket,scope:scope(),expected:receipt.value}),{closed:true});
});

test('receipt acknowledgment ignores observation time but binds original terminal evidence',async()=>{
  let checks=0,closed=0;const receipt={inspect:async()=>({ok:true,value:{terminal:true,status:'received',requestId:'original',checkedAt:String(++checks),evidence:{requestId:'original'}}}),close:async()=>{closed++;return {ok:true,value:{closed:true}};}};
  const f=fixture({invoke:async()=>({ok:false,error:{outcome:'unconfirmed'},receiptOwner:receipt})});f.bind('automatic');const p=f.propose({mode:'commit'});
  assert.equal((await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'unconfirmed');
  const original=await f.owner.inspect({ticket:p.ticket,scope:scope()});
  await assert.rejects(f.owner.acknowledge({ticket:p.ticket,scope:scope(),expected:{...original.value,evidence:{requestId:'different'}}}),/changed or unconfirmed/);
  assert.deepEqual(await f.owner.acknowledge({ticket:p.ticket,scope:scope(),expected:original.value}),{closed:true});assert.equal(closed,1);
});

test('input bounds apply before serializing deeply expanded operation data',()=>{
  const f=fixture();f.bind('automatic');
  assert.throws(()=>f.propose({text:'中'.repeat(50000)}),/too large/);
  assert.throws(()=>f.propose({items:Array.from({length:10000},()=>[1,2])}),/Invalid model operation data/);
});

test('cancelling or switching grants during live verification prevents dispatch',async()=>{
  for(const change of ['cancel','switch','close']){
    const wait=defer(),calls=[];const f=fixture({verifyDocument:()=>wait.promise,invoke:async(...args)=>{calls.push(args);return {ok:true};}});
    f.bind('confirm');const p=f.propose({mode:'commit'});const pending=f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});
    if(change==='cancel')await f.owner.cancel({ticket:p.ticket});
    else if(change==='switch')f.bind('rollback');
    else assert.equal((await f.owner.close()).closed,false);
    wait.resolve(true);assert.equal((await pending).status,'not_started');assert.equal(calls.length,0);
  }
});


test('UI selection requires per-call confirmation at every permission level and never gets transaction mode',async()=>{
 for(const level of ['rollback','confirm','automatic']){const f=fixture();f.bind(level);const p=f.owner.propose({scope:scope(),callId:'selection',tool:'revit_set_selection',parameters:{element_ids:[3,1]},isCurrent:()=>true});assert.equal(p.effect,'ui_selection');assert.equal(p.requiresApproval,true);assert.equal(Object.hasOwn(p.parameters,'mode'),false);assert.match(p.notice,/无法通过模型事务回滚/);const result=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});assert.equal(result.status,'completed');assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0][1],'mode'),false);}
});


test('UniqueId selection always requires approval without model transaction mode',async()=>{
 for(const level of ['rollback','confirm','automatic']){const f=fixture();f.bind(level);const p=f.owner.propose({scope:scope(),callId:'unique',tool:'revit_select_by_unique_ids',parameters:{element_uids:['uid-a']},isCurrent:()=>true});assert.equal(p.effect,'ui_selection');assert.equal(p.requiresApproval,true);assert.equal(Object.hasOwn(p.parameters,'mode'),false);const result=await f.owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'});assert.equal(result.status,'completed');assert.equal(f.calls.length,1);}
});
