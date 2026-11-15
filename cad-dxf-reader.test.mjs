import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readAsciiDxf,ASCII_DXF_LIMITS} from './lib/cad-dxf-reader.mjs';
const pairs=items=>items.map(([code,value])=>code+'\n'+value+'\n').join('');
const line=(extra=[])=>[[0,'LINE'],[8,'BX_WALL_AXIS'],[5,'AB'],[10,'1'],[20,'2'],[11,'4'],[21,'6'],...extra];
const dxf=(entities=line(),header=[[9,'$INSUNITS'],[70,4]])=>pairs([[0,'SECTION'],[2,'HEADER'],...header,[0,'ENDSEC'],[0,'SECTION'],[2,'ENTITIES'],...entities,[0,'ENDSEC'],[0,'EOF']]);
function value(input){const result=readAsciiDxf(input);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
function error(input,code){const result=readAsciiDxf(input);assert.equal(result.ok,false);assert.equal(result.error.code,code,JSON.stringify(result));}
test('a generated DXF fixture retains 8 exact WCS lines, its note entity and provenance',()=>{
  const expected=Array.from({length:8},(_,i)=>({layer:i%2?'BX_COLUMN_AXIS':'BX_WALL_AXIS',from:[150-250*i,120*i,0],to:[60+300*i,90+200*i,0]}));
  const entities=expected.flatMap(({layer,from,to},i)=>[[0,'LINE'],[5,(16+i).toString(16)],[8,layer],[10,from[0]],[20,from[1]],[11,to[0]],[21,to[1]]]);
  const input=Buffer.from(dxf([...entities,[0,'TEXT'],[5,'20'],[8,'NOTES'],[1,'Synthetic axes']]),'ascii');
  const result=readAsciiDxf(input,{sourceName:'synthetic-centerlines.dxf'});assert.equal(result.ok,true,JSON.stringify(result));
  const v=result.value;assert.deepEqual(v.coverage,{entityCount:9,lineCount:8,unsupportedCount:1,invalidLineCount:0});
  assert.deepEqual(v.units,{code:4,name:'millimetres',millimetresPerUnit:1});
  assert.equal(v.source.name,'synthetic-centerlines.dxf');assert.equal(v.source.byteLength,input.length);assert.equal(v.source.sha256,createHash('sha256').update(input).digest('hex'));
  for(let i=0;i<8;i++){
    const entity=v.entities[i],line=expected[i];
    assert.deepEqual(entity.geometry.from,line.from);assert.deepEqual(entity.geometry.to,line.to);
    assert.equal(entity.layer,line.layer);assert.deepEqual(entity.issues,[]);assert.equal(entity.ordinal,i+1);
  }
  assert.equal(v.entities[8].type,'TEXT');assert.equal(v.entities[8].geometry,null);
  assert.ok(v.entities[8].issues.some(x=>x.code==='UNSUPPORTED_ENTITY'));
  const lines=input.toString('ascii').split(/\r?\n/);
  for(const e of v.entities){assert.equal(lines[e.sourceLine-1].trim(),'0');assert.equal(lines[e.sourceLine].trim(),e.type);}
});
test('scalar coordinates require finite decimal single values; optional z is zero',()=>{
  assert.deepEqual(value(dxf()).entities[0].geometry,{kind:'line',from:[1,2,0],to:[4,6,0]});
  assert.deepEqual(value(dxf(line([[30,'-2.5e1'],[31,'+3.']]))).entities[0].geometry,{kind:'line',from:[1,2,-25],to:[4,6,3]});
  for(const bad of ['NaN','Infinity','-Infinity','1e309','0x10','','1,5','1 2']){
    const entity=value(dxf(line().map(pair=>pair[0]===10?[10,bad]:pair))).entities[0];
    assert.equal(entity.geometry,null);assert.ok(entity.issues.some(x=>x.code==='INVALID_COORDINATE'));
  }
  for(const code of [10,20,11,21]){
    const v=value(dxf(line().filter(pair=>pair[0]!==code)));assert.equal(v.coverage.lineCount,1);assert.equal(v.coverage.invalidLineCount,1);
    assert.ok(v.entities[0].issues.some(x=>x.code==='MISSING_COORDINATE'));
  }
  for(const code of [10,20,30,11,21,31]){
    const v=value(dxf(line([[code,99],[code,100]])));assert.equal(v.entities[0].geometry,null);
    assert.ok(v.entities[0].issues.some(x=>x.code==='DUPLICATE_COORDINATE'));
  }
});
test('layer/handle and paper-space uncertainty is retained without defaulting layer 0',()=>{
  const absent=value(dxf(line().filter(p=>p[0]!==8))).entities[0];assert.equal(absent.layer,null);assert.ok(absent.issues.some(x=>x.code==='MISSING_LAYER'));
  const duplicate=value(dxf(line([[8,'other']]))).entities[0];assert.equal(duplicate.layer,null);assert.ok(duplicate.issues.some(x=>x.code==='DUPLICATE_LAYER'));
  assert.equal(value(dxf()).entities[0].handle,'AB');
  assert.equal(value(dxf(line().filter(p=>p[0]!==5))).entities[0].handle,null);
  for(const p of [[[67,1]],[[410,'Layout1']]])assert.ok(value(dxf(line(p))).entities[0].issues.some(x=>x.code==='PAPER_SPACE_ENTITY'));
  assert.ok(value(dxf(line([[67,'maybe']]))).entities[0].issues.some(x=>x.code==='INVALID_SPACE'));
  assert.deepEqual(value(dxf(line([[67,0],[410,'Model']]))).entities[0].issues,[]);
});
test('units are explicit; unknown codes, unitless and missing are not assumed millimetres',()=>{
  for(const [code,name,scale] of [[1,'inches',25.4],[2,'feet',304.8],[4,'millimetres',1],[5,'centimetres',10],[6,'metres',1000]])
    assert.deepEqual(value(dxf(line(),[[9,'$INSUNITS'],[70,code]])).units,{code,name,millimetresPerUnit:scale});
  for(const code of [0,3,21,999]){const v=value(dxf(line(),[[9,'$INSUNITS'],[70,code]]));assert.deepEqual(v.units,{code,name:null,millimetresPerUnit:null});assert.ok(v.warnings.some(x=>x.code==='UNKNOWN_UNITS'));}
  const absent=value(dxf(line(),[]));assert.deepEqual(absent.units,{code:null,name:null,millimetresPerUnit:null});assert.ok(absent.warnings.some(x=>x.code==='MISSING_UNITS'));
  const noHeader=value(pairs([[0,'SECTION'],[2,'ENTITIES'],...line(),[0,'ENDSEC'],[0,'EOF']]));assert.equal(noHeader.units.code,null);
  for(const header of [[[9,'$INSUNITS']],[[9,'$INSUNITS'],[70,4],[70,4]],[[9,'$INSUNITS'],[1,4]],[[9,'$INSUNITS'],[70,'4.0']],[[9,'$INSUNITS'],[70,-1]]])
    error(dxf(line(),header),'INVALID_INSUNITS');
  error(dxf(line(),[[9,'$INSUNITS'],[70,4],[9,'$INSUNITS'],[70,4]]),'DUPLICATE_INSUNITS');
});
test('all unknown entities stay in ENTITIES inventory; BLOCKS and INSERT are not expanded',()=>{
  const v=value(dxf([...line(),[0,'INSERT'],[8,'BLOCK_LAYER'],[2,'SYMBOL'],[10,50],[20,60],[0,'ARC'],[8,'CURVES']]));
  assert.deepEqual(v.coverage,{entityCount:3,lineCount:1,unsupportedCount:2,invalidLineCount:0});
  for(const e of v.entities.slice(1)){assert.equal(e.geometry,null);assert.ok(e.issues.some(x=>x.code==='UNSUPPORTED_ENTITY'));}
  const blocks=pairs([[0,'SECTION'],[2,'BLOCKS'],[0,'BLOCK'],[2,'X'],...line(),[0,'ENDBLK'],[0,'ENDSEC'],[0,'SECTION'],[2,'ENTITIES'],[0,'INSERT'],[8,'B'],[2,'X'],[0,'ENDSEC'],[0,'EOF']]);
  const b=value(blocks);assert.equal(b.entities.length,1);assert.equal(b.entities[0].type,'INSERT');assert.ok(b.warnings.some(x=>x.code==='UNINSPECTED_SECTIONS'));
});
test('pair and group grammar failures are tagged and source line points at code',()=>{
  error('0\nSECTION\n2','ODD_LINE_COUNT');
  for(const key of ['x','-1','1.5','1072','10000','+0',''])error(key+'\nSECTION\n','INVALID_GROUP_CODE');
  const v=value(dxf().replace(/\n/g,'\r\n'));assert.equal(v.entities[0].sourceLine,15);
  assert.equal(value(dxf().replace(/\n/g,'\r')).coverage.lineCount,1);
  assert.equal(value(dxf().trimEnd()).coverage.lineCount,1);
  error({},'INVALID_INPUT');assert.equal(readAsciiDxf(dxf(),{sourceName:0}).error.code,'INVALID_SOURCE_NAME');
});
test('section ownership and EOF grammar are fail-closed',()=>{
  error(pairs([[0,'ENDSEC'],[0,'EOF']]),'UNEXPECTED_ENDSEC');
  error(pairs([[0,'SECTION'],[1,'ENTITIES']]),'INVALID_SECTION_NAME');
  error(pairs([[0,'SECTION']]),'MISSING_SECTION_NAME');
  error(pairs([[0,'SECTION'],[2,'ENTITIES'],[0,'SECTION']]),'NESTED_SECTION');
  error(pairs([[0,'SECTION'],[2,'ENTITIES'],[0,'EOF']]),'EOF_IN_SECTION');
  error(pairs([[0,'SECTION'],[2,'ENTITIES']]),'MISSING_ENDSEC');
  error(dxf().replace(/0\nEOF\n$/,''),'MISSING_EOF');
  error(dxf()+pairs([[0,'EOF']]),'DATA_AFTER_EOF');
  error(pairs([[0,'EOF']]),'MISSING_ENTITIES');
  error(pairs([[1,'stray'],[0,'EOF']]),'DATA_OUTSIDE_SECTION');
  error(pairs([[0,'SECTION'],[2,'ENTITIES'],[8,'stray'],[0,'ENDSEC'],[0,'EOF']]),'ENTITY_DATA_WITHOUT_TYPE');
  for(const name of ['HEADER','ENTITIES']){
    const duplicate=pairs([[0,'SECTION'],[2,name],[0,'ENDSEC'],[0,'SECTION'],[2,name],[0,'ENDSEC'],[0,'EOF']]);
    error(duplicate,'DUPLICATE_'+name);
  }
});
test('ASCII, line length, byte and entity budgets are checked without silent truncation',()=>{
  error(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00'),'BINARY_DXF');
  for(const bad of ['é','\u0000','中文','\u007f'])error(dxf().replace('BX_WALL_AXIS',bad),'NON_ASCII_INPUT');
  error(Buffer.alloc(ASCII_DXF_LIMITS.maxBytes+1,32),'BYTE_LIMIT');
  error(' '.repeat(ASCII_DXF_LIMITS.maxBytes+1),'BYTE_LIMIT');
  error(pairs([[999,'x'.repeat(4097)]]),'LINE_LIMIT');
  assert.equal(value(pairs([[999,'x'.repeat(4096)]])+dxf()).coverage.lineCount,1);
  const many=n=>pairs([[0,'SECTION'],[2,'ENTITIES']])+'0\nPOINT\n'.repeat(n)+pairs([[0,'ENDSEC'],[0,'EOF']]);
  assert.equal(value(many(20000)).coverage.entityCount,20000);
  error(many(20001),'ENTITY_LIMIT');
});

test('application-defined 102 groups retain entity uncertainty without contaminating outer LINE fields',()=>{
  const grouped=[[0,'LINE'],[5,'AB'],[102,'{MY_APP'],[8,'APP_LAYER'],[5,'APP_HANDLE'],[10,'999'],[20,'999'],[11,'NaN'],[21,'Infinity'],[102,'}'],[8,'REAL_LAYER'],[10,1],[20,2],[11,4],[21,6]];
  const entity=value(dxf(grouped)).entities[0];
  assert.equal(entity.layer,'REAL_LAYER');assert.equal(entity.handle,'AB');
  assert.deepEqual(entity.geometry,{kind:'line',from:[1,2,0],to:[4,6,0]});
  assert.deepEqual(entity.issues.map(x=>x.code),['APPLICATION_GROUP_UNSUPPORTED']);
  const absent=value(dxf([[0,'LINE'],[102,'{MY_APP'],[8,'not-outer'],[10,1],[20,2],[11,4],[21,6],[102,'}']])).entities[0];
  assert.equal(absent.layer,null);assert.equal(absent.geometry,null);
  assert.ok(absent.issues.some(x=>x.code==='MISSING_LAYER'));
  assert.ok(absent.issues.some(x=>x.code==='MISSING_COORDINATE'));
  const multiple=value(dxf(line([[102,'{ACAD_REACTORS'],[330,'F1'],[102,'}'],[102,'{ACAD_XDICTIONARY'],[360,'F2'],[102,'}']]))).entities[0];
  assert.equal(multiple.issues.filter(x=>x.code==='APPLICATION_GROUP_UNSUPPORTED').length,1);
  assert.deepEqual(multiple.geometry,{kind:'line',from:[1,2,0],to:[4,6,0]});
});
test('ambiguous 102 ownership fails tagged instead of spanning entity and section boundaries',()=>{
  error(dxf(line([[102,'{APP'],[102,'{NESTED'],[102,'}'],[102,'}']])),'NESTED_APPLICATION_GROUP');
  error(dxf(line([[102,'{APP']])),'UNCLOSED_APPLICATION_GROUP');
  error(dxf([...line([[102,'{APP']]),...line()]),'UNCLOSED_APPLICATION_GROUP');
  error(pairs([[0,'SECTION'],[2,'ENTITIES'],...line([[102,'{APP']])]),'UNCLOSED_APPLICATION_GROUP');
  for(const contents of [[[102,'}']],[[102,'APP']],[[102,'{']],[[102,'{APP}']],[[102,'{APP'],[102,'APP}']]])
    error(dxf(line(contents)),'INVALID_APPLICATION_GROUP');
});
test('invalid options are tagged without argument destructuring exceptions',()=>{
  const input=Buffer.from(dxf());
  for(const options of [null,0,true,'source',[],new Date(),Buffer.from('x')]){
    let result;assert.doesNotThrow(()=>{result=readAsciiDxf(input,options);});
    assert.equal(result.ok,false);assert.equal(result.error.code,'INVALID_OPTIONS');
  }
  assert.equal(readAsciiDxf(input).ok,true);assert.equal(readAsciiDxf(input,undefined).ok,true);
  assert.equal(readAsciiDxf(input,Object.create(null)).ok,true);
  assert.equal(readAsciiDxf(input,{sourceName:42}).error.code,'INVALID_SOURCE_NAME');
  assert.equal(readAsciiDxf(input,{sourceName:'drawing.dxf'}).value.source.name,'drawing.dxf');
});

test('TEXT and MTEXT retain only direct outer raw text with explicit source identity',()=>{
  const input=dxf([[0,'TEXT'],[5,'A1'],[8,'NOTES'],[410,'Layout1'],[1,'Height %%d 3m'],
    [0,'MTEXT'],[5,'A2'],[8,'NOTES'],[3,'first '],[102,'{APP'],[1,'hidden'],[102,'}'],[3,'second '],[1,'third\\Pnext'],
    [0,'TEXT'],[1,'duplicate'],[1,'ambiguous'],[0,'MTEXT'],[1,'final'],[3,'out of order']]);
  const v=value(input), [one,two,badOne,badTwo]=v.entities;
  assert.deepEqual(one.textFact,{status:'raw',raw:'Height %%d 3m',sourceLines:[one.sourceLine+8],layout:'Layout1',representation:'literal-dxf-groups',formattingInterpreted:false});
  assert.equal(two.textFact.raw,'first second third\\Pnext');
  assert.equal(two.handle,'A2');assert.equal(two.layer,'NOTES');
  assert.equal(two.textFact.sourceLines.length,3);
  assert.equal(badOne.textFact.status,'invalid');assert.equal(badOne.textFact.raw,null);
  assert.equal(badTwo.textFact.status,'invalid');
  error(dxf([[0,'MTEXT'],...Array.from({length:1025},()=>[3,'x']),[1,'end']]),'TEXT_PART_LIMIT');
});
