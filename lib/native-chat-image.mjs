import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {accessDirectoryChain, normalizeAccessPath, verifyAccessDirectoryChain} from './access-policy.mjs';
import {verifiedPng} from './local-image-generation.mjs';

const maxImageBytes = 12 * 1024 * 1024;

function unavailable() {
  return Object.assign(new Error('Codex 图片无法在本轮本机输出目录核实，请检查原回执。'), {
    localToolCode: 'NATIVE_IMAGE_OUTPUT_UNVERIFIED', outcome: 'unknown',
  });
}

function fingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function imagePathComponent(id) {
  return id.replace(/[^A-Za-z0-9_-]/gu, '_');
}

// The caller binds the native notification to its current account, thread and
// turn before calling. Provider paths are never published in chat history.
export async function readNativeChatImage({item, threadId, generatedImagesRoot, startedAtMs, isCurrent} = {}) {
  try {
    if (item?.type !== 'imageGeneration' || item.status !== 'completed' ||
        typeof threadId !== 'string' || !threadId || typeof item.id !== 'string' || !item.id ||
        !Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !isCurrent()) throw unavailable();

    const root = normalizeAccessPath(generatedImagesRoot);
    const expected = path.join(imagePathComponent(threadId), imagePathComponent(item.id) + '.png');
    const imagePath = normalizeAccessPath(item.savedPath);
    if (path.relative(root, imagePath) !== expected) throw unavailable();

    const chain = await accessDirectoryChain(path.dirname(imagePath));
    const named = await fs.lstat(imagePath, {bigint: true});
    const startedAtNs = BigInt(startedAtMs) * 1_000_000n;
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.ino === 0n ||
        named.mtimeNs < startedAtNs || named.size < 45n || named.size > BigInt(maxImageBytes) ||
        path.relative(imagePath, await fs.realpath(imagePath)) || !isCurrent()) throw unavailable();

    const identity = fingerprint(named);
    const handle = await fs.open(imagePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (fingerprint(await handle.stat({bigint: true})) !== identity) throw unavailable();
      const bytes = Buffer.alloc(Number(named.size));
      let offset = 0;
      while (offset < bytes.length) {
        const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw unavailable();
        offset += bytesRead;
      }
      if (fingerprint(await handle.stat({bigint: true})) !== identity ||
          fingerprint(await fs.lstat(imagePath, {bigint: true})) !== identity) throw unavailable();
      await verifyAccessDirectoryChain(chain);
      if (!verifiedPng(bytes) || !isCurrent()) throw unavailable();
      return bytes;
    } finally {
      await handle.close();
    }
  } catch {
    throw unavailable();
  }
}
