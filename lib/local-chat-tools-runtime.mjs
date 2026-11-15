import {createLocalChatTools} from './local-chat-tools.mjs';
import {scanLocalPdf} from './local-scan-pdf.mjs';
import {validateExcelWorkbook,writeLocalExcel} from './local-excel.mjs';
import {validateLocalWebQuery,searchLocalWeb} from './local-web-search.mjs';
import {generateLocalImage} from './local-image-generation.mjs';

// Startup options live in the local process environment. Model calls have
// access to neither executable paths nor network endpoints or API credentials.
export function createInstalledLocalChatTools({paths,installation,env=process.env}){
  if(env.BUILDX_INTERNAL_CHAT_TOOLS!=='1')return null;
  const python=installation?.pythonExecutable;
  return createLocalChatTools({dataRoot:paths.dataRoot,
    scanPdf:args=>scanLocalPdf({...args,pythonExecutable:env.BUILDX_OCR_PYTHON_EXE||python,
      ocrExecutable:env.BUILDX_TESSERACT_EXE,ocrDataDirectory:env.BUILDX_TESSDATA_DIR}),
    validateWorkbook:validateExcelWorkbook,
    writeWorkbook:args=>writeLocalExcel({...args,pythonExecutable:env.BUILDX_EXCEL_PYTHON_EXE||python,dependencyPath:env.BUILDX_EXCEL_PYTHON_DEPS}),
    validateQuery:validateLocalWebQuery,
    ...env.BUILDX_NATIVE_WEB_SEARCH!=='1'?{searchWeb:args=>searchLocalWeb({...args,braveRoot:env.BUILDX_BRAVE_MCP_ROOT,apiKey:env.BRAVE_API_KEY})}:{},
    generateImage:args=>generateLocalImage({...args,apiKey:env.BUILDX_IMAGES_API_KEY})});
}
