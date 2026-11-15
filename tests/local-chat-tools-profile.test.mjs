import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CodexClient} from '../lib/codex-client.mjs';
import {LOCAL_CHAT_TOOL_DEFINITIONS} from '../lib/local-chat-tools.mjs';
import {boundedChatNotification,ChatSession} from '../lib/chat-session.mjs';

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

test('native live search is explicit, keeps shell disabled and removes the Brave tool',()=>{
  const options={profile:'model-workspace',localTools:LOCAL_CHAT_TOOL_DEFINITIONS};
  const regular=new CodexClient(process.cwd(),options),native=new CodexClient(process.cwd(),{...options,nativeWebSearch:true});
  assert.ok(regular.profile.buildLaunchArgs([]).includes('web_search="disabled"'));
  const args=native.profile.buildLaunchArgs([]);
  assert.deepEqual(args.filter(value=>value.startsWith('web_search=')),['web_search="live"']);
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(native.profile.dynamicTools.every(tool=>tool.name!=='buildx_search_public_web'));
  assert.throws(()=>new CodexClient(process.cwd(),{profile:'source-development',nativeWebSearch:true}));
});

test('an App Server webSearch completion becomes a bounded native tool receipt',()=>{
  const session=new ChatSession();
  const run=session.begin('搜索 Autodesk 文档');
  assert.ok(session.bindThread(run,'test-thread'));
  run.turnId='test-turn';
  const params={threadId:run.threadId,turnId:run.turnId,item:{type:'webSearch',id:'search',query:'official Autodesk Revit documentation',action:{type:'openPage',url:'https://help.autodesk.com/'},ignored:'discarded'}};
  const event=boundedChatNotification('item/completed',params);
  assert.equal(event.item.ignored,undefined);
  assert.equal(session.notification(run,'item/completed',event,()=>null).changed,true);
  const record=session.view().messages.find(message=>message.role==='assistant').tools[0];
  assert.equal(record.name,'codex_web_search');
  assert.equal(record.status,'returned');
  assert.equal(record.resultPreview,'https://help.autodesk.com/');
});

test('native image enables scoped events and omits the separate Images API tool',()=>{
  const options={profile:'model-workspace',localTools:LOCAL_CHAT_TOOL_DEFINITIONS};
  const regular=new CodexClient(process.cwd(),options),native=new CodexClient(process.cwd(),{...options,nativeImageGeneration:true});
  assert.ok(regular.profile.buildLaunchArgs([]).includes('features.image_generation=false'));
  const args=native.profile.buildLaunchArgs([]);
  assert.ok(args.includes('features.image_generation=true'));
  assert.ok(args.includes('features.omit_app_server_notification_media=true'));
  assert.ok(native.profile.dynamicTools.every(tool=>tool.name!=='buildx_generate_image'));
  const session=new ChatSession(),run=session.begin('生成测试图');
  assert.ok(session.bindThread(run,'test-thread'));
  run.turnId='test-turn';
  const event=boundedChatNotification('item/completed',{threadId:run.threadId,turnId:run.turnId,
    item:{type:'imageGeneration',id:'image-result',status:'completed',savedPath:'private-path.png',result:'inline payload'}});
  assert.equal(event.item.result,undefined);
  assert.equal(session.notification(run,'item/completed',event,()=>null).changed,true);
  const record=session.view().messages.find(message=>message.role==='assistant').tools[0];
  assert.equal(record.name,'codex_image_generation');
  assert.equal(record.status,'returned');
  assert.ok(!JSON.stringify(record).includes('private-path.png'));
});
