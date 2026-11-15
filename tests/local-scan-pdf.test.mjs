import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {scanLocalPdf} from '../lib/local-scan-pdf.mjs';

const runtime = {
  pythonExecutable: process.env.BUILDX_TEST_SCAN_PYTHON,
  ocrExecutable: process.env.BUILDX_TEST_SCAN_TESSERACT,
  ocrDataDirectory: process.env.BUILDX_TEST_SCAN_TESSDATA,
};
const font = process.env.BUILDX_TEST_SCAN_FONT;
const runNative = [...Object.values(runtime),font].every(value => typeof value === 'string' && path.isAbsolute(value));
const fixtureScript = fileURLToPath(new URL('../test-support/local-scan-pdf-fixture.py', import.meta.url));
const exec = promisify(execFile);

test('rejects non-PDF input, conflicting source choices and invalid selected pages', async () => {
  assert.equal((await scanLocalPdf({bytes:Buffer.from('ordinary text')})).error.code, 'SCAN_PDF_INVALID_FILE');
  for (const pages of [[0],[1,1],[1.5],[],[1,2,3,4,5,6,7,8,9]])
    assert.equal((await scanLocalPdf({bytes:Buffer.from('%PDF-1.7'),pages})).error.code, 'SCAN_PDF_INVALID_INPUT');
  assert.equal((await scanLocalPdf({bytes:Buffer.from('%PDF-1.7'),filePath:path.resolve('other.pdf')})).error.code, 'SCAN_PDF_INVALID_INPUT');
  assert.equal((await scanLocalPdf({filePath:'relative.pdf'})).error.code, 'SCAN_PDF_INVALID_INPUT');
});

test('already cancelled scans stop before opening an input', async () => {
  const signal = AbortSignal.abort();
  assert.equal((await scanLocalPdf({signal,filePath:path.resolve('absent.pdf')})).error.code, 'SCAN_PDF_CANCELLED');
});

test('real local scan preserves digital pages, returns OCR provenance and handles unavailable models', {skip:!runNative}, async t => {
  const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'BuildX-ScanPdf-Test-'));
  const filePath = path.join(scratch,'synthetic-quote.pdf');
  const empty = path.join(scratch,'empty-tessdata');
  t.after(async () => {
    await fs.rm(filePath,{force:true});
    await fs.rmdir(empty).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(scratch);
  });
  await exec(runtime.pythonExecutable, ['-E','-P','-B',fixtureScript,font,filePath], {windowsHide:true,timeout:30000});
  const original = await fs.readFile(filePath);
  const result = await scanLocalPdf({...runtime,filePath,pages:[2,1]});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.pageCount,2);
  const [recognized,digital] = result.value.pages;
  assert.equal(recognized.page,1);
  assert.equal(recognized.source,'ocr');
  assert.match(recognized.text,/BX-150-80/);
  assert.match(recognized.text,/QUANTITY:\s*2/);
  assert.match(recognized.text,/12500\.00 CNY/);
  assert.match(recognized.text,/25000\.00 CNY/);
  assert.match(recognized.text,/\p{Script=Han}/u);
  assert.ok(recognized.confidence > 0 && recognized.confidence <= 100);
  assert.ok(recognized.regions.some(region => region.text.includes('BX-150-80') && region.box.length === 4));
  for (const region of recognized.regions) {
    const [left,top,width,height] = region.box;
    assert.ok(left >= 0 && top >= 0 && left+width <= recognized.imageSize[0] && top+height <= recognized.imageSize[1]);
    assert.equal(typeof region.lowConfidence,'boolean');
  }
  assert.deepEqual(digital,{page:2,source:'text',text:'DIGITAL TERMS: PUMP QUOTATION',truncated:false});

  await fs.mkdir(empty);
  const withoutOcr = await scanLocalPdf({...runtime,bytes:original,pages:[1,2],ocrDataDirectory:empty});
  assert.equal(withoutOcr.ok,true,JSON.stringify(withoutOcr));
  assert.deepEqual(withoutOcr.value.pages[0],{page:1,source:'unreadable',text:'',truncated:false,issue:'SCAN_PDF_OCR_LANGUAGE_UNAVAILABLE'});
  assert.deepEqual(withoutOcr.value.pages[1],digital);
  assert.ok(withoutOcr.value.warnings.includes('SCAN_PDF_OCR_LANGUAGE_UNAVAILABLE'));
  assert.equal((await scanLocalPdf({...runtime,bytes:original,pages:[3]})).error.code,'SCAN_PDF_PAGE_OUT_OF_RANGE');

  const controller = new AbortController();
  const pending = scanLocalPdf({...runtime,bytes:original,pages:[1],signal:controller.signal});
  const timer = setTimeout(() => controller.abort(),40);
  try { assert.equal((await pending).error.code,'SCAN_PDF_CANCELLED'); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await fs.readFile(filePath),original);
});
