import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelPermissionOwner} from './model-permission-owner.mjs';

const scope={client:'client',conversationId:'conversation',generation:1,revision:2,account:'account',document:{session:'host',path:'C:\\model.rvt',title:'Model'}};
const review=operation=>({review:{job_handle:'job',family_content:{length_mm:300}},expiresAt:Date.now()+30000,approvedLifecycle:{schema_version:1,operation,approval_token:'a'.repeat(32)},approvedFamilyIdentity:{job_handle:'job',project_handle:'project',project_fingerprint:'fingerprint',template:{template_id:'metric-generic-model',sha256:'b'.repeat(64)},save:{attempted:false,state:'not_started',path:null,sha256:null,independently_reopened_verified:false}}});

test('family lifecycle remains unavailable without trusted capability',()=>{
  const owner=createModelPermissionOwner({verifyDocument:async()=>true,invoke:async()=>({ok:true})});owner.setLevel({scope,level:'automatic',isCurrent:()=>true});
  for(const tool of ['revit_family_save_job','revit_family_close_job'])assert.throws(()=>owner.propose({scope,callId:tool,tool,parameters:{job_handle:'job'},reviewedLifecycle:review(tool.slice(6)),isCurrent:()=>true}),/separate authorization/);
});

test('save and close always require a one-use human decision and retain only the approved token',async()=>{
  for(const level of ['rollback','confirm','automatic'])for(const tool of ['revit_family_save_job','revit_family_close_job']){
    const calls=[],owner=createModelPermissionOwner({familyLifecycleEnabled:true,verifyDocument:async()=>true,verifyLifecycle:async()=>true,invoke:async(...args)=>{calls.push(args);return {ok:true};}});
    owner.setLevel({scope,level,isCurrent:()=>true});const source=review(tool.slice(6));
    const p=owner.propose({scope,callId:tool,tool,parameters:{job_handle:'job'},reviewedLifecycle:source,isCurrent:()=>true});
    source.review.family_content.length_mm=400;source.approvedLifecycle.approval_token='c'.repeat(32);
    assert.equal(p.requiresApproval,true);assert.equal(p.reviewedLifecycle.family_content.length_mm,300);assert.equal(JSON.stringify(p).includes('a'.repeat(32)),false);assert.equal(calls.length,0);
    assert.equal((await owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(calls.length,1);
    assert.equal(calls[0][2].approvedLifecycle.approval_token,'a'.repeat(32));assert.equal(calls[0][2].approvedFamilyIdentity.job_handle,'job');
    await assert.rejects(owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}));assert.equal((await owner.close()).closed,true);
  }
});

test('expired or mismatched approval cannot dispatch',async()=>{
  const calls=[],owner=createModelPermissionOwner({familyLifecycleEnabled:true,verifyDocument:async()=>true,verifyLifecycle:async()=>true,invoke:async()=>{calls.push(1);return {ok:true};}});owner.setLevel({scope,level:'automatic',isCurrent:()=>true});
  const proposal=options=>owner.propose({scope,callId:Math.random().toString(),tool:'revit_family_save_job',parameters:{job_handle:'job'},isCurrent:()=>true,...options});
  const bad=review('family_close_job');assert.throws(()=>proposal({reviewedLifecycle:bad}),/unavailable/);
  const expired=review('family_save_job');expired.expiresAt=Date.now()-1;assert.throws(()=>proposal({reviewedLifecycle:expired}),/unavailable/);
  const valid=review('family_save_job');valid.expiresAt=Date.now()+15;const p=proposal({reviewedLifecycle:valid});await new Promise(resolve=>setTimeout(resolve,30));await assert.rejects(owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'}));assert.equal(calls.length,0);
});
