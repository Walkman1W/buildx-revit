import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createProjectKnowledge} from './lib/project-knowledge.mjs';

test('project index preserves exact versions, scopes searches and computes CSV rows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-knowledge-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.writeFile(path.join(root, 'brief.md'), '设计说明\n净高 3 米\n');
  await fs.writeFile(path.join(root, 'room.csv'), '用途,面积\n机房,12.5\n"办公,会议",8\n机房,7.5\n');
  await fs.writeFile(path.join(root, 'drawing.pdf'), '%PDF-1.4');
  const created = createProjectKnowledge({projectId: 'p1', rootPath: root});
  assert.equal(created.ok, true); const service = created.value;
  assert.equal((await service.refresh()).value.coverage.complete, true);
  const files = service.list().value.files, brief = files.find(x => x.path === 'brief.md');
  assert.equal(files.find(x => x.path === 'drawing.pdf').status, 'error');
  const result = service.search({query: '净高'}).value;
  assert.equal(result.matches[0].location.line, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(service.read({path: brief.path, sha256: brief.sha256}).value.lines[1].text, '净高 3 米');
  const csv = files.find(x => x.path === 'room.csv');
  const calculation = service.table({path: csv.path, sha256: csv.sha256, column: 1, equals: '机房', sumColumn: 2}).value;
  assert.equal(calculation.sum, 20); assert.equal(calculation.matchedRows, 2);
  assert.deepEqual(calculation.locations, [{row: 2, column: 2}, {row: 4, column: 2}]);
  await fs.writeFile(path.join(root, 'brief.md'), '净高 4 米');
  await fs.rm(path.join(root, 'room.csv'));
  await service.refresh();
  const updated = service.list().value.files.find(x => x.path === 'brief.md');
  assert.notEqual(updated.sha256, brief.sha256);
  assert.equal(service.read({path: brief.path, sha256: brief.sha256}).value.historical, true);
  assert.equal(service.read({path: brief.path, sha256: brief.sha256}).value.lines[1].text, '净高 3 米');
  assert.equal(service.search({query: '机房'}).value.matches.length, 0);
  const other = createProjectKnowledge({projectId: 'p2', rootPath: root}).value;
  assert.equal(other.read({path: brief.path, sha256: brief.sha256}).error.code, 'KNOWLEDGE_VERSION_UNAVAILABLE');
  assert.equal(service.read({path: '../brief.md', sha256: updated.sha256}).error.code, 'KNOWLEDGE_VERSION_UNAVAILABLE');
});

test('DOCX, XLSX and PDF preserve paragraph, cell and page locations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-formats-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const script = `
import sys, zipfile
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'brief.docx','w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Design height</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(p/'rooms.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rooms" sheetId="1" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Use</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Office</t></is></c><c r="B2"><v>12.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Office</t></is></c><c r="B3"><v>7.5</v></c></row></sheetData></worksheet>')
writer=PdfWriter(); page=writer.add_blank_page(width=200,height=200)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
stream=DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 10 100 Td (Room height) Tj ET'); page[NameObject('/Contents')]=writer._add_object(stream)
with open(p/'notes.pdf','wb') as f: writer.write(f)
`;
  const generated = spawnSync('python', ['-c', script, root], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const service = createProjectKnowledge({projectId: 'formats', rootPath: root}).value;
  await service.refresh();
  const files = service.list().value.files;
  assert.deepEqual(files.map(f => [f.path, f.status]).sort(), [['brief.docx', 'indexed'], ['notes.pdf', 'indexed'], ['rooms.xlsx', 'indexed']]);
  assert.deepEqual(service.search({query: 'Design height'}).value.matches[0].location, {paragraph: 1});
  assert.deepEqual(service.search({query: 'Room height'}).value.matches[0].location, {page: 1, line: 1});
  assert.deepEqual(service.search({query: 'Office'}).value.matches[0].location, {sheet: 'Rooms', cell: 'A2'});
  const sheet = files.find(f => f.path === 'rooms.xlsx');
  assert.equal(service.table({path: sheet.path, sha256: sheet.sha256, sheet: 'Rooms', column: 1, equals: 'Office', sumColumn: 2}).value.sum, 20);
  assert.equal(service.search({query: 'nothing'}).value.coverage.complete, false);
});

test('failed parsing, bounded scan, and invalid numeric values remain visible', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-knowledge-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.writeFile(path.join(root, 'bad.csv'), 'a,b\n"unclosed');
  await fs.writeFile(path.join(root, 'values.csv'), 'name,value\nA,12\nA,not-a-number\n');
  const service = createProjectKnowledge({projectId: 'p', rootPath: root}).value;
  await service.refresh();
  const files = service.list().value.files;
  assert.equal(files.find(x => x.path === 'bad.csv').status, 'error');
  const values = files.find(x => x.path === 'values.csv');
  const result = service.table({path: values.path, sha256: values.sha256, column: 1, equals: 'A', sumColumn: 2}).value;
  assert.equal(result.invalidValues, 1); assert.equal(result.sum, null);
  const limited = createProjectKnowledge({projectId: 'limited', rootPath: root, maxEntries: 1}).value;
  assert.equal((await limited.refresh()).value.coverage.complete, false);
  assert.equal(limited.search({query: 'missing'}).value.coverage.complete, false);
});

test('XLSX shared-string expansion and Excel cell limits are enforced before output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-xlsx-bounds-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const script = `
import sys, zipfile
from pathlib import Path
p=Path(sys.argv[1])
book='<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rooms" sheetId="1" r:id="r1"/></sheets></workbook>'
rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'
def write(name, cells, shared=None):
 with zipfile.ZipFile(p/name,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('xl/workbook.xml',book); z.writestr('xl/_rels/workbook.xml.rels',rels)
  z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+cells+'</sheetData></worksheet>')
  if shared is not None: z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>'+shared+'</t></si></sst>')
write('valid.xlsx','<c r="XFD1048576"><v>1</v></c>')
write('invalid-row.xlsx','<c r="XFD1048577"><v>1</v></c>')
write('invalid-col.xlsx','<c r="XFE1048576"><v>1</v></c>')
write('expansion.xlsx',''.join('<c r="A%d" t="s"><v>0</v></c>'%i for i in range(1,10001)),'x'*200000)
`;
  const generated = spawnSync('python', ['-c', script, root], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const service = createProjectKnowledge({projectId: 'bounds', rootPath: root}).value;
  await service.refresh();
  const files = service.list().value.files;
  assert.equal(files.find(f => f.path === 'valid.xlsx').status, 'indexed');
  assert.equal(service.search({query: '1'}).value.matches.find(m => m.path === 'valid.xlsx').location.cell, 'XFD1048576');
  assert.equal(files.find(f => f.path === 'invalid-row.xlsx').issue, 'INVALID_CELL_REFERENCE');
  assert.equal(files.find(f => f.path === 'invalid-col.xlsx').issue, 'INVALID_CELL_REFERENCE');
  assert.equal(files.find(f => f.path === 'expansion.xlsx').issue, 'EXTRACTED_TEXT_LIMIT');
});

test('parser process refuses an allocation above its OS memory limit', () => {
  const parser = path.join(process.cwd(), 'lib', 'project-knowledge-parser.py');
  const script = `
import runpy, sys
sys.argv=['parser','docx']
runpy.run_path(sys.argv[1] if False else ${JSON.stringify(parser)})
try:
 bytearray(512 * 1024 * 1024)
 print('UNBOUNDED')
except MemoryError:
 print('MEMORY_LIMIT_ENFORCED')
`;
  const result = spawnSync('python', ['-c', script], {input: '', encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MEMORY_LIMIT_ENFORCED/);
  assert.doesNotMatch(result.stdout, /PARSER_MEMORY_LIMIT_UNAVAILABLE|UNBOUNDED/);
});

test('DXF knowledge searches literal direct text with versioned entity provenance and honest coverage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-dxf-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const pairs = values => values.map(([code, value]) => `${code}\n${value}\n`).join('');
  const contents = pairs([[0,'SECTION'],[2,'BLOCKS'],[0,'TEXT'],[1,'block-hidden'],[0,'ENDSEC'],
    [0,'SECTION'],[2,'ENTITIES'],[0,'TEXT'],[5,'AB'],[8,'NOTES'],[410,'Layout1'],[1,'Height 3000'],
    [0,'MTEXT'],[5,'CD'],[8,'DETAIL'],[3,'Fire '],[1,'rating\\Pnext'],[0,'INSERT'],[2,'block'],
    [0,'TEXT'],[1,'bad'],[1,'duplicate'],[0,'ENDSEC'],[0,'EOF']]);
  await fs.writeFile(path.join(root, 'plan.dxf'), contents);
  await fs.writeFile(path.join(root, 'unknown.dxf'), contents.replace('Height', '中文'));
  await fs.writeFile(path.join(root, 'native.dwg'), 'not read');
  const service = createProjectKnowledge({projectId: 'cad-project', rootPath: root}).value;
  await service.refresh();
  const files = service.list().value.files, dxf = files.find(file => file.path === 'plan.dxf');
  assert.equal(dxf.status, 'indexed');
  assert.ok(dxf.warnings.includes('DXF_INVALID_TEXT_ENTITY_SKIPPED'));
  assert.equal(files.find(file => file.path === 'unknown.dxf').issue, 'NON_ASCII_INPUT');
  assert.equal(files.find(file => file.path === 'native.dwg').status, 'unsupported');
  const found = service.search({query: 'Height'}).value;
  assert.equal(found.coverage.complete, false);
  assert.deepEqual(found.matches[0].location, {entityType: 'TEXT', ordinal: 1, sourceLine: 15,
    handle: 'AB', layer: 'NOTES', layout: 'Layout1'});
  assert.equal(found.matches[0].sha256, dxf.sha256);
  assert.equal(service.search({query: 'Fire rating'}).value.matches[0].location.entityType, 'MTEXT');
  assert.equal(service.search({query: 'block-hidden'}).value.matches.length, 0);
  const page = service.read({path: dxf.path, sha256: dxf.sha256}).value;
  assert.equal(page.lines[0].representation, 'literal-dxf-groups');
  assert.equal(page.lines[0].formattingInterpreted, false);
  await fs.writeFile(path.join(root, 'plan.dxf'), contents.replace('Height 3000','Height 4000'));
  await service.refresh();
  assert.equal(service.read({path: dxf.path, sha256: dxf.sha256}).value.lines[0].text, 'Height 3000');
  assert.equal(service.read({path: dxf.path, sha256: dxf.sha256}).value.historical, true);
});
