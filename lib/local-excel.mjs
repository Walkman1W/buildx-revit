import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const WORKER = fileURLToPath(new URL('./local-excel.py',import.meta.url));
const LIMITS = Object.freeze({sheets:12,rows:2000,columns:50,cells:10000,bytes:2*1024*1024});
const NUMBER_FORMATS = new Set(['0','0.00','#,##0','#,##0.00','0%','0.00%']);
const CELL_ADDRESS = '\\$?[A-Z]{1,2}\\$?[1-9][0-9]{0,3}';
const DECIMAL = '(?:[0-9]{1,15}(?:\\.[0-9]{1,15})?|\\.[0-9]{1,15})';
const TERM = '(?:'+CELL_ADDRESS+'|'+DECIMAL+')';
const RANGE = CELL_ADDRESS+'(?::'+CELL_ADDRESS+')?';
const FORMULA_PATTERNS = [
  '^=[+-]?'+TERM+'(?:[+*/-]'+TERM+'){0,9}$',
  '^=(?:SUM|MIN|MAX|AVERAGE)\\('+RANGE+'(?:,'+RANGE+'){0,9}\\)$'
];
const FORMULAS = FORMULA_PATTERNS.map(pattern=>new RegExp(pattern,'u'));
const CELL_REFERENCES = /\$?([A-Z]{1,2})\$?([1-9][0-9]{0,3})/gu;
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const EXIT_MESSAGES = Object.freeze({
  EXCEL_DEPENDENCY_UNAVAILABLE:'本机 Excel 文件生成组件不可用。',
  EXCEL_TEMPLATE_UNSUPPORTED:'所选 Excel 模板超出当前支持范围。',
  EXCEL_VALIDATION_FAILED:'重新打开后未能核对 Excel 的内容。',
  EXCEL_OUTPUT_EXISTS:'目标 Excel 文件已存在。',
  EXCEL_WRITE_FAILED:'本机 Excel 文件生成失败。'
});

function failure(code,message) {
  return Object.assign(new Error(message),{code,localToolCode:code});
}

function invalid(message) {
  return failure('EXCEL_INPUT_INVALID',message);
}

function objectWith(value,keys) {
  if(value===null||typeof value!=='object')return false;
  const prototype=Object.getPrototypeOf(value);
  return (prototype===Object.prototype||prototype===null)&&
    Reflect.ownKeys(value).every(key=>keys.includes(key));
}

function scalar(value) {
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1e15&&
     (value===0||Math.abs(value)>=1e-307)&&Number(value.toPrecision(15))===value)return value===0?0:value;
  if(typeof value==='string'&&value.length<=8192&&value.isWellFormed()&&!ILLEGAL_XML.test(value))return value||null;
  throw invalid('单元格须为 Excel 可表示的数字、文本、布尔值或空值。');
}

function formula(value) {
  if(typeof value!=='string'||value.length>240||!/^=[A-Za-z0-9 \t$().,:+*/-]+$/u.test(value)) {
    throw invalid('公式仅支持同表单元格四则运算和 SUM、MIN、MAX、AVERAGE。');
  }
  const expression=value.replace(/[ \t]/gu,'').toUpperCase();
  if(!FORMULAS.some(pattern=>pattern.test(expression)))throw invalid('公式仅支持同表单元格四则运算和 SUM、MIN、MAX、AVERAGE。');
  for(const [,letters,row] of expression.matchAll(CELL_REFERENCES)) {
    let column=0;
    for(const letter of letters)column=column*26+letter.charCodeAt(0)-64;
    if(column>LIMITS.columns||Number(row)>LIMITS.rows)throw invalid('公式引用超出支持的单元格范围。');
  }
  return expression;
}

function cell(value) {
  if(value===null||typeof value!=='object')return scalar(value);
  if(!objectWith(value,['value','formula','numberFormat'])||Object.hasOwn(value,'value')===Object.hasOwn(value,'formula')) {
    throw invalid('单元格的 value 和 formula 只能填其中一个。');
  }
  const normalized=Object.hasOwn(value,'formula')?{formula:formula(value.formula)}:{value:scalar(value.value)};
  if(Object.hasOwn(value,'numberFormat')) {
    if(!NUMBER_FORMATS.has(value.numberFormat)||(!Object.hasOwn(normalized,'formula')&&typeof normalized.value!=='number')) {
      throw invalid('数字格式只适用于数字或公式单元格。');
    }
    normalized.numberFormat=value.numberFormat;
  }
  return normalized;
}

export function validateExcelWorkbook(input) {
  if(!objectWith(input,['sheets'])||!Array.isArray(input.sheets)||input.sheets.length===0||input.sheets.length>LIMITS.sheets) {
    throw invalid('工作簿须包含 1 至 '+LIMITS.sheets+' 张工作表。');
  }
  const names=new Set();
  let cellCount=0;
  const sheets=Array.from(input.sheets,sheet=>{
    if(!objectWith(sheet,['name','rows','header'])||typeof sheet.name!=='string'||
       !Array.isArray(sheet.rows)||sheet.rows.length===0||sheet.rows.length>LIMITS.rows||
       (Object.hasOwn(sheet,'header')&&typeof sheet.header!=='boolean')) {
      throw invalid('工作表须提供名称和有界的行数据。');
    }
    const name=sheet.name.trim();
    if(!name||name.length>31||!name.isWellFormed()||/[\u0000-\u001F\uFFFE\uFFFF:[\]\\/?*]|^'|'$/u.test(name)||
       name.toLowerCase()==='history'||names.has(name.toLowerCase()))throw invalid('工作表名称无效或重复。');
    names.add(name.toLowerCase());
    const rows=Array.from(sheet.rows,row=>{
      if(!Array.isArray(row)||row.length>LIMITS.columns)throw invalid('每行最多 '+LIMITS.columns+' 个单元格。');
      cellCount+=row.length;
      if(cellCount>LIMITS.cells)throw invalid('工作簿最多 '+LIMITS.cells+' 个单元格。');
      return Array.from(row,cell);
    });
    if(!rows.some(row=>row.length))throw invalid('工作表至少须指定一个单元格。');
    return {name,rows,...(sheet.header?{header:true}:{})};
  });
  const normalized={sheets};
  if(Buffer.byteLength(JSON.stringify(normalized))>LIMITS.bytes)throw invalid('工作簿输入超出体积限制。');
  return normalized;
}

function absolutePath(value,extension) {
  return typeof value==='string'&&value.length<=2048&&!value.includes('\0')&&path.isAbsolute(value)&&
    (!extension||path.extname(value).toLowerCase()===extension);
}

function runWorker(executable,input,signal) {
  const abortError=()=>failure('EXCEL_CANCELLED','Excel 文件生成已取消。');
  if(signal?.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['-I','-B',WORKER],{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const chunks=[];
    let bytes=0;
    let stopped=null;
    let failedToStart=false;
    const stop=error=>{
      if(stopped)return;
      stopped=error;
      child.kill();
    };
    const onAbort=()=>stop(abortError());
    const timer=setTimeout(()=>stop(failure('EXCEL_TIMEOUT','本机 Excel 文件生成超时。')),45000);
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    child.once('error',()=>{failedToStart=true;});
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>8192)stop(failure('EXCEL_WRITE_FAILED',EXIT_MESSAGES.EXCEL_WRITE_FAILED));
      else chunks.push(chunk);
    });
    child.stdin.on('error',()=>{});
    child.once('close',code=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
      if(stopped)return reject(stopped);
      if(failedToStart)return reject(failure('EXCEL_DEPENDENCY_UNAVAILABLE',EXIT_MESSAGES.EXCEL_DEPENDENCY_UNAVAILABLE));
      let reply;
      try {reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      catch {return reject(failure('EXCEL_WRITE_FAILED',EXIT_MESSAGES.EXCEL_WRITE_FAILED));}
      if(code!==0||reply?.ok!==true) {
        const workerCode=Object.hasOwn(EXIT_MESSAGES,reply?.code)?reply.code:'EXCEL_WRITE_FAILED';
        return reject(failure(workerCode,EXIT_MESSAGES[workerCode]));
      }
      if(!parseWorkerResult(reply))return reject(failure('EXCEL_VALIDATION_FAILED',EXIT_MESSAGES.EXCEL_VALIDATION_FAILED));
      resolve({formulaCount:reply.formulaCount,cellCount:reply.cellCount,bytes:reply.bytes,sha256:reply.sha256,
        formulasCalculated:false,templateCopied:reply.templateCopied});
    });
    child.stdin.end(input,'utf8');
  });
}

function parseWorkerResult(reply) {
  return Number.isSafeInteger(reply.formulaCount)&&reply.formulaCount>=0&&Number.isSafeInteger(reply.cellCount)&&
    reply.cellCount>0&&reply.cellCount<=LIMITS.cells&&reply.formulaCount<=reply.cellCount&&
    Number.isSafeInteger(reply.bytes)&&reply.bytes>0&&typeof reply.sha256==='string'&&/^[a-f0-9]{64}$/u.test(reply.sha256)&&
    typeof reply.templateCopied==='boolean'&&reply.formulasCalculated===false;
}

// Trusted caller owns the staging path and optional private dependency directory.
export async function writeLocalExcel({workbook,templatePath,outputPath,pythonExecutable,dependencyPath,signal} = {}) {
  const normalized=validateExcelWorkbook(workbook);
  if(!absolutePath(outputPath,'.xlsx')||(templatePath!==undefined&&!absolutePath(templatePath,'.xlsx'))||
     (dependencyPath!==undefined&&!absolutePath(dependencyPath))||!absolutePath(pythonExecutable)) {
    throw invalid('Excel 执行器需要已验证的绝对本机路径。');
  }
  return runWorker(pythonExecutable,JSON.stringify({workbook:normalized,templatePath,outputPath,dependencyPath,
    formulaPatterns:FORMULA_PATTERNS,limits:LIMITS}),signal);
}
