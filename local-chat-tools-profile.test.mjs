import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CodexClient} from './lib/codex-client.mjs';
import {LOCAL_CHAT_TOOL_DEFINITIONS} from './lib/local-chat-tools.mjs';

test('confirmed-write installs only opt-in local tools in the real Codex client profile',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-local-chat-profile-'));
  t.after(()=>fs.rm(root,{force:true,recursive:true}));
  await fs.writeFile(path.join(root,'buildx-confirmed-write.json'),JSON.stringify({schemaVersion:1,scope:'confirmed-write'}));
  const options={profile:'model-workspace',generatedFiles:true,modelTerminal:false};
  const regular=new CodexClient(root,options);
  const local=new CodexClient(root,{...options,localTools:LOCAL_CHAT_TOOL_DEFINITIONS});
  assert.deepEqual(local.profile.dynamicTools.filter(tool=>LOCAL_CHAT_TOOL_DEFINITIONS.includes(tool)),LOCAL_CHAT_TOOL_DEFINITIONS);
  assert.equal(local.profile.dynamicTools.length,regular.profile.dynamicTools.length+4);
  assert.ok(regular.profile.dynamicTools.every(tool=>!LOCAL_CHAT_TOOL_DEFINITIONS.includes(tool)));
  assert.throws(()=>new CodexClient(root,{...options,localTools:Object.freeze([Object.freeze({...LOCAL_CHAT_TOOL_DEFINITIONS[0]})])}));
  assert.throws(()=>new CodexClient(root,{profile:'source-development',localTools:LOCAL_CHAT_TOOL_DEFINITIONS}));
});
