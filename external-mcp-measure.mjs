// Reproducible synthetic, no network; fake guard/ACL are explicitly not a
// production security claim. Separate process is required for a cold run.
import {mkdtemp} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {createExternalMcpOwner} from './lib/external-mcp-owner.mjs';
import {createExternalMcpApprovalOwner} from './lib/external-mcp-approval.mjs';
import {createExternalMcpReceipts} from './lib/external-mcp-receipts.mjs';
const fixture=fileURLToPath(new URL('./external-mcp-fixture.mjs',import.meta.url));
const identity={accountId:'benchmark',sessionId:'benchmark-session',connectionId:'benchmark-connection',conversationId:'benchmark-conversation'};
const proof=Object.freeze({async verify(){return true;}}); // synthetic only
const guard=Object.freeze({async createTransport({command,args,cwd,environment,maxBufferSize,StdioClientTransport}){return new StdioClientTransport({command,args,cwd,env:environment,maxBufferSize,stderr:'ignore'});}}); // synthetic only
const results=[];
for(let i=0;i<3;i++){
  const root=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-bench-')),dataRoot=await mkdtemp(path.join(os.tmpdir(),'buildx-mcp-bench-log-'));
  const approvals=createExternalMcpApprovalOwner({readIdentity:()=>identity}),receipts=createExternalMcpReceipts({root:dataRoot,identity,privateRootOwner:proof});
  const owner=createExternalMcpOwner({command:process.execPath,args:[fixture,path.join(root,'events'),'none'],cwd:root,approvalOwner:approvals,receiptOwner:receipts,executionGuard:guard});
  const cpuStart=process.cpuUsage(),start=performance.now();
  if(!(await receipts.ready()).ok)throw new Error('fixture receipt store unavailable');
  const launch=await owner.launchProposal(),lp=approvals.request({kind:'mcp_start',proposal:launch.proposal});approvals.decide({approvalId:lp.approvalId,decision:'approve'});
  const connected=await owner.start({proposalId:launch.proposal.proposalId,approvalId:lp.approvalId});if(!connected.ok)throw new Error('fixture connect failed');
  const connectedAt=performance.now(),listed=owner.listTools(),listAt=performance.now();if(!listed.ok)throw new Error('fixture list failed');
  const p=owner.prepareCall({name:'record',args:{value:'benchmark'}}),ap=approvals.request({kind:'mcp_call',proposal:p.proposal});approvals.decide({approvalId:ap.approvalId,decision:'approve'});
  const response=await owner.call({proposalId:p.proposal.proposalId,approvalId:ap.approvalId});if(!response.ok)throw new Error('fixture call failed');
  const callAt=performance.now();if(!(await owner.close()).ok||!(await receipts.close()).ok)throw new Error('fixture cleanup unconfirmed');
  const cpu=process.cpuUsage(cpuStart);results.push({kind:i===0?'cold':'warm',connectAndDiscoveryMs:+(connectedAt-start).toFixed(2),listSnapshotMs:+(listAt-connectedAt).toFixed(2),callAndDurableReceiptMs:+(callAt-listAt).toFixed(2),elapsedWithCleanupMs:+(performance.now()-start).toFixed(2),parentCpuMs:+((cpu.user+cpu.system)/1000).toFixed(2),parentLifetimeMaxRssKiB:process.resourceUsage().maxRSS});
}
console.log(JSON.stringify({scope:'synthetic fixture; fake guard and ACL proof; no AI/network; process-family CPU and token unmeasured',node:process.version,results}));
