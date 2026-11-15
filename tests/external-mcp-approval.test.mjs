import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExternalMcpApprovalOwner} from '../lib/external-mcp-approval.mjs';
const identity=()=>({accountId:'test-account',sessionId:'test-session',connectionId:'test-connection',conversationId:'test-conversation'});
const proposal=()=>({proposalId:'proposal-id',serverId:'server-id',generation:'generation-id',tool:'test',argumentDigest:'digest'});
test('explicit approval is bound to one proposal and consumed only once',async()=>{
  let now=1;const owner=createExternalMcpApprovalOwner({readIdentity:identity,now:()=>now});const p=proposal(),request=owner.request({kind:'mcp_call',proposal:p});
  assert.equal(await owner.consume({approvalId:request.approvalId,kind:'mcp_call',proposal:p}),false);
  const second=owner.request({kind:'mcp_call',proposal:p});assert.equal(owner.decide({approvalId:second.approvalId,decision:'approve'}).ok,true);
  assert.equal(await owner.consume({approvalId:second.approvalId,kind:'mcp_call',proposal:p}),true);
  assert.equal(await owner.consume({approvalId:second.approvalId,kind:'mcp_call',proposal:p}),false);
});
test('identity changes, content changes, denial and expiration cannot grant approval',async()=>{
  let now=1,who=identity();const owner=createExternalMcpApprovalOwner({readIdentity:()=>who,now:()=>now,ttlMs:1000}),p=proposal();
  let x=owner.request({kind:'mcp_call',proposal:p});owner.decide({approvalId:x.approvalId,decision:'approve'});who={...who,conversationId:'other'};
  assert.equal(await owner.consume({approvalId:x.approvalId,kind:'mcp_call',proposal:p}),false);who=identity();
  x=owner.request({kind:'mcp_call',proposal:p});owner.decide({approvalId:x.approvalId,decision:'approve'});
  assert.equal(await owner.consume({approvalId:x.approvalId,kind:'mcp_call',proposal:{...p,argumentDigest:'changed'}}),false);
  x=owner.request({kind:'mcp_call',proposal:p});owner.decide({approvalId:x.approvalId,decision:'deny'});assert.equal(await owner.consume({approvalId:x.approvalId,kind:'mcp_call',proposal:p}),false);
  x=owner.request({kind:'mcp_call',proposal:p});owner.decide({approvalId:x.approvalId,decision:'approve'});now=1001;assert.equal(await owner.consume({approvalId:x.approvalId,kind:'mcp_call',proposal:p}),false);
});
test('closing or invalidating an approval owner revokes pending approvals',async()=>{
  const owner=createExternalMcpApprovalOwner({readIdentity:identity}),p=proposal();let x=owner.request({kind:'mcp_start',proposal:p});
  owner.decide({approvalId:x.approvalId,decision:'approve'});owner.invalidate();assert.equal(await owner.consume({approvalId:x.approvalId,kind:'mcp_start',proposal:p}),false);
  x=owner.request({kind:'mcp_start',proposal:p});owner.close();assert.equal(owner.decide({approvalId:x.approvalId,decision:'approve'}).ok,false);
});
