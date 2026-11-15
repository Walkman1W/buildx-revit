import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMcpResult} from '../lib/chat-session.mjs';
import {parsePublicToolResult} from '../test-support/public-tool-result.mjs';
import {parseCardResult} from '../test-support/live-dialogue-receipt.mjs';

const payload={operation:'list_levels',value:{items:[{element_id:30,name:'L1',elevation_mm:0,project_elevation_mm:0}]}};
const card=result=>({name:'revit_list_levels',status:'returned',error:'',resultPreview:previewMcpResult(result)});
const result=()=>({content:[{type:'text',text:JSON.stringify(payload)}]});

test('single text JSON uses the actual public preview producer and the live verifier parser',()=>{
  const input=card(result());
  assert.deepEqual(parseCardResult(input),payload);
  const parsed=parsePublicToolResult(input);
  assert.equal(parsed.format,'text_json');assert.deepEqual(parsed.structuredContent,{present:false});
});

test('an explicit null structured block remains separate from text JSON',()=>{
  const input=card({...result(),structuredContent:null});
  assert.deepEqual(parseCardResult(input),payload);
  const parsed=parsePublicToolResult(input);
  assert.equal(parsed.format,'text_json_and_null_structuredContent');
  assert.deepEqual(parsed.structuredContent,{present:true,value:null});
});

test('unknown, non-null, repeated or extra tail blocks are rejected',()=>{
  const input=card(result());
  for(const tail of ['\n\n[structuredContent]\n{}','\n\n[structuredContent]\nfalse',
    '\n\n[unknown]\nnull','\n\n[text]\n{}','\n\n[structuredContent]\nnull\nextra',
    '\n\n[structuredContent]\nnull\n\n[structuredContent]\nnull'])
    assert.throws(()=>parsePublicToolResult({...input,resultPreview:input.resultPreview+tail}),/not a complete JSON result/);
});

test('truncated previews and malformed JSON never establish a successful receipt',()=>{
  const input=card(result());
  for(const resultPreview of ['[text]\n{"value":','[text]\n{"ok":true}\n[预览已截断]',
    '[text]\n{"message":"[深层内容预览已截断]"}',
    '[text]\n'+JSON.stringify({value:'x'.repeat(1900)})])
    assert.throws(()=>parsePublicToolResult({...input,resultPreview}));
});

test('failed cards, missing text and scalar or array JSON remain unverified',()=>{
  const input=card(result());
  for(const changed of [{...input,status:'failed'},{...input,error:'reported failure'},
    {...input,resultPreview:'{"ok":true}'},{...input,resultPreview:'[text]\nnull'},
    {...input,resultPreview:'[text]\n[]'},{...input,resultPreview:'[text]\ntrue'}])
    assert.throws(()=>parsePublicToolResult(changed));
});
