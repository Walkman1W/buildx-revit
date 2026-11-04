import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {loadNativeModelQueryProducer} from './test-support/native-model-query-producer.mjs';
import {assertNativeModelQueryResult,NATIVE_MODEL_QUERY_CATEGORY_ALIASES} from './lib/native-model-queries.mjs';

test('actual native C# query and parameter producers preserve bounded model semantics',{skip:process.platform!=='win32'},async t=>{
  const produce=await loadNativeModelQueryProducer(t);
  t.diagnostic(JSON.stringify(produce.sourceEvidence));
  async function query(operation,args={},flags={}){const result=await produce({operation,args,...flags});assert.equal(result.ok,true,result.error);assertNativeModelQueryResult('revit_'+operation,result.value,args);return result.value;}
  await t.test('health supports no document and document facts carry the active view',async()=>{
    assert.deepEqual(await query('health',{}, {noDocument:true}),{schema_version:1,status:'no_document',document_open:false});
    assert.equal((await query('health')).document_open,true);
    const document=await query('get_document_info');assert.equal(document.title,'Query fixture');assert.equal(document.active_view.id,'2001');
    const missing=await produce({operation:'get_document_info',noDocument:true});assert.equal(missing.ok,false);assert.match(missing.error,/Open a Revit document/);
  });
  await t.test('views retain template facts and sorted pagination',async()=>{
    const page=await query('list_views',{offset:0,limit:3});assert.equal(page.total,20);assert.equal(page.items[0].is_template,true);assert.deepEqual(page.items.map(row=>row.id),['2000','2001','2002']);assert.equal(page.has_more,true);
  });
  await t.test('the collector scans beyond 500, then pages stable exact type identities',async()=>{
    const args={category:'Walls',type_id:'100',offset:500,limit:100,fields:['name','category','type_id']};
    const page=await query('get_elements_by_type',args);assert.equal(page.total,650);assert.equal(page.items.length,100);assert.equal(page.items[0].id,'10500');assert.equal(page.items[99].id,'10599');assert.equal(page.coverage.complete,true);assert.ok(page.coverage.scanned>=650);assert.equal(page.items[0].category.built_in_category,'OST_Walls');assert.deepEqual(Object.keys(page.items[0]).sort(),['id','name','category','type_id'].sort());
    const tail=await query('get_elements_by_type',{...args,offset:640,limit:100});assert.equal(tail.items.length,10);assert.equal(tail.has_more,false);
  });
  await t.test('category, type and level predicates combine without name guessing',async()=>{
    const args={category:'OST_Doors',type_id:101,level:'L1',fields:['level','type_id'],limit:500};
    const doors=await query('get_elements_by_type',args);assert.equal(doors.total,65);assert.equal(doors.items[0].level.id,'1');
    const ids=await query('get_elements_by_type',{category:'Walls',type_id:100,level_id:2,fields:[],limit:500});assert.equal(ids.total,325);assert.deepEqual(Object.keys(ids.items[0]),['id']);
    const ambiguous=await produce({operation:'get_elements_by_type',args:{level:'L1'},duplicateLevel:true});assert.equal(ambiguous.ok,false);assert.match(ambiguous.error,/ambiguous/);
    const selected=await query('get_elements_by_type',{category:'Walls',type_id:100,level:'L1',level_id:2,fields:['level'],limit:500},{duplicateLevel:true});assert.equal(selected.total,325);
    for(const args of [{category:'墙'},{type_id:1},{level:'missing'},{level:'L2',level_id:1}])assert.equal((await produce({operation:'get_elements_by_type',args})).ok,false);
  });
  await t.test('geometry uses exact 64-bit identity, world-transformed corners and explicit units',async()=>{
    const result=await query('get_element_geometry',{element_id:'9007199254740993'});assert.equal(result.element_id,'9007199254740993');assert.equal(result.location.point_mm.x,304.8);assert.ok(Math.abs(result.bounding_box.min_mm.x-4*304.8)<1e-8);assert.ok(Math.abs(result.bounding_box.max_mm.x-8*304.8)<1e-8);assert.ok(Math.abs(result.bounding_box.min_mm.y-21*304.8)<1e-8);assert.equal(result.length.value,609.6);assert.ok(Math.abs(result.area.value-0.9290304)<1e-10);assert.ok(Math.abs(result.volume.value-2.8316846592)<1e-10);assert.equal(result.unavailable.length,null);
    const missing=await query('get_element_geometry',{element_id:10000});assert.equal(missing.location,null);assert.ok(missing.unavailable.location);assert.equal(missing.length,null);assert.ok(missing.unavailable.length);
  });
  await t.test('parameters reuse actual owner and preserve raw/display values and signed precise references',async()=>{
    const result=await query('get_element_parameters',{element_id:'9007199254740993'});const length=result.parameters.find(value=>value.parameter_id==='-123'),reference=result.parameters.find(value=>value.parameter_id==='9223372036854775807');
    assert.equal(length.value_internal,2);assert.equal(length.value_display,'609.6 mm');assert.equal(reference.value_internal,'9007199254740995');assert.equal(result.parameters.find(value=>value.parameter_id==='200').value_internal,null);
  });
  await t.test('unsafe IDs, absent elements and scan budgets fail without partial coverage',async()=>{
    for(const element_id of [9007199254740992,'9223372036854775808','01',0,'999'])assert.equal((await produce({operation:'get_element_geometry',args:{element_id}})).ok,false);
    const overflow=await produce({operation:'get_elements_by_type',args:{category:'Walls',fields:[],limit:1},scanOverflow:true});assert.equal(overflow.ok,false);assert.match(overflow.error,/budget exceeded/);
  });
  await t.test('C# category alias identities match the named contract owner',async()=>{
    const source=await fs.readFile(new URL('./revit-addin/NativeModelQueries.cs',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('CategoryAliases ='),source.indexOf('internal static bool IsRead'));
    const aliases=Object.fromEntries([...body.matchAll(/\{"([^"]+)","([^"]+)"\}/g)].map(match=>[match[1],match[2]]));assert.deepEqual(aliases,NATIVE_MODEL_QUERY_CATEGORY_ALIASES);
  });
});
