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
test('skills explain when the panel must reconnect or sign in before reading',()=>{
 assert.match(message({rejected:true,httpStatus:401,message:'请先登录并核验 BuildX 账号。'}),/登录并核验 BuildX 账号.*读取技能/);
 assert.match(message({rejected:true,httpStatus:403,message:'请重新连接面板后重试'}),/重新连接面板.*读取技能/);
 assert.match(message({rejected:true,httpStatus:503,message:'本地服务正在停止；仅原停机请求可重试清理。'}),/正在停止.*重新连接.*读取技能/);
 assert.match(message({rejected:true,httpStatus:503,message:'本地服务正在停止'}),/正在停止.*重新连接.*读取技能/);
 assert.equal(message({rejected:true,httpStatus:500,message:'请先登录并核验 BuildX 账号。'}),'技能列表未能核实，请重新读取。');
});
