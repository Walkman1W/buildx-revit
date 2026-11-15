import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {validateExcelWorkbook,writeLocalExcel} from '../lib/local-excel.mjs';

const quote={sheets:[{name:'报价 Quote',header:true,rows:[
  ['型号 / Model','数量 / Qty','单价 / Unit Price','金额 / Amount','复核'],
  ['P-100',2,{value:1250,numberFormat:'#,##0.00'},{formula:'= B2 * c2 ',numberFormat:'#,##0.00'},'已核'],
  ['=P-200',3,800,{formula:'=B3*C3',numberFormat:'#,##0.00'},'待核'],
  ['总计 / Total',null,null,{formula:'=SUM(D2:D3)',numberFormat:'#,##0.00'}]
]}]};
const excelPython=process.env.BUILDX_TEST_EXCEL_PYTHON;
const run=promisify(execFile);

async function workDir(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-xlsx-'));
  t.after(async()=>{
    const parent=await fs.realpath(os.tmpdir());
    const resolved=await fs.realpath(directory);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^buildx-xlsx-/);
    await fs.rm(resolved,{recursive:true,force:true});
  });
  return directory;
}

async function inspect(outputPath) {
  const script=[
    'import json, sys',
    'from openpyxl import load_workbook',
    'book = load_workbook(sys.argv[1], data_only=False)',
    'ws = book["\\u62a5\\u4ef7 Quote"]',
    'coords = ("A2","A3","B2","C2","D2","D3","D4","E3","F6")',
    'cells = {k: [ws[k].value,ws[k].data_type,ws[k].number_format] for k in coords}',
    'cached = load_workbook(sys.argv[1], data_only=True).active["D4"].value',
    'print(json.dumps({"cells":cells,"cached":cached,"freeze":ws.freeze_panes,"bold":ws["A1"].font.bold}))'
  ].join('\n');
  const {stdout}=await run(excelPython,['-I','-B','-c',script,outputPath],{windowsHide:true});
  return JSON.parse(stdout);
}

test('normalizes quote cells and restricts formulas to bounded local references',()=>{
  const normalized=validateExcelWorkbook(quote);
  assert.equal(normalized.sheets[0].rows[1][3].formula,'=B2*C2');
  assert.equal(normalized.sheets[0].rows[2][0],'=P-200');
  for(const formula of ['=WEBSERVICE("https://example.org")','=HYPERLINK(A1)','=A1!A1','=MISSING1','=AY2','=A2001','=A1|A2','=1\n']) {
    assert.throws(()=>validateExcelWorkbook({sheets:[{name:'sheet',rows:[[{formula}]]}]}),{code:'EXCEL_INPUT_INVALID'});
  }
  for(const bad of [
    {sheets:[{name:'Bad/Sheet',rows:[[1]]}]},
    {sheets:[{name:'same',rows:[[1]]},{name:'SAME',rows:[[2]]}]},
    {sheets:[{name:'x',rows:[[{value:'text',numberFormat:'0.00'}]]}]},
    {sheets:[{name:'x',rows:[[{value:1,formula:'=A1'}]]}]},
    {sheets:[{name:'x',rows:[[Infinity]]}]},
    {sheets:[{name:'x',rows:[['\u0001']]}]}
  ])assert.throws(()=>validateExcelWorkbook(bad),{code:'EXCEL_INPUT_INVALID'});
});

test('requires trusted absolute paths and observes cancellation before running',async t=>{
  const directory=await workDir(t);
  const outputPath=path.join(directory,'quote.xlsx');
  await assert.rejects(writeLocalExcel({workbook:quote,outputPath:'quote.xlsx',pythonExecutable:process.execPath}),{code:'EXCEL_INPUT_INVALID'});
  const stop=new AbortController();
  stop.abort();
  await assert.rejects(writeLocalExcel({workbook:quote,outputPath,pythonExecutable:process.execPath,signal:stop.signal}),{code:'EXCEL_CANCELLED'});
  await assert.rejects(fs.access(outputPath),{code:'ENOENT'});
});

test('writes a quote and verifies numeric types, formulas, headers and literal text after reopening', {skip:!excelPython},async t=>{
  const directory=await workDir(t);
  const outputPath=path.join(directory,'quote.xlsx');
  const result=await writeLocalExcel({workbook:quote,outputPath,pythonExecutable:excelPython});
  const bytes=await fs.readFile(outputPath);
  assert.equal(result.bytes,bytes.length);
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.formulaCount,3);
  assert.equal(result.cellCount,19);
  assert.equal(result.formulasCalculated,false);
  assert.equal(result.templateCopied,false);
  const reopened=await inspect(outputPath);
  assert.deepEqual(reopened.cells.A3,['=P-200','s','General']);
  assert.deepEqual(reopened.cells.B2,[2,'n','General']);
  assert.deepEqual(reopened.cells.C2,[1250,'n','#,##0.00']);
  assert.deepEqual(reopened.cells.D2,['=B2*C2','f','#,##0.00']);
  assert.deepEqual(reopened.cells.D3,['=B3*C3','f','#,##0.00']);
  assert.deepEqual(reopened.cells.D4,['=SUM(D2:D3)','f','#,##0.00']);
  assert.deepEqual(reopened.cells.E3,['待核','s','General']);
  assert.equal(reopened.cached,null);
  assert.equal(reopened.freeze,'A2');
  assert.equal(reopened.bold,true);
  await assert.rejects(writeLocalExcel({workbook:quote,outputPath,pythonExecutable:excelPython}),{code:'EXCEL_OUTPUT_EXISTS'});
  assert.deepEqual(await fs.readFile(outputPath),bytes);
});

test('copies a simple approved template without modifying it or preserving executable formulas', {skip:!excelPython},async t=>{
  const directory=await workDir(t);
  const templatePath=path.join(directory,'template.xlsx');
  const invalidPath=path.join(directory,'invalid.xlsx');
  const outputPath=path.join(directory,'quote.xlsx');
  const createTemplate=[
    'import sys',
    'from openpyxl import Workbook',
    'book=Workbook()',
    'book.active.title="\\u62a5\\u4ef7 Quote"',
    'book.active["F6"]="template footnote"',
    'book.save(sys.argv[1])',
    'book.active["F7"]=\'=WEBSERVICE("https://example.org")\'',
    'book.save(sys.argv[2])'
  ].join('\n');
  await run(excelPython,['-I','-B','-c',createTemplate,templatePath,invalidPath],{windowsHide:true});
  const original=await fs.readFile(templatePath);
  await assert.rejects(writeLocalExcel({workbook:quote,templatePath:invalidPath,outputPath,pythonExecutable:excelPython}),
    {code:'EXCEL_TEMPLATE_UNSUPPORTED'});
  await assert.rejects(fs.access(outputPath),{code:'ENOENT'});
  const result=await writeLocalExcel({workbook:quote,templatePath,outputPath,pythonExecutable:excelPython});
  assert.equal(result.templateCopied,true);
  assert.deepEqual(await fs.readFile(templatePath),original);
  assert.deepEqual((await inspect(outputPath)).cells.F6,['template footnote','s','General']);
});
