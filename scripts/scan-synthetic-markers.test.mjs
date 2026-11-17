import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { scanMarkers } from './scan-synthetic-markers.mjs';

// All fixtures and markers are synthetic. No actual secrets or clinical data.
const MARKER = 'SYNTHETIC_CANARY_72a9fd513ee44f68b2cb4fd1d760a118';
const OTHER = 'SYNTHETIC_CANARY_OTHER_8b1c997b799645a290b634ad628cb0b1';
const DEFAULT_LIMITS = { maxFiles: 1000, maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024, maxDecodedBytes: 8 * 1024 * 1024, maxDepth: 8 };

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'synthetic-marker-scan-'));
  const root = path.join(base, 'runner');
  await mkdir(root);
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const put = async (name, bytes) => {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    return destination;
  };
  const run = (limits = {}) => scanMarkers({ roots: [root], markers: [MARKER, OTHER], limits: { ...DEFAULT_LIMITS, ...limits } });
  return { base, root, put, run };
}

// Errors must expose only a fixed classification, never the matching marker,
// file names, bytes, raw JSON, external target or archive entry name.
async function rejectsSafely(promise, code, forbidden) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, code);
    const visible = `${error.message}\n${String(error)}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
    for (const item of forbidden) assert.equal(visible.includes(item), false);
    return true;
  });
}

function octal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(text.slice(-(length - 1)), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}
function tar(entries) {
  const chunks = [];
  for (const { name, data, type = '0', link = '' } of entries) {
    const bytes = Buffer.from(data ?? '');
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8'); octal(h, 100, 8, 0o644); octal(h, 108, 8, 0); octal(h, 116, 8, 0);
    octal(h, 124, 12, bytes.length); octal(h, 136, 12, 0); h.fill(0x20, 148, 156);
    h.write(type, 156, 1, 'ascii'); h.write(link, 157, 100, 'utf8'); h.write('ustar\0', 257, 6, 'ascii'); h.write('00', 263, 2, 'ascii');
    octal(h, 148, 8, h.reduce((sum, byte) => sum + byte, 0));
    chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(name, input) {
  const filename = Buffer.from(name), data = Buffer.from(input), deflated = deflateRawSync(data), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const start = local.length + filename.length + deflated.length, size = central.length + filename.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, filename, deflated, central, filename, end]);
}

const expectedError = async (f, code = 'MARKER_FOUND', limits = {}) => rejectsSafely(f.run(limits), code, [MARKER, OTHER, f.base]);

test('clean regular files and an internal symlink succeed without exposing file names or markers', async (t) => {
  const f = await fixture(t);
  await f.put('.next/server/fixture.js', 'console.log("synthetic safe");');
  await symlink('fixture.js', path.join(f.root, '.next/server/link.js'));
  const result = await f.run();
  assert.equal(Number.isSafeInteger(result.filesScanned) && result.filesScanned >= 1, true);
  assert.equal(Number.isSafeInteger(result.decodedObjects) && result.decodedObjects >= 0, true);
  assert.deepEqual(Object.keys(result).sort(), ['decodedObjects', 'filesScanned']);
  for (const hidden of [MARKER, OTHER, f.base, 'fixture.js']) assert.equal(JSON.stringify(result).includes(hidden), false);
});

for (const [name, content] of [
  ['raw boundary across stream chunks', Buffer.concat([Buffer.alloc(65530, 0x61), Buffer.from(MARKER), Buffer.alloc(100, 0x62)])],
  ['marker in binary bytes', Buffer.concat([Buffer.from([0, 1, 255]), Buffer.from(MARKER), Buffer.from([0, 255])])],
  ['second independently generated marker', OTHER],
]) {
  test(name, async (t) => { const f = await fixture(t); await f.put('public/innocent.bin', content); await expectedError(f); });
}

test('marker in a shipped file name is detected without echoing that name', async (t) => {
  const f = await fixture(t); await f.put(`public/${MARKER}.txt`, 'synthetic safe content'); await expectedError(f);
});

test('source map sourcesContent is JSON-decoded before searching (Unicode escapes)', async (t) => {
  const f = await fixture(t);
  const escaped = [...MARKER].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await f.put('.next/server/synthetic.js.map', `{"version":3,"sources":["synthetic.ts"],"sourcesContent":["${escaped}"],"mappings":""}`);
  await expectedError(f);
});

test('shipped JSON values are unescaped before searching', async (t) => {
  const f = await fixture(t);
  const escaped = [...MARKER].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await f.put('public/synthetic-manifest.json', `{"value":"${escaped}"}`);
  await expectedError(f);
});

test('zlib-compressed artifacts are decoded even with ordinary filenames', async (t) => {
  const f = await fixture(t);
  await f.put('runtime/asset.dat', deflateSync(Buffer.from(MARKER)));
  await expectedError(f);
});

test('Brotli-compressed artifacts are decoded even with ordinary filenames', async (t) => {
  const f = await fixture(t);
  await f.put('runtime/asset.dat', brotliCompressSync(Buffer.from(MARKER)));
  await expectedError(f);
});

test('inline base64 source map is decoded and its sourcesContent searched', async (t) => {
  const f = await fixture(t);
  const map = JSON.stringify({ version: 3, sources: ['synthetic.ts'], sourcesContent: [MARKER], mappings: '' });
  await f.put('.next/static/synthetic.js', `console.log(1);\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}\n`);
  await expectedError(f);
});

test('inline percent-encoded source map is decoded and searched', async (t) => {
  const f = await fixture(t);
  const map = JSON.stringify({ version: 3, sources: ['synthetic.ts'], sourcesContent: [MARKER], mappings: '' });
  await f.put('.next/static/synthetic.js', `//# sourceMappingURL=data:application/json,${encodeURIComponent(map)}\n`);
  await expectedError(f);
});

for (const [name, encode] of [['gzip', gzipSync], ['brotli', brotliCompressSync]]) {
  test(`${name} contents are decoded and searched`, async (t) => {
    const f = await fixture(t); await f.put(`.next/static/synthetic.${name === 'gzip' ? 'gz' : 'br'}`, encode(Buffer.from(MARKER))); await expectedError(f);
  });
}

for (const [name, encode] of [['zlib', deflateSync], ['brotli', brotliCompressSync]]) {
  test(`${name} disguised as .dat with escaped JSON markers is recursively decoded`, async (t) => {
    const f = await fixture(t);
    const escaped = [...MARKER].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    await f.put('runtime/asset.dat', encode(Buffer.from(`{"value":"${escaped}"}`)));
    await expectedError(f);
  });
  test(`${name} concatenated streams never conceal a marker in the later stream`, async (t) => {
    const f = await fixture(t);
    await f.put('runtime/asset.dat', Buffer.concat([encode(Buffer.from('safe')), encode(Buffer.from(MARKER))]));
    await assert.rejects(f.run(), (error) => {
      assert.equal(['MARKER_FOUND', 'INVALID_CONTENT'].includes(error.message), true);
      const visible = `${error.message}\n${String(error)}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
      for (const item of [MARKER, OTHER, f.base]) assert.equal(visible.includes(item), false);
      return true;
    });
  });
}

test('compressed JSON may be a root string, not only an object', async (t) => {
  const f = await fixture(t);
  const escaped = [...MARKER].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await f.put('runtime/asset.dat', deflateSync(Buffer.from(`"${escaped}"`)));
  await expectedError(f);
});

test('tar and nested tar.gz entries are searched without extraction onto disk', async (t) => {
  const f = await fixture(t); await f.put('runtime/assets.tar.gz', gzipSync(tar([{ name: 'synthetic/data.txt', data: MARKER }]))); await expectedError(f);
});

test('deflated zip entry is searched without extraction onto disk', async (t) => {
  const f = await fixture(t); await f.put('runtime/assets.zip', zip('synthetic/data.txt', MARKER)); await expectedError(f);
});

test('unsafe symlink escaping the runner root is rejected without reading target', async (t) => {
  const f = await fixture(t); const outside = path.join(f.base, 'synthetic-outside.txt'); await writeFile(outside, MARKER);
  await symlink(outside, path.join(f.root, 'escape'));
  await expectedError(f, 'UNSAFE_LINK');
});

test('dangling and cyclic symlinks fail closed', async (t) => {
  const dangling = await fixture(t); await symlink('missing', path.join(dangling.root, 'link'));
  await expectedError(dangling, 'UNSAFE_LINK');
  const cycle = await fixture(t); await symlink('other', path.join(cycle.root, 'one')); await symlink('one', path.join(cycle.root, 'other'));
  await expectedError(cycle, 'UNSAFE_LINK');
});

test('archive paths with traversal and symlink entries fail closed', async (t) => {
  const traversal = await fixture(t); await traversal.put('runtime/a.tar', tar([{ name: '../outside', data: 'safe' }]));
  await expectedError(traversal, 'UNSAFE_LINK');
  const archiveLink = await fixture(t); await archiveLink.put('runtime/a.tar', tar([{ name: 'x', type: '2', link: '../../outside' }]));
  await expectedError(archiveLink, 'UNSAFE_LINK');
  const zipTraversal = await fixture(t); await zipTraversal.put('runtime/a.zip', zip('../outside', 'safe'));
  await expectedError(zipTraversal, 'UNSAFE_LINK');
});

test('malformed encoded artifacts fail closed, rather than being accepted as clean', async (t) => {
  const f = await fixture(t); await f.put('runtime/a.gz', Buffer.from([0x1f, 0x8b, 0x08, 0xff])); await expectedError(f, 'INVALID_CONTENT');
});

test('file count, input size, expansion and nesting limits fail closed', async (t) => {
  const count = await fixture(t); await count.put('one', '1'); await count.put('two', '2');
  await expectedError(count, 'LIMIT_EXCEEDED', { maxFiles: 1 });
  const input = await fixture(t); await input.put('large.bin', Buffer.alloc(100));
  await expectedError(input, 'LIMIT_EXCEEDED', { maxFileBytes: 50 });
  const total = await fixture(t); await total.put('one.bin', Buffer.alloc(60)); await total.put('two.bin', Buffer.alloc(60));
  await expectedError(total, 'LIMIT_EXCEEDED', { maxTotalBytes: 100 });
  const expansion = await fixture(t); await expansion.put('runtime/a.gz', gzipSync(Buffer.alloc(32_000, 0x61)));
  await expectedError(expansion, 'LIMIT_EXCEEDED', { maxDecodedBytes: 1000 });
  const aggregate = await fixture(t); await aggregate.put('one.gz', gzipSync(Buffer.alloc(700, 0x61))); await aggregate.put('two.gz', gzipSync(Buffer.alloc(700, 0x62)));
  await expectedError(aggregate, 'LIMIT_EXCEEDED', { maxDecodedBytes: 1000 });
  const depth = await fixture(t); await depth.put('runtime/a.tar.gz', gzipSync(tar([{ name: 'inner.gz', data: gzipSync(Buffer.from('safe')) }])));
  await expectedError(depth, 'LIMIT_EXCEEDED', { maxDepth: 1 });
});

test('empty markers and missing roots fail closed without printing input', async (t) => {
  const f = await fixture(t);
  await rejectsSafely(scanMarkers({ roots: [f.root], markers: [''], limits: DEFAULT_LIMITS }), 'INVALID_INPUT', [f.base]);
  await rejectsSafely(scanMarkers({ roots: [path.join(f.root, 'missing')], markers: [MARKER], limits: DEFAULT_LIMITS }), 'INVALID_INPUT', [MARKER, f.base]);
});


test('manifest cannot disable resource caps with unreasonably large limits', async (t) => {
  const f = await fixture(t); await f.put('clean.txt', 'safe');
  for (const field of ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxDecodedBytes', 'maxDepth']) {
    await expectedError(f, 'INVALID_INPUT', { [field]: Number.MAX_SAFE_INTEGER });
  }
});
