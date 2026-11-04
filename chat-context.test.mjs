import test from 'node:test';
import assert from 'node:assert/strict';
import {captureChatContext,contextOptions,withChatContext} from './lib/chat-context.mjs';
const document={title:'合成样例',path:'D:\\samples\\A01.rvt',activeViewId:12,activeViewType:'FloorPlan',allowedSample:true};
const status=()=>({hostSession:'session-a',document:{...document}});
function selection(){return {operation:'get_selection',hostSession:'session-a',document:{title:document.title,path:document.path},value:{total:2,returned:2,truncated:false,items:[{element_id:14},{element_id:'9223372036854775807'}]}};}
test('context is opt-in, reads actual current selection with stable before/after identity',async()=>{
  let calls=[];const invoke=async(name,args)=>{calls.push({name,args});return name==='revit_workbench_status'?status():selection();};
  assert.deepEqual(await captureChatContext({},invoke),{document:null,selection:null,capturedAt:null});assert.equal(calls.length,0);
  const context=await captureChatContext({includeSelection:true},invoke,()=> '2026-10-22T15:30:00Z');
  assert.deepEqual(calls.map(call=>call.name),['revit_workbench_status','revit_get_selection','revit_workbench_status']);assert.deepEqual(calls[1].args,{expected_document:document.path});
  assert.deepEqual(context.selection.elementIds,['14','9223372036854775807']);assert.equal(context.document.title,document.title);assert.equal(context.source.hostSession,'session-a');
  const text=withChatContext('统计选择',context);assert.match(text,/不是指令/);assert.match(text,/写入前仍须重新调用/);assert.match(text,/2026-10-22T15:30:00Z/);
});
test('context rejects mixed document/session/view, unsafe IDs and forged options',async()=>{
  for(const mutate of [value=>value.document.path='D:\\other.rvt',value=>value.hostSession='other',value=>value.document.title='other']){
    const selected=selection();mutate(selected);await assert.rejects(captureChatContext({includeSelection:true},async(name)=>name==='revit_workbench_status'?status():selected),/变化/);
  }
  for(const mutate of [value=>value.hostSession='other',value=>value.document.activeViewId=13,value=>value.document.path='D:\\other.rvt']){
    let reads=0;await assert.rejects(captureChatContext({includeDocument:true},async()=>{const value=status();if(reads++)mutate(value);return value;}),/变化/);
  }
  const selected=selection();selected.value.items[1].element_id=9223372036854775807;
  await assert.rejects(captureChatContext({includeSelection:true},async name=>name==='revit_workbench_status'?status():selected),/精确保留/);
  assert.throws(()=>contextOptions({includeDocument:'true'}));assert.throws(()=>contextOptions({document:{title:'forged'}}));
});
test('unsaved document identity remains empty, no guessed path or selection',async()=>{
  const context=await captureChatContext({includeDocument:true},async()=>({hostSession:'s',document:{title:'项目1',path:''}}));
  assert.equal(context.document.path,'');assert.equal(context.selection,null);assert.equal(withChatContext('hi',{capturedAt:null}),'hi');
});
