import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_FILE_MAX_BYTES = 512 * 1024;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultRoots = [
  ['buildx-lib', path.join(projectRoot, 'lib')],
  ['buildx-revit', path.join(projectRoot, 'revit-addin')],
  ['buildx-prompts', path.join(projectRoot, 'prompts')],
  ['buildx-public', path.join(projectRoot, 'public')],
  ['argus-source', path.resolve(projectRoot, '../_reference/argus-source-reconstruction-20261019/source')],
  ['aec-revit-source', path.resolve(projectRoot, '../../pumpbim/aec-model-bridge/packages/revit-bridge-addin/src')],
  ['aec-mcp-source', path.resolve(projectRoot, '../../pumpbim/aec-model-bridge/packages/mcp-server-revit/src')],
].map(([id, absolutePath]) => Object.freeze({ id, path: absolutePath }));
export const DEFAULT_SOURCE_ROOTS = Object.freeze(defaultRoots);

const extensions = new Set(['.cs', '.csproj', '.sln', '.props', '.targets', '.xaml', '.resx',
  '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.html', '.css', '.xml', '.toml', '.yaml', '.yml', '.svg']);
const excludedDirectories = new Set(['bin', 'obj', 'dist', 'build', 'out', 'output', 'outputs',
  'node_modules', 'coverage', '__pycache__', 'venv', 'runtime', 'workbench', 'queue',
  'inbox', 'outbox', 'logs', 'sessions', 'conversations', 'credentials', 'secrets', 'backups']);
const excludedFiles = new Set(['auth.json', 'credentials.json', 'credentials.toml', 'secrets.json',
  'secrets.toml', 'tokens.json', 'token.json', 'config.json', 'config.toml', 'settings.json',
  'appsettings.json', 'web.config', 'app.config']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => ({ ok: false, error: { code, message } });
const success = value => ({ ok: true, value });
const samePath = (a, b) => path.relative(a, b) === '';
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const ioFailure = error => fail(error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
  ? 'SOURCE_NOT_FOUND' : error?.code === 'EACCES' || error?.code === 'EPERM'
    ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_IO_ERROR', 'Source metadata could not be inspected within the configured root.');

function normalizeRootPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 32767) return null;
  // win32.isAbsolute accepts current-drive roots and UNC. Neither identifies
  // a fixed local source root: require the drive before resolving any spelling.
  if (process.platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(value) : !path.isAbsolute(value)) return null;
  const normalized = path.resolve(value);
  if (normalized.startsWith('\\\\') || normalized.startsWith('//') ||
      (process.platform === 'win32' && !/^[A-Za-z]:\\$/.test(path.parse(normalized).root))) return null;
  return normalized;
}

function parseRequest(request, roots) {
  if (!object(request) || typeof request.rootId !== 'string' || !roots.has(request.rootId))
    return fail('UNKNOWN_SOURCE_ROOT', 'Select a configured source root.');
  if (Object.keys(request).some(key => !['rootId', 'path'].includes(key)))
    return fail('INVALID_SOURCE_REQUEST', 'Source requests accept only rootId and a relative path.');
  if (typeof request.path !== 'string' || request.path.length > 32767 || request.path.includes('\\') ||
      path.posix.isAbsolute(request.path) || path.win32.isAbsolute(request.path))
    return fail('INVALID_SOURCE_PATH', 'Source paths must be relative POSIX paths.');
  const parts = request.path === '' ? [] : request.path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.length > 255 ||
        /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /^[ ]|[. ]$/.test(part) ||
        /~[0-9]/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$|conin\$|conout\$)(?:\.|$)/i.test(part))
      return fail('INVALID_SOURCE_PATH', 'Source paths cannot contain traversal, device names, streams or Windows aliases.');
    if (part.startsWith('.') || excludedDirectories.has(part.toLowerCase()) || /^(?:bin|obj)-/i.test(part))
      return fail('EXCLUDED_SOURCE_PATH', 'Hidden, generated, runtime and private paths are excluded.');
  }
  return success({ root: roots.get(request.rootId), parts, relativePath: parts.join('/') });
}

function metadata(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}
const sameIdentity = (a, b) => ['dev', 'ino', 'birthtimeNs'].every(key => a[key] === b[key]);
const sameMetadata = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => a[key] === b[key]);

// Each ancestor is checked again, including ancestors above the selected root.
// This rejects a root reached through a junction rather than blessing its target.
async function inspectRoot(root) {
  const volume = path.parse(root.path).root;
  const parts = root.path.slice(volume.length).split(path.sep).filter(Boolean);
  let current = volume, result;
  for (const part of [null, ...parts]) {
    if (part !== null) current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) return fail('SOURCE_LINK_REJECTED', 'Source roots cannot pass through links or junctions.');
    if (!stat.isDirectory()) return fail('SOURCE_ROOT_NOT_DIRECTORY', 'The configured source root must be a directory.');
    const realPath = await fs.realpath(current);
    if (!samePath(current, realPath)) return fail('SOURCE_ROOT_CHANGED', 'The configured root has a noncanonical filesystem identity.');
    result = { absolutePath: realPath, ...metadata(stat) };
  }
  return success(result);
}

/**
 * Metadata-only source boundary. It does not read source bytes, enumerate trees,
 * enforce a traversal/file-count budget, execute code or register model tools.
 * This is not an OS sandbox: an actively mutating local process can race checks.
 * Callers must not treat the returned path as a durable permission or read handle.
 */
export function createSourcePolicy(options = {}) {
  if (!object(options) || Object.keys(options).some(key => !['roots', 'maxFileBytes'].includes(key)))
    return fail('INVALID_SOURCE_POLICY', 'Source policy options must name roots and an optional byte budget.');
  const { roots = DEFAULT_SOURCE_ROOTS, maxFileBytes = SOURCE_FILE_MAX_BYTES } = options;
  if (!Array.isArray(roots) || roots.length === 0 || !Number.isSafeInteger(maxFileBytes) ||
      maxFileBytes < 1 || maxFileBytes > SOURCE_FILE_MAX_BYTES)
    return fail('INVALID_SOURCE_POLICY', 'Source roots and a positive budget no greater than 512 KiB are required.');
  const copied = [], ids = new Set();
  for (const root of roots) {
    const normalizedPath = object(root) ? normalizeRootPath(root.path) : null;
    if (!object(root) || typeof root.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(root.id) ||
        ids.has(root.id) || normalizedPath === null)
      return fail('INVALID_SOURCE_POLICY', 'Roots require unique IDs and explicit local absolute directories.');
    ids.add(root.id);
    copied.push(Object.freeze({ id: root.id, path: normalizedPath }));
  }
  const registered = Object.freeze(copied), byId = new Map(registered.map(root => [root.id, root]));
  const boundRoots = new Map();

  async function checkedRoot(root) {
    const result = await inspectRoot(root);
    if (!result.ok) return result;
    const prior = boundRoots.get(root.id);
    if (prior && (!samePath(prior.absolutePath, result.value.absolutePath) || !sameIdentity(prior, result.value)))
      return fail('SOURCE_ROOT_CHANGED', 'The configured source root was replaced during this policy session.');
    if (!prior) boundRoots.set(root.id, Object.freeze({ ...result.value }));
    return result;
  }

  async function inspect(request) {
    const parsed = parseRequest(request, byId);
    if (!parsed.ok) return parsed;
    const { root, parts, relativePath } = parsed.value;
    try {
      const rootResult = await checkedRoot(root);
      if (!rootResult.ok) return rootResult;
      const rootIdentity = rootResult.value, examined = [];
      let current = root.path, finalStat;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const stat = await fs.lstat(current, { bigint: true });
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1n))
          return fail('SOURCE_LINK_REJECTED', 'Links, hard links and junctions are excluded from source inspection.');
        const realPath = await fs.realpath(current);
        if (!inside(rootIdentity.absolutePath, realPath) || !samePath(current, realPath))
          return fail('SOURCE_OUTSIDE_ROOT', 'The resolved source is outside its configured root or uses an alias.');
        if (!stat.isDirectory() && !stat.isFile())
          return fail('SOURCE_NOT_REGULAR', 'Only ordinary source files and directories are supported.');
        if (index < parts.length - 1 && !stat.isDirectory())
          return fail('SOURCE_NOT_DIRECTORY', 'An intermediate source path is not a directory.');
        examined.push({ path: current, metadata: metadata(stat), directory: stat.isDirectory() });
        finalStat = stat;
      }
      const kind = finalStat?.isFile() ? 'file' : 'directory';
      if (kind === 'file') {
        const name = parts.at(-1).toLowerCase();
        if (excludedFiles.has(name) || /^appsettings\..*\.json$/.test(name) || !extensions.has(path.extname(name)))
          return fail('EXCLUDED_SOURCE_FILE', 'This file is not in the allowed source-file set.');
        if (finalStat.size > BigInt(maxFileBytes))
          return fail('SOURCE_FILE_TOO_LARGE', 'Source file exceeds the configured pre-read byte budget.');
      }
      const afterRoot = await checkedRoot(root);
      if (!afterRoot.ok) return afterRoot;
      for (const item of examined) {
        const stat = await fs.lstat(item.path, { bigint: true });
        const realPath = await fs.realpath(item.path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1n) ||
            !inside(rootIdentity.absolutePath, realPath) || !samePath(item.path, realPath) ||
            !sameMetadata(item.metadata, metadata(stat)) || (item.directory ? !stat.isDirectory() : !stat.isFile()))
          return fail('SOURCE_IDENTITY_CHANGED', 'Source identity changed during metadata inspection.');
      }
      const statMetadata = finalStat ? metadata(finalStat) : metadata(await fs.lstat(root.path, { bigint: true }));
      return success({ schemaVersion: 1, rootId: root.id, path: relativePath, kind,
        absolutePath: current, rootIdentity: { ...afterRoot.value }, ...statMetadata,
        byteLength: kind === 'file' ? Number(finalStat.size) : null,
        maxFileBytes, sha256: null, hashStatus: 'not_computed', contentsRead: false });
    } catch (error) { return ioFailure(error); }
  }

  // The caller must retain the original trusted inspect result internally. This
  // helper has no issued-snapshot registry or signature: client-provided stat
  // fields are not proof of an issued identity. Do not expose this argument as
  // a model/client permission token; a future transport must own its snapshots.
  async function revalidate(identity) {
    if (!object(identity) || identity.schemaVersion !== 1 || !object(identity.rootIdentity) ||
        !['file', 'directory'].includes(identity.kind))
      return fail('INVALID_SOURCE_IDENTITY', 'A previous source metadata identity is required.');
    // Only rootId/path select the source; supplied absolute paths never select IO.
    const result = await inspect({ rootId: identity.rootId, path: identity.path });
    if (!result.ok) return result;
    const actual = result.value;
    if (actual.kind !== identity.kind || !sameMetadata(actual, identity) ||
        actual.rootIdentity.absolutePath !== identity.rootIdentity.absolutePath ||
        !sameIdentity(actual.rootIdentity, identity.rootIdentity))
      return fail('SOURCE_IDENTITY_CHANGED', 'Source metadata no longer matches the previous identity.');
    return result;
  }

  return success(Object.freeze({ roots: registered, maxFileBytes, inspect, revalidate }));
}
