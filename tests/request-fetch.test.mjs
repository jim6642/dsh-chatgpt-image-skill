import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { requestImageSnapshot } from '../scripts/request-image.mjs';

// 编译生成器真正交给页面执行的取图代码，避免只测辅助函数漏掉模板转义错误。
const source = fs.readFileSync(new URL('../scripts/generate-image.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const payload = await ev(`') + 'const payload = await ev(`'.length;
const end = source.indexOf('  `);', start);
const marker = 'request-test-marker';
const snapshotCode = `(${requestImageSnapshot.toString()})(document, ${JSON.stringify(marker)})`;
const target = { src: 'blob:current-image', messageId: 'current-message' };
const expression = new Function('snapshotCode', 'target', 'return `' + source.slice(start, end) + '`;')(snapshotCode, target);

function run({ state = 'complete', src = target.src, messageId = target.messageId, contentType = 'image/png' } = {}) {
  let fetched = 0;
  const img = { naturalWidth: 1024, currentSrc: src, closest: () => ({ getAttribute: () => messageId }) };
  const turn = { innerText: marker, getAttribute: () => state, querySelectorAll: () => [img] };
  const document = { querySelectorAll: () => [turn] };
  const result = vm.runInNewContext(expression, {
    document, Uint8Array,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    fetch: async url => {
      assert.equal(url, target.src, 'never fetch a fallback image'); fetched++;
      return { ok: true, headers: { get: () => contentType }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    },
  });
  return { result, fetchCount: () => fetched };
}

test('最终读取使用本轮图片，保留字节与类型', async () => {
  const r = run();
  const value = JSON.parse(await r.result);
  assert.equal(value.len, 3); assert.equal(value.type, 'image/png');
  assert.equal(value.data, 'AQID'); assert.equal(r.fetchCount(), 1);
});

test('取字节前消息 ID 或 src 改变时拒绝读取', async () => {
  for (const patch of [{ messageId: 'other-message' }, { src: 'blob:historical-image' }]) {
    const r = run(patch); await assert.rejects(r.result, /拒绝取其他图/); assert.equal(r.fetchCount(), 0);
  }
});

test('取字节时消息未完成则不下载预览', async () => {
  const r = run({ state: 'streaming' });
  await assert.rejects(r.result, /拒绝取其他图/); assert.equal(r.fetchCount(), 0);
});

test('图片 URL 返回非图片内容时停止', async () => {
  const r = run({ contentType: 'text/html' });
  await assert.rejects(r.result, /图片读取失败/);
});
