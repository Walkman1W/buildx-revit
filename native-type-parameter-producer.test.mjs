import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeTypeParameterProducer} from './test-support/native-type-parameter-producer.mjs';
import {assertNativeParameterQueryResult} from './lib/native-parameter-queries.mjs';

const sourceId='9007199254740993',typeId='9223372036854775806';
test('actual C# type parameter query resolves exact identities and reuses bounded parameter facts without mutation',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  async function query(input={}){const args=input.args??{element_id:sourceId},result=await produce({args,...input});assert.equal(result.ok,true,JSON.stringify(result.error));if(!input.legacyElementParameters)assertNativeParameterQueryResult('revit_get_type_parameters',result.value,args);assert.equal(result.facts.sourceFactsUnchanged,true);assert.equal(result.facts.modifiedBefore,true);assert.equal(result.facts.modifiedAfter,true);return result.value;}
  async function fail(input,pattern){const result=await produce(input);assert.equal(result.ok,false);assert.equal(result.value,null);assert.equal(result.error.type,'InvalidOperationException');if(pattern)assert.match(result.error.message,pattern);assert.equal(result.facts.sourceFactsUnchanged,true);return result;}
  await t.test('instance lookup returns the actual type instead of same-named instance parameters',async()=>{
    const value=await query();assert.equal(value.schema_version,1);assert.equal(value.element_id,sourceId);assert.equal(value.type_id,typeId);assert.equal(value.source_is_type,false);assert.equal(value.element_name,'实例参数不同');assert.equal(value.type_name,'共享类型中文');
    const length=value.parameters.find(row=>row.parameter_id==='-123');assert.equal(length.value_internal,2);assert.equal(length.value_display,'609.6 mm');assert.equal(length.unit_type,'length');assert.equal(length.name,'同名参数');
    const reference=value.parameters.find(row=>row.parameter_id==='9223372036854775807');assert.equal(reference.value_internal,'9007199254740995');assert.equal(reference.storage_type,'ElementId');
    assert.deepEqual(value.parameters.filter(row=>row.name==='同名参数').map(row=>row.parameter_id),['-123','200']);
  });
  await t.test('direct ElementType input resolves itself and preserves identical legacy fact rows',async()=>{
    const direct=await query({args:{element_id:typeId}}),through=await query();assert.equal(direct.source_is_type,true);assert.equal(direct.element_id,typeId);assert.equal(direct.type_id,typeId);assert.equal(direct.element_name,direct.type_name);assert.deepEqual(direct.parameters,through.parameters);
    const existing=await query({args:{element_id:typeId},legacyElementParameters:true});assert.deepEqual(existing.parameters,direct.parameters);
  });
  await t.test('empty, missing, read-only and null-name facts remain explicit',async()=>{
    const empty=await query({noParameters:true});assert.deepEqual(empty.parameters,[]);
    const value=await query({nullNames:true});assert.equal(value.element_name,null);assert.equal(value.type_name,null);
    const missing=value.parameters.find(row=>row.parameter_id==='201');assert.equal(missing.has_value,false);assert.equal(missing.value_internal,null);assert.equal(missing.value_display,null);
    const text=value.parameters.find(row=>row.parameter_id==='200');assert.equal(text.has_value,true);assert.equal(text.value_internal,'');assert.equal(text.value_display,'');
    const readOnly=value.parameters.find(row=>row.parameter_id==='-200');assert.equal(readOnly.is_read_only,true);assert.equal(readOnly.value_internal,1);assert.equal(readOnly.value_display,'是');
  });
  await t.test('no type, stale types, invalid targets and self-reference never fall back to instance facts',async()=>{
    for(const flag of ['noType','nullType','missingType','wrongTypeKind','invalidType','selfType','invalidSource'])await fail({args:{element_id:sourceId},[flag]:true},/Source|instance/);
    await fail({args:{element_id:sourceId},noDocument:true},/Open a Revit document/);
  });
  await t.test('invalid precise IDs and unknown parameter operations/fields reject before publishing facts',async()=>{
    for(const element_id of [0,-1,1.5,9007199254740992,'01','9223372036854775808','-1','100'])await fail({args:{element_id}},/ElementId|Source element/);
    await fail({args:{}},/Missing argument/);await fail({args:{element_id:sourceId,type_id:typeId}},/Unknown argument/);
    await fail({operation:'set_type_parameter',args:{element_id:sourceId}},/Unknown native parameter query/);
  });
  await t.test('the shared parameter count, string and response budgets fail without partial rows',async()=>{
    await fail({args:{element_id:sourceId},parameterOverflow:true},/exceeds 2000 parameters/);
    await fail({args:{element_id:sourceId},stringOverflow:true},/string exceeds budget/);
    await fail({args:{element_id:sourceId},responseOverflow:true},/response\/time budget exceeded/);
  });
});
