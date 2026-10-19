// 桌面 ChatGPT 固定聊天生图示例；需要用户已登录并明确授权生成。
// 用 DOM 节点和 src 基线排除已知旧图；虚拟化历史页面仍需单独验收。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixedChat, enterFixedChat, acquireGenerationLock } from './fixed-chat.mjs';
import { connectDesktop, configFile } from './cdp-client.mjs';

const prompt = process.argv[2];
const outFile = process.argv[3];
if (!prompt || !outFile) { console.error('usage: node scripts/generate-image.mjs <prompt> <out.png>'); process.exit(64); }
const fixedChat = loadFixedChat(configFile);
const releaseLock = acquireGenerationLock(fileURLToPath(new URL('../generation.lock', import.meta.url)));
process.on('exit', releaseLock);

const { ws, send, ev } = await connectDesktop(fixedChat.pageUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG_SEL = `[...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200 && (i.currentSrc || i.src || '').length > 0)`;

try {
  await enterFixedChat(ev, sleep, fixedChat);
  await sleep(1800);

  const baseline = JSON.parse(await ev(`(() => {
    globalThis.__qqImageBaseline = new WeakSet(document.querySelectorAll('img'));
    return JSON.stringify(${IMG_SEL}.map(i => i.currentSrc || i.src));
  })()`));

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

  await send('Input.insertText', { text: fixedChat.promptPrefix + '\n' + prompt });
  await sleep(700);
  const typed = await ev(`(() => { const el = [...document.querySelectorAll('.ProseMirror')].find(e => e.getBoundingClientRect().width > 0); return (el?.innerText || '').trim(); })()`);
  if (!typed || !typed.includes(prompt.slice(0, Math.min(8, prompt.length)))) throw new Error('输入框内容异常：' + String(typed).slice(0, 80));

  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  // 等新图
  const started = Date.now();
  let target = null;
  while (Date.now() - started < 260000) {
    await sleep(4000);
    const s = JSON.parse(await ev(`
      (() => {
        const imgs = ${IMG_SEL}.filter(i => !globalThis.__qqImageBaseline.has(i));
        const txt = document.body.innerText || '';
        return JSON.stringify({ srcs: imgs.map(i => i.currentSrc || i.src), busy: /正在创建图像|正在生成|Creating image|Generating/i.test(txt), tail: txt.slice(-160) });
      })()
    `));
    const fresh = s.srcs.filter((src) => !baseline.includes(src));
    if (fresh.length && !s.busy) { target = fresh[fresh.length - 1]; break; }
    if (/达到上限|limit reached|无法生成/i.test(s.tail)) throw new Error('ChatGPT 拒绝生图：' + s.tail.slice(-80));
  }
  if (!target) throw new Error('等待出图超时');

  const payload = await ev(`
    (async () => {
      const imgs = ${IMG_SEL};
      const target = imgs.map(i => i.currentSrc || i.src).filter(s => s === ${JSON.stringify(target)})[0];
      const img = imgs.find(i => (i.currentSrc || i.src) === target);
      if (!img) return null;
      const resp = await fetch(img.currentSrc || img.src, { credentials: 'include' });
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
  console.log(JSON.stringify({ ok: true, file: outFile, bytes: info.len, type: info.type }));
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 2;
} finally {
  try { ws.close(); } catch {}
  releaseLock();
}
