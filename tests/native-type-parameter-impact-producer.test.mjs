import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeTypeParameterImpactProducer} from '../test-support/native-type-parameter-impact-producer.mjs';
import {assertNativeParameterQueryResult} from '../lib/native-parameter-queries.mjs';

const typeId='9223372036854775806',parameterId='-123',args={type_id:typeId,parameter_id:parameterId};
test('actual type-parameter impact producer proves bounded direct references without model writes',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeTypeParameterImpactProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  function unchanged(result,input){assert.equal(result.facts.sourceFactsUnchanged,true);assert.equal(result.facts.modifiedBefore,result.facts.modifiedAfter);assert.equal(result.facts.modifiedAfter,input.noDocument?null:Boolean(input.modifiedBefore));assert.equal(result.facts.setterApisAvailable,false);assert.equal(result.facts.transactionApisAvailable,false);}
  async function query(input={}){const request={...input,args:input.args??args},result=await produce(request);assert.equal(result.ok,true,JSON.stringify(result.error));if(!input.legacySingle)assertNativeParameterQueryResult('revit_get_type_parameter_impact',result.value,request.args);unchanged(result,input);return result;}
  async function fail(input,pattern){const result=await produce({...input,args:input.args??args});assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.value,null);assert.equal(result.error.type,'InvalidOperationException');if(pattern)assert.match(result.error.message,pattern);unchanged(result,input);return result;}
  await t.test('an unused explicit ElementType reports zero instances and grants no write authorization',async()=>{
    const result=await query(),value=result.value;assert.deepEqual(Object.keys(value).sort(),['coverage','instance_count','instance_ids','parameter','schema_version','type_id','type_name','write_authorization']);assert.equal(value.schema_version,1);assert.equal(value.type_id,typeId);assert.equal(value.type_name,'类型影响中文');assert.equal(value.parameter.parameter_id,parameterId);assert.deepEqual(value.instance_ids,[]);assert.equal(value.instance_count,0);assert.deepEqual(value.coverage,{complete:true,scope:'current_document_direct_type_references',scanned_elements:0,indirect_effects:'not_assessed'});assert.equal(value.write_authorization,'not_granted');assert.equal(result.facts.parameterScanned,1);
  });
  await t.test('all current-document non-types are scanned while only exact direct type references are returned',async()=>{
    const result=await query({instanceCount:3,candidateCount:8});assert.deepEqual(result.value.instance_ids,['9007199254740000','9007199254740001','9007199254740002']);assert.equal(result.value.instance_count,3);assert.equal(result.value.coverage.scanned_elements,8);assert.equal(result.facts.elementScanned,8);assert.equal(result.facts.parameterScanned,1);
    for(const nonpositiveReference of [-1,0,-200]){const noType=await query({nonpositiveReference});assert.equal(noType.value.instance_count,0);assert.equal(noType.value.coverage.scanned_elements,1);}
  });
  await t.test('instance IDs remain precise strings sorted numerically instead of lexicographically',async()=>{
    const result=await query({instanceIds:['9223372036854775807','10','9007199254740993','2']});assert.deepEqual(result.value.instance_ids,['2','10','9007199254740993','9223372036854775807']);assert.equal(result.value.instance_count,4);assert.equal(result.value.coverage.scanned_elements,4);
  });
  await t.test('type and parameter Int64 extrema remain exact, with no instance-to-type resolution',async()=>{
    const result=await query({typeId:'9223372036854775807',parameterId:'-9223372036854775808',args:{type_id:'9223372036854775807',parameter_id:'-9223372036854775808'}});assert.equal(result.value.type_id,'9223372036854775807');assert.equal(result.value.parameter.parameter_id,'-9223372036854775808');
    await fail({instanceCount:1,args:{type_id:'9007199254740000',parameter_id:parameterId}},/ElementType/);
    await fail({args:{element_id:'9007199254740000',parameter_id:parameterId}},/Unknown argument/);
  });
  await t.test('parameter facts reuse the original descriptor for every storage kind',async()=>{
    for(const storage of ['Double','Integer','String','None','ElementId']){
      const impact=await query({storage}),single=await query({storage,legacySingle:true,args:{element_id:typeId,parameter_id:parameterId}});assert.deepEqual(impact.value.parameter,single.value.parameter);
    }
    const length=await query();assert.equal(length.value.parameter.value_internal,2);assert.equal(length.value.parameter.value_display,'609.6 mm');assert.equal(length.value.parameter.unit_type,'length');
    const reference=await query({storage:'ElementId'});assert.equal(reference.value.parameter.value_internal,'9007199254740995');
  });
  await t.test('empty strings, missing values, assigned raw null, readonly flags and null type names are preserved',async()=>{
    const empty=await query({storage:'String',parameterValue:''});assert.equal(empty.value.parameter.has_value,true);assert.equal(empty.value.parameter.value_internal,'');assert.equal(empty.value.parameter.value_display,'');
    const missing=await query({storage:'String',parameterValue:null,hasValue:false});assert.equal(missing.value.parameter.has_value,false);assert.equal(missing.value.parameter.value_internal,null);
    const assignedNull=await query({storage:'String',parameterValue:null,hasValue:true});assert.equal(assignedNull.value.parameter.has_value,true);assert.equal(assignedNull.value.parameter.value_internal,null);
    const readOnly=await query({readOnly:true,nullName:true,modifiedBefore:true});assert.equal(readOnly.value.parameter.is_read_only,true);assert.equal(readOnly.value.type_name,null);assert.equal(readOnly.facts.modifiedAfter,true);
  });
  await t.test('500 direct instances can be published completely',async()=>{const result=await query({instanceCount:500});assert.equal(result.value.instance_ids.length,500);assert.equal(result.value.coverage.scanned_elements,500);});
  await t.test('501 direct instances fail without publishing a partial dependency set',async()=>{const result=await fail({instanceCount:501},/exceeds 500/);assert.equal(result.facts.elementScanned,501);});
  await t.test('parameter scans and candidate scans share one 20000-entry budget',async()=>{
    const complete=await query({parameterCount:2000,candidateCount:18000});assert.equal(complete.value.coverage.scanned_elements,18000);assert.equal(complete.facts.parameterScanned,2000);assert.equal(complete.facts.elementScanned,18000);
    const exceeded=await fail({parameterCount:2000,candidateCount:18001},/scan\/time budget/);assert.equal(exceeded.facts.parameterScanned,2000);assert.equal(exceeded.facts.elementScanned,18001);
  });
  await t.test('the parameter selector itself stays capped at 2000 and rejects duplicate identities',async()=>{
    await fail({parameterCount:2001},/exceeds 2000/);await fail({duplicateParameter:true},/Duplicate parameter identity/);await fail({parameterCount:0},/not found/);
  });
  await t.test('response and string budgets refuse large facts rather than truncating instances',async()=>{
    await fail({storage:'String',parameterValue:'字'.repeat(16001)},/string exceeds budget/);
    await fail({storage:'String',parameterValue:'字'.repeat(14000),instanceCount:500},/response\/time budget/);
  });
  await t.test('the real five-second budget covers parameter enumeration',async()=>{await fail({parameterTimeout:true},/scan\/time budget/);});
  await t.test('the real five-second budget covers current-document candidate enumeration',async()=>{await fail({collectorTimeout:true,instanceCount:1},/scan\/time budget/);});
  for(const flag of ['missingType','wrongType','invalidType','typeWrongDocument','wrongReturnedId','nullReturnedId'])await t.test('invalid explicit type '+flag+' is refused',async()=>{await fail({[flag]:true},/ElementType/);});
  for(const owner of ['null','instance','otherType','otherDocument','invalid'])await t.test('parameter owner '+owner+' is refused',async()=>{await fail({owner},/owned.*ElementType/);});
  for(const candidateFault of ['nullId','zeroId','negativeId','sameAsType','invalid','otherDocument','nullDocument','nullGetTypeId','getTypeIdThrows'])await t.test('unprovable candidate '+candidateFault+' cannot yield complete coverage',async()=>{await fail({candidateFault},/complete type impact|GetTypeId failure/);});
  for(const collectorFault of ['duplicate','null','type'])await t.test('collector '+collectorFault+' cannot yield complete coverage',async()=>{await fail({instanceCount:2,collectorFault},/complete type impact/);});
  await t.test('invalid selectors, fields and operations fail without widening scope or authorization',async()=>{
    await fail({noDocument:true},/Open a Revit document/);await fail({args:{type_id:typeId}},/selector/);
    for(const type_id of [0,-1,'01','-1','9223372036854775808',9007199254740992])await fail({args:{type_id,parameter_id:parameterId}},/ElementId/);
    for(const parameter_id of [0,-1,'0','-1','-0','01','-01','+1','-9223372036854775809','9223372036854775808',9007199254740992])await fail({args:{type_id:typeId,parameter_id}},/id|ElementId/i);
    for(const extra of [{parameter_name:'类型参数中文'},{value:3},{ack:true},{view_id:'123'}])await fail({args:{...args,...extra}},/Unknown argument/);
    await fail({operation:'set_type_parameter'},/Unknown native parameter query/);
  });
});
