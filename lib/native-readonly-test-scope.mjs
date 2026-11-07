import fs from 'node:fs/promises';
import path from 'node:path';

export async function isNativeReadonlyTest(root) {
  const marker = path.join(root, 'buildx-test-scope.json');
  let info;
  try { info = await fs.lstat(marker); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const invalid = () => new Error('BuildX 内部测试范围标记无效。');
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw invalid();
  const text = await fs.readFile(marker, 'utf8');
  // Fixed marker emitted by the package builder; reject additional keys and
  // duplicate scope claims rather than using the last JSON field.
  if (!/^\s*\{\s*"schemaVersion"\s*:\s*1\s*,\s*"scope"\s*:\s*"native-readonly"\s*\}\s*$/.test(text)) throw invalid();
  return true;
}
