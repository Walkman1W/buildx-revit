// Separate test process: only synthetic IDs and a caller-created temp root.
import {createExternalMcpReceipts} from '../lib/external-mcp-receipts.mjs';
const [root,encoded]=process.argv.slice(2),payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
const identity={accountId:'test-account',sessionId:'test-session',connectionId:'test-connection',conversationId:'test-conversation'};
const privateRootOwner=Object.freeze({async verify(){return true;}});
const owner=createExternalMcpReceipts({root,identity,privateRootOwner});
if(await owner.recordAttempt(payload))process.send?.({stored:true});else process.send?.({stored:false});
setInterval(()=>{},1000);
