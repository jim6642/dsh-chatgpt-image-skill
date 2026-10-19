import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { selectChatPage, loadFixedChat, enterFixedChat, acquireGenerationLock } from '../scripts/fixed-chat.mjs';
import { localEndpoint } from '../scripts/cdp-client.mjs';

test('主窗口选择不受浮窗顺序影响，歧义时停止', () => {
  const main = { type: 'page', url: 'app://-/index.html' };
  assert.equal(selectChatPage([{ type: 'page', url: 'app://-/detached-window.html' }, main]), main);
  assert.throws(() => selectChatPage([main, main]), /主窗口/);
  assert.throws(() => selectChatPage([]), /主窗口/);
});

test('等待侧栏加载，识别 role=button 与 aria-label，不创建聊天', async () => {
  const config = { title: '测试角色｜固定聊天' };
  let calls = 0, clicked = 0;
  const doc = { title: '其他聊天', querySelector: () => null, querySelectorAll: selector => {
    assert.ok(selector.includes('[role="button"]'));
    if (++calls < 3) return [];
    return [{ innerText: config.title + '\n额外标签', getAttribute: () => config.title,
      getBoundingClientRect: () => ({ width: 20 }), click: () => { clicked++; doc.title = config.title; } }];
  } };
  await enterFixedChat(async code => vm.runInNewContext(code, { document: doc }), async () => {}, config);
  assert.equal(clicked, 1); assert.equal(calls, 3);
});

test('找不到/重名/未完成导航时停止', async () => {
  for (const count of [0, 2]) await assert.rejects(enterFixedChat(async () => count, async () => {}, { title: '测试' }), /找不到唯一/);
  let count = 0;
  await assert.rejects(enterFixedChat(async () => ++count === 1 ? 1 : false, async () => {}, { title: '测试' }), /打开未确认/);
});

test('配置必须明确确认参考图，未编辑的示例不能触发生图', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-binding-test-'));
  const file = path.join(dir, 'config.json');
  try {
    const c = { conversationId: randomUUID(), title: '测试', referenceConfirmed: true, promptPrefix: '参考原始图' };
    fs.writeFileSync(file, JSON.stringify(c)); assert.equal(loadFixedChat(file).title, c.title);
    fs.writeFileSync(file, JSON.stringify({ ...c, referenceConfirmed: false })); assert.throws(() => loadFixedChat(file));
    assert.throws(() => loadFixedChat(new URL('../fixed-chat.example.json', import.meta.url)));
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('生成锁拒绝并发并能回收不存在进程的旧锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lock-test-')), file = path.join(dir, 'lock');
  try {
    const release = acquireGenerationLock(file);
    assert.throws(() => acquireGenerationLock(file), /正在生成另一张图/);
    release(); assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER }));
    const release2 = acquireGenerationLock(file); release2();
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('CDP 仅允许本机地址，拒绝远程与含凭据 URL', () => {
  assert.equal(localEndpoint('http://127.0.0.1:9224'), 'http://127.0.0.1:9224');
  for (const u of ['http://example.com:9224', 'http://name:pass@localhost:9224', 'https://localhost:9224', 'http://localhost:9224/other']) {
    assert.throws(() => localEndpoint(u), /本机/);
  }
});
