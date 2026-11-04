import { readFileSync } from 'node:fs';
import { READ_TOOLS, LEGACY_PANEL_WORKBENCH_TOOLS } from './panel-tools.mjs';

// One editable application-owned prompt. Tool counts come from their named catalogs.
export function buildAssistantInstructions() {
  const bytes = readFileSync(new URL('../prompts/buildx-assistant.zh-CN.md', import.meta.url));
  if (bytes.length > 64 * 1024) throw new Error('BuildX 应用指令超过64KiB，请缩小提示词。');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!source.includes('{{READ_TOOL_COUNT}}') || !source.includes('{{WORKBENCH_TOOL_COUNT}}'))
    throw new Error('BuildX 应用指令缺少工具目录占位符。');
  const result = source.replaceAll('{{READ_TOOL_COUNT}}', String(READ_TOOLS.length))
    .replaceAll('{{WORKBENCH_TOOL_COUNT}}', String(LEGACY_PANEL_WORKBENCH_TOOLS.length));
  if (/\{\{[A-Z_]+\}\}/.test(result)) throw new Error('BuildX 应用指令包含未解析占位符。');
  return result;
}
