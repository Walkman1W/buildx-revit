import test from 'node:test';
import assert from 'node:assert/strict';
import {formatLevelElevation as format,formatDisplayValue,modelCommandPresentation} from '../public/model-workspace.mjs';
test('level millimetres have two decimals without negative zero',()=>{
 for(const [value,expected] of [[2999.999999999,'3000.00'],[1.234567,'1.23'],[-1.234567,'-1.23'],[1.2,'1.20'],[0,'0.00'],[-0,'0.00'],[-0.000001,'0.00'],[123456.123456,'123456.12']])assert.equal(format(value),expected);
 for(const value of [NaN,Infinity,null,undefined,'12.345678'])assert.equal(format(value),'—');
});
test('level formatting preserves raw value, unit and unrelated identity values',()=>{
 const raw=2999.999999999;const data={items:[{name:'L1',elevation_mm:raw}],total:1};const before=structuredClone(data);
 const view=modelCommandPresentation({commandId:'levels',status:'completed',result:{data}});
 assert.deepEqual(view.rows,[['L1','3000.00']]);assert.deepEqual(view.columns,['名称','高程（mm）']);assert.deepEqual(data,before);
});

test('general scalar display rounds measurements, not ids, counts or raw internal values',()=>{
 assert.equal(formatDisplayValue(12.34567,'width_mm'),'12.35');
 assert.equal(formatDisplayValue(-0.0001,'area_m2'),'0.00');
 assert.equal(formatDisplayValue(9007199254740991,'element_id'),'9007199254740991');
 assert.equal(formatDisplayValue(7,'count'),'7');
 assert.equal(formatDisplayValue(1.23456789,'value_internal'),'1.23456789');
 assert.equal(formatDisplayValue('00123','code'),'00123');
});
