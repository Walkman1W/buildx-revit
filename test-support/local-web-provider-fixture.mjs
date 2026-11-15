import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const observations = {pid: process.pid, calls: [], forwardedHome: Boolean(process.env.HOME || process.env.USERPROFILE), flags: process.argv.slice(2)};
const observedFile = fileURLToPath(new URL('./observed.json', import.meta.url));
const persist = () => writeFileSync(observedFile, JSON.stringify(observations));
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\n');
const output = (url, title, description) => ({type: 'text', text: JSON.stringify({url, title, description})});
const requests = createInterface({input: process.stdin});
persist();
for await (const line of requests) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(message.id, {protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'brave-search-mcp-server', version: '2.1.4'}});
  }
  if (message.method === 'tools/list') {
    const tools = [{name: 'brave_web_search'}];
    if (fileURLToPath(import.meta.url).includes('wide-provider.mjs')) tools.push({name: 'brave_image_search'});
    reply(message.id, {tools});
  }
  if (message.method === 'tools/call') {
    observations.calls.push(message.params);
    persist();
    switch (message.params.arguments.query) {
      case 'test no result':
        reply(message.id, {isError: true, content: [{type: 'text', text: 'No web results found'}]});
        break;
      case 'test provider failure':
        reply(message.id, {isError: true, content: [{type: 'text', text: `status 401 ${process.env.BRAVE_API_KEY}`}]});
        break;
      case 'test large response':
        reply(message.id, {content: [{type: 'text', text: 'x'.repeat(280000)}]});
        break;
      case 'test wait for cancellation':
        break;
      default:
        reply(message.id, {content: [
          output('https://example.com/docs/pump', '<b>Example Pump</b>', 'Bilingual pump 公制水泵'),
          output('https://example.com/docs/pump', 'duplicate', 'ignored'),
          output('javascript:alert(1)', 'bad link', 'ignored'),
          output('http://127.0.0.1/private', 'private result', 'ignored'),
          output(`https://example.com/${encodeURIComponent(process.env.BRAVE_API_KEY)}`, 'key link', 'ignored'),
          output('https://example.org/pumps', 'Second source', `omit ${process.env.BRAVE_API_KEY}`),
        ]});
    }
  }
}
