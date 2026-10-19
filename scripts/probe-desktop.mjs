import { listPages, connectDesktop } from './cdp-client.mjs';
const list = await listPages();
console.log(JSON.stringify(list.map(p => ({ type: p.type, url: p.url })), null, 2));
const { ws, ev } = await connectDesktop(process.env.CHATGPT_PAGE_URL || 'app://-/index.html');
try {
  console.log(await ev(`JSON.stringify({
    title: document.title,
    toolbar: document.querySelector('[role="toolbar"][aria-label="聊天工具栏"]')?.innerText || '',
    visibleEditors: [...document.querySelectorAll('.ProseMirror')].filter(e => e.getBoundingClientRect().width > 0).length
  })`));
} finally { ws.close(); }
