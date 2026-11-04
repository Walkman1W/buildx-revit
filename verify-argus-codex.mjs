import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {CodexClient} from './lib/codex-client.mjs';
import {connectionFromEnv, checkExecutionReadiness} from './lib/argus-readonly-probe.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const catalogOnly = process.argv.includes('--catalog-only');
const report = {recordedAt: new Date().toISOString(), catalogOnly, codexToolLoaded: false, toolCalled: false, realArgusVerified: false};
class ProbeClient extends CodexClient {
  constructor() { super(root); this.calls = []; }
  async request(method, params, timeout) {
    report.stage = method;
    return super.request(method, params, timeout);
  }
  async start() {
    const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const python = 'C:\\Users\\LENOVO\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
    const parsed = spawnSync(python, ['-c', 'import json,tomllib,sys; print(json.dumps(list(tomllib.load(open(sys.argv[1],"rb")).get("mcp_servers",{}))))', config], {encoding: 'utf8', windowsHide: true});
    if (parsed.status !== 0) throw new Error('CONFIG_NAMES_UNAVAILABLE');
    const names = JSON.parse(parsed.stdout);
    if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n)) || names.includes('argus_probe')) throw new Error('CONFIG_NAME_CONFLICT');
    const args = ['app-server', '--listen', 'stdio://', '--strict-config'];
    for (const name of names) args.push('-c', `mcp_servers.${name}.enabled=false`);
    for (const feature of ['shell_tool','apps','plugins','computer_use','browser_use','in_app_browser','image_generation','multi_agent','hooks','memories']) args.push('-c', `features.${feature}=false`);
    args.push('-c', 'features.code_mode_host=true', '-c', 'web_search="disabled"',
      '-c', `mcp_servers.argus_probe.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.argus_probe.args=${JSON.stringify([path.join(root, 'argus-probe.mjs'), '--mcp'])}`,
      '-c', 'mcp_servers.argus_probe.env_vars=["ARGUS_PROBE_URL","ARGUS_PROBE_TOKEN"]',
      '-c', 'mcp_servers.argus_probe.enabled_tools=["argus_readonly_probe"]',
      '-c', 'mcp_servers.argus_probe.tools.argus_readonly_probe.approval_mode="approve"');
    const exe = 'C:\\Users\\LENOVO\\AppData\\Local\\OpenAI\\Codex\\bin\\896a0166b774037a\\codex.exe';
    this.child = spawn(exe, args, {cwd: root, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (line.trim()) { try { this.dispatch(JSON.parse(line)); } catch { this.failed('INVALID_RPC'); } }
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.once('error', () => this.failed('CODEX_SPAWN_FAILED'));
    this.child.once('exit', () => this.failed('CODEX_EXITED'));
    await this.request('initialize', {clientInfo: {name: 'argus_probe_verification', version: '0.1.0'}});
    this.notify('initialized');
    const account = await this.request('account/read', {refreshToken: false});
    if (account.account?.type !== 'chatgpt') throw new Error('CHATGPT_LOGIN_REQUIRED');
    const result = await this.request('thread/start', {cwd: root, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      developerInstructions: '仅调用 argus_probe 的 argus_readonly_probe 工具一次，参数为 {}。禁止使用其他工具或改写脚本。根据实际工具结果用中文报告视图数量，失败就报告失败，不得假称执行成功。'});
    this.probeThread = result.thread.id;
    const catalog = await this.request('mcpServerStatus/list', {threadId: this.probeThread, serverName: 'argus_probe', detail: 'toolsAndAuthOnly', limit: 100}, 110000);
    const server = catalog.data?.find(row => row.name === 'argus_probe');
    if (server?.runtimeStatus !== 'connected' || server.toolsError || Object.keys(server.tools || {}).join() !== 'argus_readonly_probe') throw new Error('PROBE_CATALOG_NOT_READY');
    report.codexToolLoaded = true;
  }
}
const client = new ProbeClient();
let timer;
try {
  if (!catalogOnly) { await checkExecutionReadiness(); connectionFromEnv(); }
  await client.start();
  if (!catalogOnly) {
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TURN_TIMEOUT_EXECUTION_UNCONFIRMED')), 90000);
      client.on('notification', (method, params) => {
        if (params.threadId && params.threadId !== client.probeThread) return;
        if (method === 'item/completed' && params.item?.type === 'mcpToolCall' && params.item.tool === 'argus_readonly_probe') {
          report.toolCalled = true;
          const result = params.item.result;
          if (params.item.status === 'completed' && !params.item.error && result && !result.isError) {
            for (const content of result.content || []) {
              if (content.type !== 'text') continue;
              try { const value = JSON.parse(content.text); if (value.source === 'argus-original-coderunner' && value.probe === 'argus-codex-readonly-v1' && Number.isSafeInteger(value.viewCount)) { report.result = value; report.realArgusVerified = true; } } catch {}
            }
          }
        }
        if (method === 'turn/completed') resolve();
      });
    });
    await client.turn(client.probeThread, '调用原 Argus 的固定只读探针并报告结果。');
    await completed;
    if (!report.realArgusVerified) throw new Error('REAL_ARGUS_RESULT_NOT_VERIFIED');
  }
} catch (error) { report.failureCode = error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : 'VERIFICATION_FAILED'); if (Number.isInteger(error.rpcCode)) report.rpcCode = error.rpcCode; process.exitCode = 1; }
finally {
  clearTimeout(timer);
  await client.close();
  await fs.writeFile(path.join(root, 'runtime', catalogOnly ? 'argus-probe-catalog.json' : 'argus-probe-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
