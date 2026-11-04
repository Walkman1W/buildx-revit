import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('auto-start preference defaults off, persists both choices, and rejects malformed values', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('./revit-addin/LocalCodexRevit.cs', import.meta.url), 'utf8');
  const match = source.match(/\/\/ BEGIN AUTO START PREFERENCE\s*([\s\S]*?)\s*\/\/ END AUTO START PREFERENCE/);
  assert.ok(match, 'production preference implementation must be present');
  const key = `Software\\BuildXAutoStartTests\\${randomUUID()}`;
  const implementation = match[1].replace('Software\\BuildX\\Revit', key);
  assert.notEqual(implementation, match[1]);
  const directory = mkdtempSync(join(tmpdir(), 'buildx-autostart-test-'));
  const program = `using System;\nusing Microsoft.Win32;\nnamespace RevitLocalCodex {\n${implementation}\nclass Test {\nstatic void Expect(bool condition) { if (!condition) throw new Exception("preference assertion failed"); }\nstatic void Main() {\ntry {\nExpect(AutoStartPreference.Read() == false);\nusing (var key = Registry.CurrentUser.CreateSubKey(@"${key}")) {}\nExpect(AutoStartPreference.Read() == false);\nAutoStartPreference.Write(false); Expect(AutoStartPreference.Read() == false);\nAutoStartPreference.Write(true); Expect(AutoStartPreference.Read() == true);\nusing (var key = Registry.CurrentUser.OpenSubKey(@"${key}", true)) { key.SetValue("AutoStart", "invalid", RegistryValueKind.String); }\nExpect(AutoStartPreference.Read() == null);\n} finally { Registry.CurrentUser.DeleteSubKeyTree(@"${key}", false); }\n}\n}\n}`;
  try {
    const cs = join(directory, 'test.cs');
    const exe = join(directory, 'test.exe');
    writeFileSync(cs, program);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/utf8output', `/out:${exe}`, cs]);
    execFileSync(exe);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoring a pane with auto-start off leaves manual open available', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('./revit-addin/LocalCodexRevit.cs', import.meta.url), 'utf8');
  const loaded = source.match(/Loaded \+= delegate\s*\{([\s\S]*?)\n            \};/);
  const requests = source.match(/(        public void RequestOpen\(\)[\s\S]*?)(?=        private async void InitializeOrNavigate)/);
  assert.ok(loaded && requests, 'production pane entry points must be present');
  const directory = mkdtempSync(join(tmpdir(), 'buildx-pane-test-'));
  const program = `using System;\nnamespace RevitLocalCodex {\nstatic class App { internal static bool AutoStartEnabled; }\nclass Pane {\nbool requested, startWhenLoaded, reloadWhenLoaded, disposed, initializing, pendingOpen, pendingReload;\npublic bool IsLoaded; public int Starts; public bool Retry;\nvoid ShowStartup(string message, bool canRetry) { Retry = canRetry; }\nvoid InitializeOrNavigate(bool allow, bool reload) { if (!allow) throw new Exception("unexpected probe"); Starts++; }\npublic void Loaded() { ${loaded[1]} }\n${requests[1]}\npublic static void Main() {\nApp.AutoStartEnabled = false; var restored = new Pane { IsLoaded = true }; restored.Loaded();\nif (restored.Starts != 0 || !restored.Retry) throw new Exception("restored pane should wait");\nrestored.RequestOpen(); if (restored.Starts != 1) throw new Exception("manual open was lost");\nApp.AutoStartEnabled = true; var automatic = new Pane { IsLoaded = true }; automatic.Loaded();\nif (automatic.Starts != 1) throw new Exception("automatic open failed");\nApp.AutoStartEnabled = false; var queued = new Pane(); queued.RequestOpen(); queued.IsLoaded = true; queued.Loaded();\nif (queued.Starts != 1) throw new Exception("queued manual open was lost");\n}\n}\n}`;
  try {
    const cs = join(directory, 'test.cs');
    const exe = join(directory, 'test.exe');
    writeFileSync(cs, program);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/utf8output', `/out:${exe}`, cs]);
    execFileSync(exe);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
