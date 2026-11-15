import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {crc32, deflateSync} from 'node:zlib';
import {readNativeChatImage} from './lib/native-chat-image.mjs';

const rejected = {localToolCode: 'NATIVE_IMAGE_OUTPUT_UNVERIFIED', outcome: 'unknown'};

function makePng() {
  function chunk(type, contents) {
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), contents]);
    const output = Buffer.alloc(payload.length + 8);
    output.writeUInt32BE(contents.length);
    payload.copy(output, 4);
    output.writeUInt32BE(crc32(payload), output.length - 4);
    return output;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 127]))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t) {
  const privateRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'buildx-native-image-'));
  t.after(() => fs.rm(privateRoot, {recursive: true, force: true}));
  const generatedImagesRoot = path.join(privateRoot, 'generated_images');
  const startedAtMs = Date.now() - 1000;
  const directory = path.join(generatedImagesRoot, 'thread');
  await fs.mkdir(directory, {recursive: true});
  const png = makePng();
  const savedPath = path.join(directory, 'result.png');
  await fs.writeFile(savedPath, png);
  const item = {type: 'imageGeneration', id: 'result', status: 'completed', savedPath};
  return {privateRoot, directory, png, item, args: {item, threadId: 'thread', generatedImagesRoot, startedAtMs, isCurrent: () => true}};
}

test('reads a full native PNG from the active generated images root', async t => {
  const {args, png, directory, item} = await fixture(t);
  assert.deepEqual(await readNativeChatImage(args), png);
  const savedPath = path.join(directory, 'ig___id.png');
  await fs.writeFile(savedPath, png);
  assert.deepEqual(await readNativeChatImage({...args, item: {...item, id: 'ig:💧/id', savedPath}}), png);
  await assert.rejects(readNativeChatImage({...args, threadId: 'another-thread'}), rejected);
  await assert.rejects(readNativeChatImage({...args, item: {...item, id: 'another-result'}}), rejected);
  await assert.rejects(readNativeChatImage({...args, item: {...item, id: 'Result'}}), rejected);
});

test('rejects old, unfinished, stale and invalid PNG results', async t => {
  const {args, item, png} = await fixture(t);
  const old = new Date(args.startedAtMs - 2000);
  await fs.utimes(item.savedPath, old, old);
  await assert.rejects(readNativeChatImage(args), rejected);
  await fs.writeFile(item.savedPath, png);
  await assert.rejects(readNativeChatImage({...args, item: {...item, status: 'in_progress'}}), rejected);
  await assert.rejects(readNativeChatImage({...args, isCurrent: () => false}), rejected);
  await fs.writeFile(item.savedPath, png.subarray(0, -1));
  await assert.rejects(readNativeChatImage(args), rejected);
});

test('rejects out-of-root results, linked directories and hard-linked files', async t => {
  const {args, item, png, privateRoot, directory} = await fixture(t);
  const outside = path.join(privateRoot, 'private');
  const outsideImage = path.join(outside, 'sample.png');
  await fs.mkdir(outside);
  await fs.writeFile(outsideImage, png);
  await assert.rejects(readNativeChatImage({...args, item: {...item, savedPath: outsideImage}}), rejected);
  const link = path.join(args.generatedImagesRoot, 'linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readNativeChatImage({...args, threadId: 'linked', item: {...item, id: 'sample', savedPath: path.join(link, 'sample.png')}}), rejected);
  await fs.link(outsideImage, path.join(directory, 'hard.png'));
  await assert.rejects(readNativeChatImage({...args, item: {...item, id: 'hard', savedPath: path.join(directory, 'hard.png')}}), rejected);
});
