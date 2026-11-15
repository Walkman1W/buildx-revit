import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelToolDispatcher} from '../lib/model-tool-dispatch.mjs';
import {createModelPermissionServices} from '../lib/model-permission-services.mjs';
import {createModelPermissionOwner} from '../lib/model-permission-owner.mjs';
import {invokeAtomicWorkbenchRead} from '../lib/workbench-client.mjs';
import {timeoutAfterPublication} from '../test-support/workbench-timeout.mjs';

const document={session:'a'.repeat(32),path:'C:\\test.rvt',title:'Test'};
const wall={mode:'commit',wall_type_id:1740,level_id:355,start_mm:{x:0,y:0,z:0},end_mm:{x:4000,y:0,z:0},height_mm:3000};

test('malformed wall input is rejected before publishing even a status preflight',async()=>{
  let reads=0,writes=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:async()=>{reads++;throw new Error('Should not query');},invokeWorkbench:async()=>{writes++;}});
  await assert.rejects(dispatcher.invokeTool('revit_create_wall',{}, {sourceDocument:document}),error=>error.commandCode==='COMMAND_INPUT_INVALID'&&error.modelOutcome==='not_started');
  assert.equal(reads,0);assert.equal(writes,0);
});

test('a timed-out preflight retains its original read owner, then converges when the expired read receipt arrives',async t=>{
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'buildx-preflight-'));
  const owners=[];
  t.after(async()=>{for(const owner of owners)await owner.close();assert.equal(path.dirname(path.resolve(root)),parent);assert.match(path.basename(root),/^buildx-preflight-/);await fs.rm(root,{recursive:true,force:true});});
  for(const folder of ['inbox','processing','outbox'])await fs.mkdir(path.join(root,'queue',folder),{recursive:true});
  await fs.writeFile(path.join(root,'queue','host.json'),JSON.stringify({sessionId:document.session,pid:process.pid,version:'0.8.0',accessPolicyVersion:1}));
  let writes=0;
  const dispatcher=createModelToolDispatcher({invokeAtomicRead:(name,args,options)=>timeoutAfterPublication(control=>invokeAtomicWorkbenchRead(name,args,control),{...options,root}),invokeWorkbench:async()=>{writes++;}});
  const services=createModelPermissionServices({invoke:dispatcher.invokeTool,observe:async()=>({hostSession:document.session,document:{path:document.path,title:document.title,allowedSample:true}})});
  const scope={client:'browser',conversationId:'conversation',generation:1,revision:1,account:'account',document};
  const owner=createModelPermissionOwner({verifyDocument:async()=>true,invoke:(...args)=>services.invoke(...args)});owners.push(owner);
  owner.setLevel({level:'automatic',scope,isCurrent:()=>true});
  const proposal=owner.propose({scope,callId:'wall',tool:'revit_create_wall',parameters:wall,isCurrent:()=>true});
  const result=await owner.decide({ticket:proposal.ticket,digest:proposal.digest,decision:'accept'});
  assert.equal(result.status,'unconfirmed');assert.equal(result.operationOutcome,'not_started');assert.equal(result.stage,'document_preflight');assert.equal(writes,0);
  const requests=(await fs.readdir(path.join(root,'queue','inbox'))).filter(name=>name.endsWith('.json'));
  assert.equal(requests.length,1);
  const request=JSON.parse(await fs.readFile(path.join(root,'queue','inbox',requests[0]),'utf8'));
  assert.equal(request.operation,'status','Only the preflight read was published');
  let inspected=await owner.inspect({ticket:proposal.ticket,scope});assert.equal(inspected.value.status,'pending');
  await fs.writeFile(path.join(root,'queue','outbox',requests[0]),JSON.stringify({id:request.id,ok:false,hostSession:document.session,error:{code:'WORKBENCH_REQUEST_EXPIRED',message:'Request expired before execution; no operation was run.'},execution:{started:false,phase:'validation',reason:'expired'},completedUtc:new Date().toISOString()}));
  inspected=await owner.inspect({ticket:proposal.ticket,scope});
  assert.equal(inspected.value.status,'expired');assert.equal(inspected.value.terminal,true);assert.equal(inspected.value.requestId,request.id);
  assert.equal(inspected.value.nativeFailure.started,false);
  assert.deepEqual(await owner.acknowledge({ticket:proposal.ticket,scope,expected:inspected.value}),{closed:true});
  assert.deepEqual(await owner.close(),{closed:true});assert.equal(writes,0);
});
