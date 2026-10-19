import { configFile, connectDesktop } from './cdp-client.mjs';
import { loadFixedChat, enterFixedChat } from './fixed-chat.mjs';
const config = loadFixedChat(configFile);
const { ws, ev } = await connectDesktop(config.pageUrl);
try {
  if (process.argv.includes('--open')) {
    await enterFixedChat(ev, ms => new Promise(r => setTimeout(r, ms)), config);
    console.log('PASS 已选择唯一固定聊天；未发送提示词，未生图。');
  } else {
    const count = await ev(`(() => {
      const title = ${JSON.stringify(config.title)};
      return [...document.querySelectorAll('button,a,[role="button"]')].filter(e =>
        e.getBoundingClientRect().width > 0 && ((e.innerText || '').trim() === title || e.getAttribute('aria-label') === title)).length;
    })()`);
    if (count !== 1) throw new Error('固定聊天可见匹配数为 ' + count + '；需唯一匹配');
    console.log('PASS 侧栏有唯一匹配；只读检查未选择聊天，未生图。');
  }
} finally { ws.close(); }
