import {parsePublicToolResult} from './public-tool-result.mjs';

// Pure projection extracted from legacy verify-live-dialogue.mjs. Importing
// this test owner never loads the real-service verifier or its HTTP workflow.
export function parseCardResult(card){return parsePublicToolResult(card).value;}
