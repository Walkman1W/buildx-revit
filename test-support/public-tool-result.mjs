import {CHAT_LIMITS,previewMcpResult} from '../lib/chat-session.mjs';

// Migrated from the legacy validation source, without its run directory or data.
// The public card is previewMcpResult's display representation, not raw MCP JSON.
// Only a complete single text JSON block, optionally followed by the explicit
// null structuredContent block observed in source-panel evidence, is accepted.
export function parsePublicToolResult(card){
  const reject=message=>{throw new Error(message+': '+(card?.name||'unknown tool'));};
  if(card?.status!=='returned'||card.error)reject('Tool did not return a successful public MCP receipt');
  const preview=card.resultPreview,prefix='[text]\n',nullTail='\n\n[structuredContent]\nnull';
  if(typeof preview!=='string'||!preview.startsWith(prefix))reject('Expected the existing workbench text-result protocol');
  if(preview.length>CHAT_LIMITS.preview||preview.includes('预览已截断'))
    reject('Tool receipt preview is incomplete; keep outcome unverified');
  const hasNullStructuredContent=preview.endsWith(nullTail);
  const text=preview.slice(prefix.length,hasNullStructuredContent?-nullTail.length:undefined);
  let value;
  try{value=JSON.parse(text);}catch{reject('The public tool receipt is not a complete JSON result');}
  if(!value||typeof value!=='object'||Array.isArray(value))reject('Invalid public tool payload');
  const roundTrip=previewMcpResult({content:[{type:'text',text}],
    ...(hasNullStructuredContent?{structuredContent:null}:{})});
  if(roundTrip!==preview)reject('Unknown public tool preview representation');
  return {value,format:hasNullStructuredContent?'text_json_and_null_structuredContent':'text_json',
    structuredContent:{present:hasNullStructuredContent,...(hasNullStructuredContent?{value:null}:{})}};
}
