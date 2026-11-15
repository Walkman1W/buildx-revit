import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {confirmedWriteProfile} from '../../lib/confirmed-write-profile.mjs';
import {createModelPermissionOwner} from '../../lib/model-permission-owner.mjs';
const scope={client:'c',conversationId:'chat',generation:1,revision:1,account:'a',document:{session:'h',path:'C:\\m.rvt',title:'m'}};
test('marker absent preserves development and malformed marker fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'buildx-profile-'));try{assert.equal(confirmedWriteProfile(dir),false);fs.writeFileSync(path.join(dir,'buildx-confirmed-write.json'),'{}');assert.throws(()=>confirmedWriteProfile(dir));fs.writeFileSync(path.join(dir,'buildx-confirmed-write.json'),JSON.stringify({schemaVersion:1,scope:'confirmed-write'}));assert.equal(confirmedWriteProfile(dir),true);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('guarded proposal requires per-action confirmation including rollback',async()=>{
 const calls=[];const owner=createModelPermissionOwner({confirmedWrite:true,verifyDocument:async()=>true,invoke:async(...x)=>{calls.push(x);return {ok:true,value:'simulated'};}});
 assert.throws(()=>owner.setLevel({scope,level:'automatic',isCurrent:()=>true}));owner.setLevel({scope,level:'confirm',isCurrent:()=>true});
 const request=(id,mode='rollback',tool='revit_create_group')=>owner.propose({scope,callId:id,tool,parameters:{name:'group',element_ids:[1,2],mode},isCurrent:()=>true});
 for(const tool of ['revit_execute_csharp','revit_run_command','revit_smart_annotate','revit_family_create_valve','revit_move_elements'])assert.throws(()=>request(tool,'commit',tool));
 assert.throws(()=>request('bad','automatic'));
 let p=request('declined');assert.equal(p.requiresApproval,true);assert.equal(calls.length,0);assert.equal((await owner.decide({ticket:p.ticket,digest:p.digest,decision:'decline'})).status,'declined');assert.equal(calls.length,0);
 p=request('accepted','commit');assert.equal(p.requiresApproval,true);assert.equal(calls.length,0);assert.equal((await owner.decide({ticket:p.ticket,digest:p.digest,decision:'accept'})).status,'completed');assert.equal(calls.length,1);assert.equal(calls[0][0],'revit_create_group');await owner.close();
});
