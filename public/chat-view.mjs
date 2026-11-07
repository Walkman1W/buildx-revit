// A deliberately small Markdown vocabulary. Values become DOM text nodes only;
// raw HTML and executable URL schemes never enter an HTML parsing boundary.
export function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export function inlineTokens(value, depth = 0) {
  const text = String(value ?? '');
  if (depth > 3) return [{ type: 'text', text }];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  const tokens = []; let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) tokens.push({ type: 'text', text: text.slice(start, match.index) });
    if (match[1] !== undefined) tokens.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'strong', children: inlineTokens(match[2], depth + 1) });
    else {
      const href = safeLink(match[4]);
      tokens.push(href ? { type: 'link', href, children: inlineTokens(match[3], depth + 1) } : { type: 'text', text: match[0] });
    }
    start = match.index + match[0].length;
  }
  if (start < text.length) tokens.push({ type: 'text', text: text.slice(start) });
  return tokens;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function isTableRule(line) { const values = cells(line); return values.length > 1 && values.every(cell => /^:?-{3,}:?$/.test(cell)); }
function listMatch(line) { return /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line); }
function beginsBlock(lines, i) {
  return /^\s*```/.test(lines[i]) || /^#{1,4}\s/.test(lines[i]) || /^\s*>\s?/.test(lines[i]) || listMatch(lines[i]) || (i + 1 < lines.length && isTableRule(lines[i + 1]) && lines[i].includes('|'));
}

export function markdownBlocks(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const fence = /^\s*```([^\s`]*)[^`]*$/.exec(lines[i]);
    if (fence) {
      const content = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', language: fence[1], text: content.join('\n') }); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(lines[i]);
    if (heading) { blocks.push({ type: 'heading', level: Math.min(4, heading[1].length + 1), children: inlineTokens(heading[2]) }); i++; continue; }
    if (i + 1 < lines.length && lines[i].includes('|') && isTableRule(lines[i + 1])) {
      const header = cells(lines[i]).map(cell => inlineTokens(cell)); const rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const values = cells(lines[i++]); rows.push(header.map((_, column) => inlineTokens(values[column] ?? '')));
      }
      blocks.push({ type: 'table', header, rows }); continue;
    }
    const first = listMatch(lines[i]);
    if (first) {
      const ordered = Boolean(first[2]); const items = [];
      while (i < lines.length) {
        const item = listMatch(lines[i]);
        if (!item || Boolean(item[2]) !== ordered) break;
        let text = item[3]; i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listMatch(lines[i]) && !/^\s*```/.test(lines[i])) text += '\n' + lines[i++].trim();
        items.push(inlineTokens(text));
      }
      blocks.push({ type: 'list', ordered, start: ordered ? Number(first[2]) : null, items }); continue;
    }
    if (/^\s*>\s?/.test(lines[i])) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: inlineTokens(quote.join('\n')) }); continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !beginsBlock(lines, i)) paragraph.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: inlineTokens(paragraph.join('\n')) });
  }
  return blocks;
}

export function toolStatus(value) {
  return ({ running: '执行中', returned: '已返回', failed: '失败', unknown: '结果未知' })[value] ?? '结果未知';
}
export function modelToolEntries(catalog) {
  if (!Array.isArray(catalog)) return [];
  const names = new Set();
  return catalog.slice(0,1024).filter(tool => {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,159}$/.test(tool.name) || names.has(tool.name)) return false;
    names.add(tool.name); return true;
  });
}
export function modelToolCountLabel(catalog) {
  const readOnly = catalog.filter(tool => tool.readOnly === true).length;
  return `Revit 工具总数 ${catalog.length} 项 · 只读查询 ${readOnly} 项 · 其他操作 ${catalog.length - readOnly} 项`;
}
export function messageStatus(value) {
  return ({ streaming: '生成中', completed: '', failed: '回答失败', interrupted: '已停止', unknown: '结果未知' })[value] ?? '';
}
// Older servers stored receipt notices as errors. Match exact server templates
// and distinguish settled operations from scripts with unverified effects.
export function receiptNoticeState(message) {
  if (message?.role !== 'error') return null;
  const {status, text} = message;
  if (['completed','failed'].includes(status) && text === '已核实临时检查视图恢复，后续操作可以继续。')
    return {state:'completed', label:'已恢复', dismissible:true};
  if (status === 'completed' && text === '原模型操作回执已自动核实；后续操作已恢复。')
    return {state:'completed', label:'已核实', dismissible:true};
  if (status !== 'failed') return null;
  switch (text) {
    case '脚本已报错结束；已由用户核查模型并恢复后续操作。回滚及事务外影响仍未确认。':
      return {state:'unknown', label:'回滚与影响待核查', dismissible:false};
    case '脚本执行失败，已核实模型事务回滚；后续操作已恢复，事务外影响仍未核实。':
      return {state:'unknown', label:'事务外影响待核查', dismissible:false};
    case '原模型操作回执已核实（failed）；后续操作已恢复。':
      return {state:'failed', label:'操作失败', dismissible:true};
    case '原模型操作回执已核实（not_started）；后续操作已恢复。':
    case '原模型操作回执已核实（expired）；后续操作已恢复。':
      return {state:'completed', label:'未执行', dismissible:true};
    default:
      return null;
  }
}
export function receiptDismissalStore(storage) {
  const key = 'buildx-dismissed-receipts-v1';
  let entries = [];
  try { const parsed = JSON.parse(storage?.getItem(key) || '[]'); if (Array.isArray(parsed)) entries = parsed.filter(item => typeof item === 'string').slice(-500); } catch {}
  const values = new Set(entries);
  return {
    has: id => values.has(id),
    add(id) { values.add(id); while (values.size > 500) values.delete(values.values().next().value); try { storage?.setItem(key, JSON.stringify([...values])); } catch {} },
  };
}
export function previewText(value) {
  if (value === undefined || value === null || value === '') return '未提供';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function sessionMessages(session) {
  if (!Array.isArray(session?.messages)) return [];
  const seen = new Set();
  return session.messages.filter(message => {
    if (!message || !['user', 'assistant', 'error'].includes(message.role) || typeof message.id !== 'string' || seen.has(message.id)) return false;
    seen.add(message.id); return true;
  });
}
export function legacyDelta(messages, text, messageId = 'legacy-assistant') {
  const next = messages.map(message => ({ ...message }));
  const existing = next.find(message => message.id === messageId);
  if (existing) existing.text = String(existing.text ?? '') + String(text ?? '');
  else next.push({ id: messageId, role: 'assistant', text: String(text ?? ''), status: 'streaming', tools: [] });
  return next;
}
