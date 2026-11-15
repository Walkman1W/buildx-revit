import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {createExternalMcpOwner} from '../lib/external-mcp-owner.mjs';
import {createExternalMcpApprovalOwner} from '../lib/external-mcp-approval.mjs';
import {createExternalMcpReceipts} from '../lib/external-mcp-receipts.mjs';
const fixture=fileURLToPath(new URL('../test-support/external-mcp-fixture.mjs',import.meta.url));
const identity={accountId:'test-account',sessionId:'test-session',connectionId:'test-connection',conversationId:'test-conversation'};
// The following owners are fixtures, not proof of OS sandbox, private ACL or
// executable identity pinning. Production must supply real verifiable owners.
const testProof=Object.freeze({async verify(){return true;}});
const testGuard=Object.freeze({async createTransport({command,args,cwd,environment,maxBufferSize,StdioClientTransport}){return new StdioClientTransport({command,args,cwd,env:environment,maxBufferSize,stderr:'ignore'});}});
test('explicit independent launch/call approvals and durable receipts compose with synthetic MCP',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-composition-')),dataRoot=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-ledger-'));
  const approvals=createExternalMcpApprovalOwner({readIdentity:()=>identity}),receipts=createExternalMcpReceipts({root:dataRoot,identity,privateRootOwner:testProof});
  assert.deepEqual(await receipts.ready(),{ok:true,unresolved:[]});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner:approvals,receiptOwner:receipts,executionGuard:testGuard});
  const launch=await owner.launchProposal(),startApproval=approvals.request({kind:'mcp_start',proposal:launch.proposal});
  assert.equal(approvals.decide({approvalId:startApproval.approvalId,decision:'approve'}).ok,true);
  assert.equal((await owner.start({proposalId:launch.proposal.proposalId,approvalId:startApproval.approvalId})).ok,true);
  const p=owner.prepareCall({name:'record',args:{value:'user-secret'},sensitivePaths:['/value']}),callApproval=approvals.request({kind:'mcp_call',proposal:p.proposal});
  assert.equal(approvals.decide({approvalId:callApproval.approvalId,decision:'approve'}).ok,true);
  const result=await owner.call({proposalId:p.proposal.proposalId,approvalId:callApproval.approvalId});assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual((await receipts.ready()).unresolved,[]);assert.equal((await owner.close()).ok,true);assert.equal((await receipts.close()).ok,true);
  const folder=path.join(dataRoot,'mcp-'+createHash('sha256').update(identity.accountId).digest('hex'));
  for(const name of await readdir(folder)){const text=await readFile(path.join(folder,name),'utf8');assert.equal(text.includes('user-secret'),false);}
});
