import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('installed Revit host validates its own installation and service identity', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('./revit-addin/LocalCodexRevit.cs', import.meta.url), 'utf8');
  const match = source.match(/\/\/ BEGIN BUILDX INSTALLATION\s*([\s\S]*?)\s*\/\/ END BUILDX INSTALLATION/);
  assert.ok(match, 'production installation implementation must exist');
  const tempRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(path.join(tempRoot, 'buildx-portable-test-')));
  const program = `using System; using System.IO; using System.Runtime.Serialization; using System.Runtime.Serialization.Json; using System.Collections.Generic; using System.Web.Script.Serialization;
namespace RevitLocalCodex { ${match[1]}
class Test {
  static void Check(bool ok, string name) { if (!ok) throw new Exception(name); }
  static void Invalid(string assembly) { try { BuildXInstallation.FromAssemblyLocation(assembly); throw new Exception("invalid input accepted"); } catch(BuildXInstallationException) {} }
  static void Main(string[] args) {
    string root = args[0]; string bin = Path.Combine(root,"revit-addin","bin"); Directory.CreateDirectory(bin);
    string assembly = Path.Combine(bin,"LocalCodexRevit.dll"); File.WriteAllText(Path.Combine(root,"server.mjs"), "");
    string cfg = Path.Combine(root,"buildx-installation.json");
    string node = Path.Combine(root,"runtime","node.exe"), python = Path.Combine(root,"runtime","python.exe"), codex = Path.Combine(root,"runtime","codex.exe");
    var d = new Dictionary<string,object> { {"schemaVersion",1}, {"installationId","aa159a01-0b21-4da8-95ab-8f2488a24ffe"}, {"nodeExecutable",node}, {"pythonExecutable",python}, {"codexExecutable",codex} };
    var json = new JavaScriptSerializer();
    Action write = delegate { File.WriteAllText(cfg,json.Serialize(d)); };
    Invalid(assembly); write();
    var x = BuildXInstallation.FromAssemblyLocation(assembly);
    Check(x.Root == root && !x.DevelopmentMode && x.NodeExecutable == node && x.PythonExecutable == python && x.CodexExecutable == codex, "parsed config");
    Check(x.MatchesService("revit-local-codex", x.InstallationId), "same installation");
    Check(!x.MatchesService("other",x.InstallationId) && !x.MatchesService("revit-local-codex",null) && !x.MatchesService("revit-local-codex","ba159a01-0b21-4da8-95ab-8f2488a24ffe"), "unexpected service");
    Invalid(Path.Combine(root,"unrelated","bin","LocalCodexRevit.dll"));
    d["installationId"]="AA159A01-0B21-4DA8-95AB-8F2488A24FFE"; write(); Invalid(assembly);
    d["installationId"]="aa159a01-0b21-1da8-95ab-8f2488a24ffe"; write(); Invalid(assembly);
    d["installationId"]="aa159a01-0b21-4da8-95ab-8f2488a24ffe"; d["schemaVersion"]=2; write(); Invalid(assembly);
    d["schemaVersion"]=1; d["nodeExecutable"]="node.exe"; write(); Invalid(assembly);
    d["nodeExecutable"]=node; d["pythonExecutable"]=Path.Combine(root,"runtime","other.exe"); write(); Invalid(assembly);
    d["pythonExecutable"]=python; d["codexExecutable"]=null; write(); Invalid(assembly);
    File.WriteAllText(cfg,new string('x',4097)); Invalid(assembly);
  }
}}`;
  try {
    const cs = path.join(directory, 'test.cs');
    const exe = path.join(directory, 'test.exe');
    writeFileSync(cs, program);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/utf8output', '/reference:System.Runtime.Serialization.dll', '/reference:System.Web.Extensions.dll', `/out:${exe}`, cs]);
    execFileSync(exe, [path.join(directory, 'instance')]);
  } finally {
    assert.equal(path.dirname(directory).toLowerCase(), tempRoot.toLowerCase());
    assert.match(path.basename(directory), /^buildx-portable-test-/);
    assert.equal(realpathSync(directory).toLowerCase(), directory.toLowerCase());
    rmSync(directory, { recursive: true, force: true });
  }
});
