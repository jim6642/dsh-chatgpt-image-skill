// 桌面 ChatGPT 固定聊天生图示例；需要用户已登录并明确授权生成。
// 按唯一请求标记定位本轮消息，完成后只提取该消息的生成图。
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixedChat, enterFixedChat, acquireGenerationLock } from './fixed-chat.mjs';
import { connectDesktop, configFile } from './cdp-client.mjs';
import { requestImageSnapshot } from './request-image.mjs';

const prompt = process.argv[2];
const outFile = process.argv[3];
if (!prompt || !outFile) { console.error('usage: node scripts/generate-image.mjs <prompt> <out.png>'); process.exit(64); }
const fixedChat = loadFixedChat(configFile);
const releaseLock = acquireGenerationLock(fileURLToPath(new URL('../generation.lock', import.meta.url)));
process.on('exit', releaseLock);

const { ws, send, ev } = await connectDesktop(fixedChat.pageUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = `【绘图请求 ${randomBytes(12).toString('hex')}】`;
const snapshotCode = `(${requestImageSnapshot.toString()})(document, ${JSON.stringify(marker)})`;

try {
  await enterFixedChat(ev, sleep, fixedChat);
  await sleep(1800);

  // 聚焦可见输入框
  const rect = JSON.parse(await ev(`
    (() => {
      const el = [...document.querySelectorAll('.ProseMirror')].find(e => e.getBoundingClientRect().width > 0);
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()
  `));
  if (!rect) throw new Error('找不到输入框');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(300);

  // 清空
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await sleep(200);

  await send('Input.insertText', { text: marker + '（仅用于定位本次请求，不要画进图片）\n' + fixedChat.promptPrefix + '\n' + prompt });
  await sleep(700);
  const typed = await ev(`(() => { const el = [...document.querySelectorAll('.ProseMirror')].find(e => e.getBoundingClientRect().width > 0); return (el?.innerText || '').trim(); })()`);
  if (!typed || !typed.includes(marker) || !typed.includes(prompt.slice(0, Math.min(8, prompt.length)))) throw new Error('输入框内容异常：' + String(typed).slice(0, 80));

  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  // 等新图
  const started = Date.now();
  let target = null;
  while (Date.now() - started < 260000) {
    await sleep(4000);
    const s = await ev(snapshotCode);
    if (s?.found && s.complete && s.image) { target = s.image; break; }
    if (s?.found && (/error|failed/.test(s.state || '') || /达到上限|limit reached|无法生成/i.test(s.tail || ''))) {
      throw new Error('本次绘图请求失败：' + String(s.tail).slice(-80));
    }
  }
  if (!target) throw new Error('等待出图超时');

  const payload = await ev(`
    (async () => {
      const current = ${snapshotCode};
      if (!current.complete || !current.image || current.image.messageId !== ${JSON.stringify(target.messageId)}
          || current.image.src !== ${JSON.stringify(target.src)}) throw new Error('本次消息或图片已改变，拒绝取其他图');
      const resp = await fetch(current.image.src, { credentials: 'include' });
      if (!resp.ok || !(resp.headers.get('content-type') || '').toLowerCase().startsWith('image/')) throw new Error('本次图片读取失败');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return JSON.stringify({ len: bytes.length, type: resp.headers.get('content-type'), data: btoa(bin) });
    })()
  `);
  if (!payload) throw new Error('取图失败');
  const info = JSON.parse(payload);
  if (info.len < 5000) throw new Error('图片太小：' + info.len);
  if (!/^image\//i.test(info.type || '')) throw new Error('返回内容不是图片');
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, Buffer.from(info.data, 'base64'));
  console.log(JSON.stringify({ ok: true, file: outFile, bytes: info.len, type: info.type, requestMarker: marker, messageId: target.messageId }));
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 2;
} finally {
  try { ws.close(); } catch {}
  releaseLock();
}
