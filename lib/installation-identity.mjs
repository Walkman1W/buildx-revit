import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveLocalRuntimes} from './local-runtimes.mjs';

// The installer owns this non-secret identifier; absent configuration is a
// legacy development deployment, while malformed configuration is never one.
export async function readInstallationConfiguration(root) {
  const file = path.join(root, 'buildx-installation.json');
  let text;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('invalid');
    text = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 4096) throw new Error('invalid');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('BuildX installation configuration is invalid or unavailable.');
  }
  let config;
  try { config = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('BuildX installation configuration is invalid or unavailable.'); }
  const executable = (value, name) => typeof value === 'string' && value.length <= 1024 &&
    /^[A-Za-z]:\\/.test(value) && path.win32.basename(value).toLowerCase() === name &&
    path.win32.normalize(value).toLowerCase() === value.toLowerCase();
  if (!config || Array.isArray(config) || typeof config !== 'object' || config.schemaVersion !== 1 ||
      typeof config.installationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.installationId) ||
      !executable(config.nodeExecutable, 'node.exe') || !executable(config.pythonExecutable, 'python.exe') ||
      !executable(config.codexExecutable, 'codex.exe')) {
    throw new Error('BuildX installation configuration is invalid or unavailable.');
  }
  return Object.freeze({installationId:config.installationId,nodeExecutable:config.nodeExecutable,
    pythonExecutable:config.pythonExecutable,codexExecutable:config.codexExecutable});
}

// An installed service uses the same confirmed programs as the Revit add-in,
// even when started manually with unrelated inherited environment variables.
export function resolveInstallationRuntimes(configuration, env=process.env) {
  return resolveLocalRuntimes({env:{...env,BUILDX_CODEX_EXE:configuration.codexExecutable,
    BUILDX_PYTHON_EXE:configuration.pythonExecutable}});
}
