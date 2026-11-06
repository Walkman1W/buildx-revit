// Execute against a locally compiled helper, using a NEW disposable evidence directory.
// This exercises the OS launcher directly, without Revit or any installed panel service.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const [helper, python, powershell, evidence] = process.argv.slice(2);
for (const value of [helper, python, powershell, evidence]) assert(value && path.isAbsolute(value));
await mkdir(evidence, {recursive: false});
const hasFile = file => stat(file).then(x => x.isFile(), error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const listener = net.createServer(client => client.end());
await new Promise((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolve);
});
const escaped = path.join(evidence, '外部-不应写入.txt');
const results = {};

async function run(name, script, options) {
  const owner = path.join(evidence, name);
  const work = path.join(owner, '中文 工作区');
  const control = path.join(owner, 'private control');
  await Promise.all([mkdir(work, {recursive: true}), mkdir(control, {recursive: true})]);
  const file = path.join(work, options.powerShell ? '执行 脚本.ps1' : '执行 脚本.py');
  await writeFile(file, script);
  const receipt = path.join(control, 'result.json');
  const interpreter = options.powerShell ? powershell : python;
  const argv = options.powerShell
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
    : ['-X', 'utf8', '-u', file, ...(options.extra ?? [])];
  const child = spawn(helper, [work, String(options.timeout ?? 15000), receipt, interpreter, ...argv], {
    cwd: owner, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const stdout = [], stderr = [];
  let stopSent = false;
  if (options.cancelBeforeStart) {
    stopSent = true;
    child.stdin.write('stop\n');
  }
  child.stdout.on('data', chunk => {
    stdout.push(chunk);
    if ((options.cancel || options.disconnect) && !stopSent && Buffer.concat(stdout).includes('child-ready')) {
      stopSent = true;
      if (options.disconnect) child.stdin.end();
      else child.stdin.write('stop\n');
    }
  });
  child.stderr.on('data', chunk => stderr.push(chunk));
  const helperExit = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('launcher test did not settle'));
    }, 40000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve(code); });
  });
  const result = {
    helperExit, stopSent, work, stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'), receipt: JSON.parse(await readFile(receipt, 'utf8')),
  };
  results[name] = result;
  return result;
}

function assertExited(r, {exitCode, stopReason = null, pythonStaged = true}) {
  assert.equal(r.helperExit, 0, JSON.stringify(r));
  assert.equal(r.receipt.started, true, JSON.stringify(r));
  assert.equal(r.receipt.exitConfirmed, true);
  assert.equal(r.receipt.exitCode, exitCode);
  assert.equal(r.receipt.stopReason, stopReason);
  assert.equal(r.receipt.outputComplete, true);
  assert.equal(r.receipt.profileRemoved, true);
  assert.equal(r.receipt.interpreterStaged, pythonStaged);
  if (pythonStaged) assert.equal(r.receipt.runtimeStageCleaned, true);
  assert.deepEqual(r.receipt.containment, {
    appContainer: true, zeroNetworkCapabilities: true, jobObject: true, activeProcesses: 0,
  });
}

const pythonCsv = [
  'import csv, pathlib, socket, sys',
  'with open("数据.csv", "w", newline="", encoding="utf-8") as f:',
  '    csv.writer(f).writerows([["构件", "数量"], ["阀门", 3]])',
  'try:',
  '    pathlib.Path(sys.argv[1]).write_text("outside")',
  'except OSError: print("outside-denied", flush=True)',
  'else: print("outside-written", flush=True)',
  'try:',
  '    socket.create_connection(("127.0.0.1", int(sys.argv[2])), 0.5).close()',
  'except OSError: print("loopback-denied", flush=True)',
  'else: print("loopback-connected", flush=True)',
  'print("中文 标准输出", flush=True)',
  'print("中文 错误输出", file=sys.stderr, flush=True)',
  'sys.exit(7)',
].join('\n');
const powershellCsv = [
  '\ufeff[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$ErrorActionPreference = "Stop"',
  'New-PSDrive -Name BuildX -PSProvider FileSystem -Root $PSScriptRoot | Out-Null',
  'Set-Location -LiteralPath "BuildX:\\"',
  '[pscustomobject]@{构件="阀门"; 数量=3} | Export-Csv -LiteralPath "数据.csv" -Encoding UTF8 -NoTypeInformation',
  '"中文 标准输出"',
  '[Console]::Error.WriteLine("中文 错误输出")',
  'exit 3',
].join('\r\n');
const tree = [
  'import pathlib, subprocess, sys, time',
  'marker = pathlib.Path.cwd() / "child-sentinel.txt"',
  'delay = sys.argv[1]',
  'script = "import pathlib,sys,time;time.sleep(float(sys.argv[2]));pathlib.Path(sys.argv[1]).write_text(chr(65))"',
  'subprocess.Popen([sys.executable, "-c", script, str(marker), delay], close_fds=True, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)',
  'print("child-ready", flush=True)',
  'time.sleep(float(sys.argv[2]))',
].join('\n');

try {
  const py = await run('python-csv', pythonCsv, {extra: [escaped, String(listener.address().port)]});
  assertExited(py, {exitCode: 7});
  assert.match(py.stdout, /outside-denied/);
  assert.match(py.stdout, /loopback-denied/);
  assert.match(py.stdout, /中文 标准输出/);
  assert.match(py.stderr, /中文 错误输出/);
  assert.match(await readFile(path.join(py.work, '数据.csv'), 'utf8'), /构件,数量\r?\n阀门,3/);
  assert.equal(await hasFile(escaped), false);

  const ps = await run('powershell-csv', powershellCsv, {powerShell: true});
  assertExited(ps, {exitCode: 3, pythonStaged: false});
  assert.match(ps.stdout, /中文 标准输出/);
  assert.match(ps.stderr, /中文 错误输出/);
  assert.match(await readFile(path.join(ps.work, '数据.csv'), 'utf8'), /"构件","数量"\r?\n"阀门","3"/);

  const large = await run('large-output', 'import sys; print("\u6c34" * 100000); print("\u9600" * 100000, file=sys.stderr)', {});
  assertExited(large, {exitCode: 0});
  assert.equal(large.stdout.match(/水/g)?.length, 100000);
  assert.equal(large.stderr.match(/阀/g)?.length, 100000);
  results['large-output'] = {receipt: large.receipt, stdoutBytes: Buffer.byteLength(large.stdout),
    stderrBytes: Buffer.byteLength(large.stderr)};

  const normal = await run('job-normal-tree', tree, {extra: ['1.0', '0']});
  assertExited(normal, {exitCode: 0});
  assert.equal(await hasFile(path.join(normal.work, 'child-sentinel.txt')), true,
    'normal root exit must wait until its detached descendant finishes');

  const timeout = await run('job-timeout-tree', tree, {extra: ['2.0', '20'], timeout: 1000});
  assertExited(timeout, {exitCode: 1223, stopReason: 'timeout'});
  assert.match(timeout.stdout, /child-ready/);

  const cancelled = await run('job-cancel-tree', tree, {extra: ['2.0', '20'], cancel: true});
  assert.equal(cancelled.stopSent, true);
  assertExited(cancelled, {exitCode: 1223, stopReason: 'cancelled'});
  const disconnected = await run('job-disconnect-tree', tree, {extra: ['2.0', '20'], disconnect: true});
  assert.equal(disconnected.stopSent, true);
  assertExited(disconnected, {exitCode: 1223, stopReason: 'cancelled'});
  const beforeStart = await run('job-cancel-before-start', 'raise AssertionError("interpreter must not execute")', {cancelBeforeStart: true});
  assert.equal(beforeStart.helperExit, 1);
  assert.equal(beforeStart.receipt.started, false);
  assert.equal(beforeStart.receipt.exitConfirmed, true);
  assert.equal(beforeStart.receipt.exitCode, null);
  assert.equal(beforeStart.receipt.code, 'cancelled_before_start');
  await sleep(2200);
  for (const r of [timeout, cancelled, disconnected]) assert.equal(await hasFile(path.join(r.work, 'child-sentinel.txt')), false);
  console.log(JSON.stringify({passed: Object.keys(results), evidence}));
} finally {
  await writeFile(path.join(evidence, 'launcher-results.json'), JSON.stringify(results, null, 2) + '\n');
  listener.close();
}
