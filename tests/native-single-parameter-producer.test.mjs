import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeSingleParameterProducer} from '../test-support/native-single-parameter-producer.mjs';
import {assertNativeParameterQueryResult} from '../lib/native-parameter-queries.mjs';

const sourceId='9007199254740993',typeId='9223372036854775806';
test('actual C# single-parameter query selects exact identities and publishes shared read-only facts',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeSingleParameterProducer(t);t.diagnostic(JSON.stringify(produce.sourceEvidence));
  async function query(input={}){
    const args=input.args??{element_id:sourceId,parameter_id:'-123'},result=await produce({...input,args});assert.equal(result.ok,true,JSON.stringify(result.error));
    if(!input.legacyElementParameters)assertNativeParameterQueryResult('revit_get_parameter_value',result.value,args);
    assert.equal(result.facts.sourceFactsUnchanged,true);assert.equal(result.facts.modifiedBefore,Boolean(input.modifiedBefore));assert.equal(result.facts.modifiedAfter,Boolean(input.modifiedBefore));return result;
  }
  async function fail(input,pattern){
    const result=await produce(input);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.value,null);assert.equal(result.error.type,'InvalidOperationException');if(pattern)assert.match(result.error.message,pattern);assert.equal(result.facts.sourceFactsUnchanged,true);assert.equal(result.facts.modifiedBefore,result.facts.modifiedAfter);return result;
  }
  await t.test('signed parameter id selects one of two same-named parameters without rounding IDs',async()=>{
    const result=await query(),value=result.value;assert.deepEqual(Object.keys(value).sort(),['element_id','element_name','parameter','schema_version']);assert.equal(value.element_id,sourceId);assert.equal(value.element_name,'实例中文');assert.equal(value.parameter.parameter_id,'-123');assert.equal(value.parameter.storage_type,'Double');assert.equal(value.parameter.value_internal,2);assert.equal(value.parameter.value_display,'609.6 mm');assert.equal(value.parameter.unit_type,'length');assert.equal(result.facts.scanned,9);
    const numeric=await query({args:{element_id:sourceId,parameter_id:-123}});assert.deepEqual(numeric.value,value);
  });
  await t.test('canonical Int64 maximum and minimum parameter IDs preserve exact facts',async()=>{
    const positive=await query({args:{element_id:sourceId,parameter_id:'9223372036854775807'}});assert.equal(positive.value.parameter.parameter_id,'9223372036854775807');assert.equal(positive.value.parameter.value_internal,'9007199254740995');assert.equal(positive.value.parameter.storage_type,'ElementId');
    const negative=await query({args:{element_id:sourceId,parameter_id:'-9223372036854775808'}});assert.equal(negative.value.parameter.parameter_id,'-9223372036854775808');assert.equal(negative.value.parameter.value_internal,'负ID');
  });
  await t.test('forced Double safe-integer bounds preserve every digit in shared source and signed parameter parsing',async()=>{
    for(const id of ['9007199254740991','-9007199254740991']){
      const parameters=[{id,name:'Double边界',value:'精确值'}],args={element_id:'9007199254740991',parameter_id:id};
      const result=await query({sourceId:'9007199254740991',parameters,args,elementIdAsDouble:true,parameterIdAsDouble:true});assert.equal(result.facts.elementIdRuntimeType,'Double');assert.equal(result.facts.parameterIdRuntimeType,'Double');assert.equal(result.value.element_id,'9007199254740991');assert.equal(result.value.parameter.parameter_id,id);
    }
    for(const parameter_id of ['9007199254740992','-9007199254740992','1.5'])await fail({args:{element_id:sourceId,parameter_id},parameterIdAsDouble:true},/ElementId|integer|precise/i);
    for(const element_id of ['9007199254740992','-9007199254740991','1.5'])await fail({args:{element_id,parameter_id:-123},elementIdAsDouble:true},/ElementId|integer|precise/i);
    for(const mode of ['nan','infinity','negativeInfinity']){
      await fail({args:{element_id:sourceId,parameter_id:-123},parameterIdAsDouble:mode},/ElementId|integer|precise/i);
      await fail({args:{element_id:sourceId,parameter_id:-123},elementIdAsDouble:mode},/ElementId|integer|precise/i);
    }
  });
  await t.test('exact names preserve spaces, case and Unicode without name guessing',async()=>{
    for(const [parameter_name,expected] of [[' Name ','空格保留'],['name','小写'],['精确负参数','负ID']]){const result=await query({args:{element_id:sourceId,parameter_name}});assert.equal(result.value.parameter.name,parameter_name);assert.equal(result.value.parameter.value_internal,expected);}
    for(const parameter_name of ['Name','NAME',' name ','精确负参数 '])await fail({args:{element_id:sourceId,parameter_name}},/not found/);
    const parameters=[{id:1,name:'é',value:'composed'},{id:2,name:'e\u0301',value:'decomposed'}];
    for(const [parameter_name,expected] of [['é','composed'],['e\u0301','decomposed']]){const result=await query({parameters,args:{element_id:sourceId,parameter_name}});assert.equal(result.value.parameter.value_internal,expected);}
  });
  await t.test('single facts match the existing descriptor byte-for-byte for every storage kind',async()=>{
    const legacy=await query({legacyElementParameters:true,args:{element_id:sourceId}});
    for(const parameter_id of ['-123','200','201','-200','-300','9223372036854775807','-9223372036854775808']){
      const result=await query({args:{element_id:sourceId,parameter_id}});assert.deepEqual(result.value.parameter,legacy.value.parameters.find(row=>row.parameter_id===parameter_id));
    }
    const empty=await query({args:{element_id:sourceId,parameter_id:200}});assert.equal(empty.value.parameter.has_value,true);assert.equal(empty.value.parameter.value_internal,'');assert.equal(empty.value.parameter.value_display,'');
    const missing=await query({args:{element_id:sourceId,parameter_id:201}});assert.equal(missing.value.parameter.has_value,false);assert.equal(missing.value.parameter.value_internal,null);assert.equal(missing.value.parameter.value_display,null);
    const readOnly=await query({args:{element_id:sourceId,parameter_id:-200}});assert.equal(readOnly.value.parameter.is_read_only,true);assert.equal(readOnly.value.parameter.value_internal,1);
  });
  await t.test('direct type input reads its own parameters while an instance never falls back to its type',async()=>{
    const direct=await query({args:{element_id:typeId,parameter_id:301}});assert.equal(direct.value.element_id,typeId);assert.equal(direct.value.parameter.value_internal,'type value');assert.equal(direct.facts.scanned,1);
    for(const selector of [{parameter_id:301},{parameter_name:'仅类型存在'}])await fail({args:{element_id:sourceId,...selector}},/not found/);
  });
  await t.test('null element name and an already-modified document preserve original state',async()=>{
    const result=await query({nullName:true,modifiedBefore:true});assert.equal(result.value.element_name,null);assert.equal(result.facts.modifiedAfter,true);
  });
  await t.test('unselected unreadable values are never read or interpreted',async()=>{
    const result=await query({unreadableUnrelatedValue:true});assert.equal(result.value.parameter.value_internal,2);assert.equal(result.facts.scanned,10);
    const named=await query({unreadableUnrelatedValue:true,args:{element_id:sourceId,parameter_name:'只读整数'}});assert.equal(named.value.parameter.value_internal,1);
  });
  await t.test('ambiguous names and every duplicate identity fail explicitly',async()=>{
    await fail({args:{element_id:sourceId,parameter_name:'同名参数'}},/ambiguous/);
    await fail({args:{element_id:sourceId,parameter_id:-123},lateDuplicateId:true},/Duplicate parameter identity/);
    await fail({args:{element_id:sourceId,parameter_name:' Name '},lateDuplicateId:true},/Duplicate parameter identity/);
    await fail({args:{element_id:sourceId,parameter_id:-123},lateUnrelatedDuplicateId:true},/Duplicate parameter identity/);
  });
  await t.test('matches near the beginning still scan to the end and detect late ambiguities',async()=>{
    const parameters=Array.from({length:2000},(_,index)=>({id:index+1,name:index===0||index===1999?'唯一目标':'其他'+index,value:'值'}));
    const result=await fail({parameters,args:{element_id:sourceId,parameter_name:'唯一目标'}},/ambiguous/);assert.equal(result.facts.scanned,2000);
    const success=await query({parameterCount:2000,args:{element_id:sourceId,parameter_id:1}});assert.equal(success.facts.scanned,2000);assert.equal(success.value.parameter.parameter_id,'1');
  });
  await t.test('the 2001st parameter rejects even after an early unique match',async()=>{
    const result=await fail({parameterCount:2001,args:{element_id:sourceId,parameter_id:1}},/exceeds 2000/);assert.equal(result.facts.scanned,2001);
  });
  await t.test('scan-time and selected string/response budgets fail without partial facts',async()=>{
    await fail({scanTimeout:true,args:{element_id:sourceId,parameter_id:-123}},/scan\/time budget/);
    await fail({parameters:[{id:1,name:'长文本',value:'字'.repeat(16001)}],args:{element_id:sourceId,parameter_id:1}},/string exceeds budget/);
    await fail({parameters:[{id:1,name:'x'.repeat(16000),value:'字'.repeat(16000)}],args:{element_id:sourceId,parameter_id:1}},/response\/time budget/);
  });
  await t.test('missing selectors, both selectors and malformed exact names reject',async()=>{
    await fail({args:{element_id:sourceId}},/Exactly one/);
    await fail({args:{element_id:sourceId,parameter_id:-123,parameter_name:'同名参数'}},/Exactly one/);
    for(const parameter_name of ['',null,1,true,{},'字'.repeat(1025)])await fail({args:{element_id:sourceId,parameter_name}},/exact string/);
    const name='字'.repeat(1024),result=await query({parameters:[{id:1,name,value:'界限'}],args:{element_id:sourceId,parameter_name:name}});assert.equal(result.value.parameter.name,name);
  });
  await t.test('invalid and unsafe signed selectors never coerce, trim, round or overflow',async()=>{
    for(const parameter_id of [0,-1,'0','-1','-0','00','01','-01','+1',' 1','1 ','1.0','1e2','１','9223372036854775808','-9223372036854775809',9007199254740992,-9007199254740992,1.5,null,true,{},[]])await fail({args:{element_id:sourceId,parameter_id}},/parameter|ElementId|integer|precise/i);
  });
  await t.test('matched invalid parameter identities cannot be published through a name selector',async()=>{
    for(const extra of [{id:0},{id:-1},{id:1,nullId:true}])await fail({parameters:[{name:'无效身份',value:'值',...extra}],args:{element_id:sourceId,parameter_name:'无效身份'}},/valid parameter identity/);
  });
  await t.test('wrong source, empty parameter sets, unknown fields and unknown operations reject',async()=>{
    for(const flag of ['missingSource','invalidSource'])await fail({[flag]:true,args:{element_id:sourceId,parameter_id:-123}},/Source element/);
    await fail({noDocument:true,args:{element_id:sourceId,parameter_id:-123}},/Open a Revit document/);
    await fail({parameters:[],args:{element_id:sourceId,parameter_id:-123}},/not found/);
    await fail({args:{element_id:sourceId,parameter_id:-123,scope:'type'}},/Unknown argument/);
    await fail({args:{element_id:sourceId,parameter_id:-123},operation:'set_parameter_value'},/Unknown native parameter query/);
    await fail({args:{element_id:sourceId,parameter_id:-123},operation:'get_type_parameters'},/Unknown argument/);
    for(const element_id of [0,-1,'01','-1','9223372036854775808',9007199254740992])await fail({args:{element_id,parameter_id:-123}},/ElementId/);
  });
});
