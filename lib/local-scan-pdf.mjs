import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePythonExecutable} from './local-runtimes.mjs';

const parser = fileURLToPath(new URL('./local-scan-pdf-runner.py', import.meta.url));
const maxInput = 20 * 1024 * 1024;
const maxPages = 8;
const maxText = 4000;
const lang = ['chi_sim', 'eng'];
const failure = (code, message = '本机 PDF 读取未完成。') => ({ok: false, error: {code, message}});
const success = value => ({ok: true, value});
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const aborted = () => failure('SCAN_PDF_CANCELLED', '已取消本机 PDF 读取。');
const runtimeEnvironmentKeys = ['PATH','SYSTEMROOT','SYSTEMDRIVE','WINDIR','HOME','USERPROFILE','APPDATA',
  'LOCALAPPDATA','TEMP','TMP','LANG','LC_ALL'];

function localRuntimeEnvironment() {
  const entries = runtimeEnvironmentKeys.flatMap(name => process.env[name] ? [[name,process.env[name]]] : []);
  return {...Object.fromEntries(entries), OMP_THREAD_LIMIT:'1', OPENBLAS_NUM_THREADS:'1'};
}

function runProgram(executable, args, {input, signal, timeoutMs, maxOutput = 512 * 1024}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(aborted());
    let child, reason, outputBytes = 0;
    const chunks = [];
    try {
      child = spawn(executable, args, {stdio: ['pipe','pipe','ignore'], shell: false, windowsHide: true,
        env:localRuntimeEnvironment()});
    } catch {
      return resolve(failure('SCAN_PDF_RUNTIME_UNAVAILABLE'));
    }
    const stop = error => {
      if (!reason) reason = error;
      child.kill();
    };
    const onAbort = () => stop(aborted());
    const timer = setTimeout(() => stop(failure('SCAN_PDF_TIMEOUT', '本机 PDF 读取超时。')), timeoutMs);
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    child.on('error', () => { reason ??= failure('SCAN_PDF_RUNTIME_UNAVAILABLE'); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) stop(failure('SCAN_PDF_OUTPUT_LIMIT'));
      else chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(reason ?? (code === 0 ? success(Buffer.concat(chunks)) : failure('SCAN_PDF_RUNTIME_FAILED')));
    });
    child.stdin.end(input);
  });
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function readStagedFile(filePath, signal) {
  const named = await fs.lstat(filePath, {bigint:true});
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
      path.relative(filePath, await fs.realpath(filePath)) || named.size > BigInt(maxInput)) return null;
  const file = await fs.open(filePath, 'r');
  try {
    const before = await file.stat({bigint:true});
    if (!sameFile(named, before)) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length && !signal?.aborted) {
      const {bytesRead} = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const after = await fs.lstat(filePath, {bigint:true});
    return !signal?.aborted && !after.isSymbolicLink() && sameFile(before, after) && sameFile(before, await file.stat({bigint:true}))
      ? bytes : null;
  } finally {
    await file.close();
  }
}

function ocrInstallation() {
  if (process.env.BUILDX_OCR_EXECUTABLE) return process.env.BUILDX_OCR_EXECUTABLE;
  return process.platform === 'win32'
    ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe')
    : '/usr/bin/tesseract';
}

async function checkOcr(executable, dataDirectory, signal) {
  const dataArgs = dataDirectory ? ['--tessdata-dir', dataDirectory] : [];
  const result = await runProgram(executable, [...dataArgs, '--list-langs'], {signal, timeoutMs:5000, maxOutput:16384});
  if (!result.ok) return result;
  const installed = new Set(result.value.toString('utf8').split(/\r?\n/).map(line => line.trim()));
  return lang.every(language => installed.has(language)) ? success(dataArgs) : failure('SCAN_PDF_OCR_LANGUAGE_UNAVAILABLE');
}

function readOcrRegions(output, [width, height]) {
  const rows = new Map();
  for (const line of new TextDecoder('utf-8', {fatal:true}).decode(output).split(/\r?\n/)) {
    const [level, page, block, paragraph, row, , x, y, w, h, conf, ...parts] = line.split('\t');
    if (level !== '5') continue;
    const text = parts.join(' ').trim();
    const [left, top, boxWidth, boxHeight, confidence] = [x,y,w,h,conf].map(Number);
    if (!text || ![left, top, boxWidth, boxHeight].every(Number.isSafeInteger) || left < 0 || top < 0 || boxWidth < 1 || boxHeight < 1 ||
        left + boxWidth > width || top + boxHeight > height || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
    const key = [page,block,paragraph,row].join(':');
    const previous = rows.get(key);
    const right = left + boxWidth, bottom = top + boxHeight;
    const word = {text, left, top, right, bottom, weighted:confidence * text.length, weight:text.length, minimum:confidence};
    rows.set(key, previous ? {
      text: `${previous.text} ${text}`, left: Math.min(previous.left,left), top: Math.min(previous.top,top),
      right: Math.max(previous.right,right), bottom: Math.max(previous.bottom,bottom),
      weighted: previous.weighted + word.weighted, weight: previous.weight + word.weight, minimum:Math.min(previous.minimum, confidence),
    } : word);
  }
  return [...rows.values()].map(({text, left, top, right, bottom, weighted, weight, minimum}) => ({
    text, box:[left, top, right-left, bottom-top], confidence: Math.round(weighted / weight), lowConfidence:minimum < 65,
  }));
}

function unresolved(page, issue) {
  return {page: page.page, source: page.text ? 'text' : 'unreadable', text: page.text,
    truncated: page.truncated, issue};
}

async function recognizePage(page, directory, ocrExecutable, dataArgs, signal) {
  const image = path.join(directory, `page-${page.page}.png`);
  const scanned = await runProgram(ocrExecutable,
    [image, 'stdout', ...dataArgs, '-l', lang.join('+'), '-c', 'tessedit_create_tsv=1'], {signal, timeoutMs:15000});
  if (!scanned.ok) return unresolved(page, scanned.error.code);
  try {
    const lines = readOcrRegions(scanned.value, page.imageSize);
    if (!lines.length) return unresolved(page, 'SCAN_PDF_NO_RECOGNIZED_TEXT');
    const text = lines.map(row => row.text).join('\n');
    const confidence = Math.round(lines.reduce((sum,row) => sum + row.confidence * row.text.length, 0) /
      lines.reduce((sum,row) => sum + row.text.length, 0));
    return {page:page.page, source:'ocr', text:text.slice(0,maxText), confidence, imageSize:page.imageSize,
      regions:lines.slice(0,64).map(row => ({...row, text:row.text.slice(0,256)})),
      truncated:text.length > maxText || lines.length > 64 || lines.some(row => row.text.length > 256),
      ...(confidence < 80 || lines.some(row => row.lowConfidence) ? {issue:'SCAN_PDF_LOW_OCR_CONFIDENCE'} : {})};
  } catch {
    return unresolved(page, 'SCAN_PDF_INVALID_OCR_RESULT');
  }
}

async function plannedPages(directory, bytes, pages, mode, pythonExecutable, signal) {
  const result = await runProgram(pythonExecutable, ['-I','-B','-X','utf8',parser,directory,JSON.stringify({pages,mode})],
    {input:bytes, signal, timeoutMs:25000});
  if (!result.ok) return result;
  try {
    const data = JSON.parse(result.value);
    if (data?.ok === false && /^SCAN_PDF_[A-Z_]{3,72}$/.test(data.code)) return failure(data.code);
    const {pageCount, pages: planned} = data?.value ?? {};
    if (data?.ok !== true || !Number.isInteger(pageCount) || pageCount < 1 || !Array.isArray(planned) || planned.length < 1 ||
        planned.length > maxPages || planned.some(item => !Number.isInteger(item.page) || item.page < 1 || item.page > pageCount ||
          typeof item.text !== 'string' || !['text','pending'].includes(item.source) || typeof item.truncated !== 'boolean' ||
          (item.imageSize !== undefined && (!Array.isArray(item.imageSize) || item.imageSize.length !== 2 ||
            !item.imageSize.every(size => Number.isInteger(size) && size >= 1 && size <= 3200)))))
      return failure('SCAN_PDF_INVALID_PARSER_RESULT');
    return success({pageCount, pages:planned});
  } catch {
    return failure('SCAN_PDF_INVALID_PARSER_RESULT');
  }
}

async function recognizePlan(directory, plan, ocrExecutable, ocrDataDirectory, signal) {
  const pages = [], warnings = new Set();
  const needOcr = plan.pages.some(page => page.source === 'pending' && page.imageSize && !page.issue);
  const ocr = needOcr ? await checkOcr(ocrExecutable, ocrDataDirectory, signal) : null;
  for (const page of plan.pages) {
    if (signal?.aborted) return aborted();
    const result = page.source === 'text' ? page : page.issue || !ocr?.ok
      ? unresolved(page, page.issue ?? ocr?.error.code ?? 'SCAN_PDF_RENDER_FAILED')
      : await recognizePage(page, directory, ocrExecutable, ocr.value, signal);
    if (result.issue) warnings.add(result.issue);
    if (result.truncated) warnings.add('SCAN_PDF_TEXT_TRUNCATED');
    pages.push(result);
  }
  return signal?.aborted ? aborted() : success({pageCount:plan.pageCount, pages, warnings:[...warnings]});
}

async function cleanup(directory) {
  if (path.relative(directory, await fs.realpath(directory))) throw new Error('scratch identity changed');
  for (const entry of await fs.readdir(directory)) {
    if (!/^page-[1-9]\d{0,3}\.png$/.test(entry)) throw new Error('unexpected scratch file');
    await fs.unlink(path.join(directory,entry));
  }
  await fs.rmdir(directory);
}

/** The caller owns user consent and supplies a staged snapshot or checked path. */
export async function scanLocalPdf({filePath,bytes,pages,mode='auto',pythonExecutable,ocrExecutable=ocrInstallation(),
  ocrDataDirectory=process.env.BUILDX_OCR_DATA_DIR,signal} = {}) {
  if (signal?.aborted) return aborted();
  if ((bytes === undefined ? !validPath(filePath) : !Buffer.isBuffer(bytes) || filePath !== undefined) ||
      !['auto','ocr'].includes(mode) || (pages !== undefined && (!Array.isArray(pages) || pages.length < 1 || pages.length > maxPages ||
        new Set(pages).size !== pages.length || [...pages].some(page => !Number.isInteger(page) || page < 1 || page > 2000))) ||
      (pythonExecutable !== undefined && !validPath(pythonExecutable)) || !validPath(ocrExecutable) ||
      (ocrDataDirectory !== undefined && !validPath(ocrDataDirectory)) || (signal !== undefined && !(signal instanceof AbortSignal)))
    return failure('SCAN_PDF_INVALID_INPUT', '请选择本机文件和有效页码。');

  try { bytes = bytes === undefined ? await readStagedFile(filePath, signal) : bytes.length > maxInput ? null : Buffer.from(bytes); }
  catch { return failure('SCAN_PDF_INPUT_UNAVAILABLE', '本机 PDF 快照无法读取。'); }
  if (signal?.aborted) return aborted();
  if (!bytes || bytes.length > maxInput || !/^%PDF-\d\.\d/.test(bytes.toString('ascii',0,8)))
    return failure('SCAN_PDF_INVALID_FILE', '请选择有效且不超过 20 MiB 的 PDF。');
  try { pythonExecutable ??= resolvePythonExecutable(); }
  catch { return failure('SCAN_PDF_RUNTIME_UNAVAILABLE', '当前未找到可用的本机 Python。'); }

  const deadline = AbortSignal.timeout(45000);
  const workSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let directory, result;
  try {
    directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'BuildX-ScanPdf-'));
    const selected = pages === undefined ? null : [...pages].sort((left,right) => left-right);
    const plan = await plannedPages(directory, bytes, selected, mode, pythonExecutable, workSignal);
    result = plan.ok ? await recognizePlan(directory, plan.value, ocrExecutable, ocrDataDirectory, workSignal) : plan;
  } catch {
    result = failure('SCAN_PDF_LOCAL_IO_FAILED');
  }
  if (directory) {
    try { await cleanup(directory); }
    catch { return failure('SCAN_PDF_CLEANUP_FAILED', '本机扫描临时数据清理未确认。'); }
  }
  if (signal?.aborted) return aborted();
  return deadline.aborted ? failure('SCAN_PDF_TIMEOUT', '本机 PDF 读取超时。') : result;
}
