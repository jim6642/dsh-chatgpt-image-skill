import fs from 'node:fs';

export function selectChatPage(list, pageUrl = 'app://-/index.html') {
  const pages = list.filter(t => t.type === 'page' && t.url === pageUrl);
  if (pages.length !== 1) throw new Error('无法唯一定位 ChatGPT 桌面主窗口，不会向浮窗发送提示词');
  return pages[0];
}

export function loadFixedChat(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(c.conversationId || '') || !c.title?.trim()
      || c.referenceConfirmed !== true || !c.promptPrefix?.trim()
      || /^0{8}-0{4}-4000-8000-0{12}$/.test(c.conversationId)) throw new Error('固定生图会话未绑定，请先确认三视图；不会另建聊天');
  return { ...c, title: c.title.trim(), pageUrl: c.pageUrl || 'app://-/index.html' };
}

export async function enterFixedChat(ev, sleep, config) {
  const expected = JSON.stringify(config.title);
  const status = `(() => {
    const title = ${expected};
    const header = document.querySelector('[role="toolbar"][aria-label="聊天工具栏"]')?.innerText || '';
    return document.title === title || document.title.startsWith(title + ' — ')
      || header.split('\\n').some(x => x.trim() === title);
  })()`;
  // Always select the unique existing sidebar entry. Never click New Chat.
  let selected = 0;
  for (let i = 0; i < 40; i++) {
    selected = await ev(`(() => {
    const matches = [...document.querySelectorAll('button,a,[role="button"]')].filter(e =>
      e.getBoundingClientRect().width > 0 && ((e.innerText || '').trim() === ${expected}
        || e.getAttribute('aria-label') === ${expected}));
    if (matches.length !== 1) return matches.length;
    matches[0].click(); return 1;
  })()`);
    if (selected !== 0) break;
    await sleep(250);
  }
  if (selected !== 1) throw new Error('找不到唯一的固定生图会话「' + config.title + '」，请在桌面端打开它；不会另建聊天');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await ev(status)) return;
  }
  throw new Error('固定生图会话打开未确认；本次不发送提示词，也不会另建聊天');
}

export function acquireGenerationLock(file) {
  const owner = { pid: process.pid, at: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
      return () => { try { if (JSON.parse(fs.readFileSync(file)).pid === owner.pid) fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let alive = false;
      try { const old = JSON.parse(fs.readFileSync(file)); if (Number.isSafeInteger(old.pid) && old.pid > 0) {
        try { process.kill(old.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      } } catch {}
      if (alive) throw new Error('固定聊天正在生成另一张图，请完成后再试，避免串图');
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得固定生图会话锁');
}
