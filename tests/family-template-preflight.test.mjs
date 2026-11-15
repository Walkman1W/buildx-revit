import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFamilyTemplateBytePreflight} from '../lib/family-template-preflight.mjs';

const generic={template_id:'metric-generic-model',state:'BytesVerified',issue:'None',
  bytes:12345,sha256:'abcdef0123456789'.repeat(4),native_format_validated:false};
const mechanical={...generic,template_id:'metric-mechanical-equipment'};
const receipt=templates=>({operation:'family_templates',hostSession:'host-session',
  value:{success:true,value:{templates}}});

test('production receipt verifies required template bytes without claiming native compatibility',()=>{
  const input=receipt([mechanical,{...generic}]);
  const before=structuredClone(input);
  const result=assertFamilyTemplateBytePreflight(input);
  assert.equal(result.template_id,generic.template_id);
  assert.equal(result.bytes,generic.bytes);
  assert.equal(result.sha256,generic.sha256);
  assert.equal(result.bytes_verified,true);
  assert.equal(result.verification_scope,'template_bytes_only');
  assert.equal(result.native_format_validated,false);
  assert.equal(result.category_validated,false);
  assert.equal(result.connector_suitability_validated,false);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(input,before);
});

test('required template absence is rejected even when the list operation succeeded',()=>{
  for(const templates of [[],[mechanical],[null],undefined,{}])
    assert.throws(()=>assertFamilyTemplateBytePreflight(receipt(templates)),/preflight failed/);
});

test('missing, rejected and unknown template observations cannot pass as byte readiness',()=>{
  for(const [state,issue] of [['NotFound','MissingFile'],['Rejected','ReparsePoint'],
    ['Unknown','ReadFailure'],['Unknown','CleanupFailure'],['Changed','FileChanged'],
    ['TooLarge','OverBudget'],['BytesVerified','ReadFailure']])
    assert.throws(()=>assertFamilyTemplateBytePreflight(receipt([{...generic,state,issue}])),/byte evidence was not verified/);
});

test('invalid hashes cannot pass despite BytesVerified and None labels',()=>{
  for(const sha256 of [undefined,null,123,'','a'.repeat(63),'a'.repeat(65),'g'.repeat(64),' '+generic.sha256,generic.sha256+'\n'])
    assert.throws(()=>assertFamilyTemplateBytePreflight(receipt([{...generic,sha256}])),/SHA256 is invalid/);
  assert.equal(assertFamilyTemplateBytePreflight(receipt([{...generic,sha256:generic.sha256.toUpperCase()}])).sha256,generic.sha256.toUpperCase());
});

test('missing, empty or malformed byte lengths remain unverified',()=>{
  for(const bytes of [undefined,null,0,-1,1.5,'12345',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>assertFamilyTemplateBytePreflight(receipt([{...generic,bytes}])),/byte length or SHA256 is invalid/);
});

test('ambiguous target and unsuccessful or mismatched envelopes are rejected',()=>{
  assert.throws(()=>assertFamilyTemplateBytePreflight(receipt([{...generic},{...generic}])),/no unique observation/);
  for(const input of [undefined,null,{}, {...receipt([generic]),operation:'family_create_valve'},
    {...receipt([generic]),value:{success:false,value:{templates:[generic]}}}])
    assert.throws(()=>assertFamilyTemplateBytePreflight(input),/observation was not confirmed/);
});
