import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCreatedElementLedger} from './lib/created-elements.mjs';

const document={session:'f'.repeat(32),title:'Door sample',path:'D:\\samples\\doors.rvt'};
const scope={account:'door-owner',conversationId:'door-conversation'};
const receipt=(patch={})=>({request_id:randomUUID(),mode:'commit',committed:true,document:document.title,value:{created_ids:[23],readback:{element_id:23,wall_id:12,symbol_id:34,level_id:56}},...patch});

test('door creation ledger records only producer-created IDs, never the existing host/type/level',()=>{
  const ledger=createCreatedElementLedger(),result=receipt();
  const record=ledger.record('revit_place_door',result,document,scope);
  assert.deepEqual(record.element_ids,[23]);
  assert.equal(record.valid_for_inspection,true);
  assert.equal(ledger.resolve(result.request_id,document,scope),record);
  for(const value of [{readback:result.value.readback},{created_ids:[0]},{created_ids:[23,23]},{created_ids:['23']},{created_ids:[Number.MAX_SAFE_INTEGER+1]}])assert.equal(ledger.record('revit_place_door',receipt({value}),document,scope),null);
  assert.equal(ledger.record('revit_execute_csharp',result,document,scope),null);
});

test('door creation IDs preserve rollback and exact account/conversation/document scope',()=>{
  const ledger=createCreatedElementLedger(),rolledBack=receipt({mode:'rollback',committed:false});
  assert.equal(ledger.record('revit_place_door',rolledBack,document,scope).valid_for_inspection,false);
  assert.throws(()=>ledger.resolve(rolledBack.request_id,document,scope),/已回滚/);
  const result=receipt();ledger.record('revit_place_door',result,document,scope);
  for(const foreign of [{...scope,account:'other'},{...scope,conversationId:'other'}])assert.throws(()=>ledger.resolve(result.request_id,document,foreign),/当前账号、对话/);
  for(const foreign of [{...document,session:'a'.repeat(32)},{...document,path:'D:\\samples\\other.rvt'}])assert.throws(()=>ledger.resolve(result.request_id,foreign,scope),/当前账号、对话/);
  assert.equal(ledger.record('revit_place_door',receipt({mode:'commit',committed:false}),document,scope),null);
  assert.equal(ledger.record('revit_place_door',receipt({document:'other'}),document,scope),null);
});
