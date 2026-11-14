import test from 'node:test';
import assert from 'node:assert/strict';
import {skillReadFailureMessage as message} from './public/chat-view.mjs';
test('skills retain safe actionable rejection reasons without changing execution',()=>{
 assert.match(message({rejected:true,message:'请等待当前操作结束。'}),/未开始.*原操作回执/);
 assert.match(message({rejected:true,message:'请先连接并确认本机 Codex。'}),/连接尚未确认/);
 assert.match(message({rejected:true,message:'对话已变化，请重新读取技能。'}),/弃用/);
 assert.match(message({rejected:true,message:'账号、连接、资料库或对话已变化，请重新读取技能。'}),/弃用/);
 assert.match(message({rejected:true,message:'此工作区未开放技能读取。'}),/模型工作区/);
});
test('unknown and private error text is never reflected into skills UI',()=>{
 for(const error of [null,new Error('secret_token_value'),{rejected:true,message:'private server diagnostic'},{message:'请等待当前操作结束。'}])assert.equal(message(error),'技能列表未能核实，请重新读取。');
});
