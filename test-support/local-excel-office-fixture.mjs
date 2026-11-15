import {writeLocalExcel} from '../lib/local-excel.mjs';

const [outputPath,pythonExecutable]=process.argv.slice(2);
const workbook={sheets:[{name:'泵报价 Pump Quote',header:true,rows:[
  ['型号 / Model','数量 / Quantity','单价 / Unit price','金额 / Amount','复核 / Review'],
  ['BX-150-80',2,{value:12500,numberFormat:'#,##0.00'},{formula:'=B2*C2',numberFormat:'#,##0.00'},'核对原稿第 1 页'],
  ['合计 / Total',null,null,{formula:'=SUM(D2:D2)',numberFormat:'#,##0.00'}]
]}]};
const evidence=await writeLocalExcel({workbook,outputPath,pythonExecutable});
console.log(JSON.stringify(evidence));
