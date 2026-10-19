import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectChatPage } from './fixed-chat.mjs';

export const configFile = process.env.CHATGPT_IMAGE_CONFIG
  ? path.resolve(process.env.CHATGPT_IMAGE_CONFIG)
  : fileURLToPath(new URL('../fixed-chat.local.json', import.meta.url));

export function localEndpoint(value = process.env.CHATGPT_CDP || 'http://127.0.0.1:9224') {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new Error('CDP 仅允许不带凭据的本机 HTTP 根地址');
  }
  return u.origin;
}

export async function listPages() {
  const res = await fetch(localEndpoint() + '/json/list', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('CDP 页面列表 HTTP ' + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('CDP 页面列表格式异常');
  return list;
}

export async function connectDesktop(pageUrl = 'app://-/index.html') {
  const page = selectChatPage(await listPages(), pageUrl);
  const socketUrl = new URL(page.webSocketDebuggerUrl);
  if (socketUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname)
      || socketUrl.username || socketUrl.password) throw new Error('拒绝非本机 CDP WebSocket');
  const ws = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 连接超时')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const failPending = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP 连接中断')); }
    pending.clear();
  };
  ws.addEventListener('close', failPending);
  ws.addEventListener('error', failPending);
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error('CDP 调用错误：' + m.error.message)); else p.resolve(m);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error('CDP 调用超时：' + method)); }, 20000);
    pending.set(callId, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: callId, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(callId); reject(e); }
  });
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('桌面页面脚本失败：' + (r.result.exceptionDetails.text || '未知错误'));
    return r.result?.result?.value;
  };
  return { ws, ev, send, page };
}
