// 此函数会被序列化到桌面页面中执行，不能引用模块外部变量。
export function requestImageSnapshot(doc, marker) {
  const turns = [...doc.querySelectorAll('[data-talvt-turn-state]')]
    .filter(turn => (turn.innerText || '').includes(marker));
  if (turns.length > 1) throw new Error('本次绘图请求匹配到多个消息块，拒绝取图');
  if (!turns.length) return { found: false };
  const turn = turns[0];
  const state = turn.getAttribute('data-talvt-turn-state');
  const imgs = [...turn.querySelectorAll('[data-testid="generated-image-preview"] img')]
    .filter(img => img.naturalWidth > 200 && (img.currentSrc || img.src));
  if (state === 'complete' && imgs.length > 1) throw new Error('本次消息含多张图，无法唯一确认，拒绝取图');
  const img = imgs.length === 1 ? imgs[0] : null;
  const messageId = img?.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids');
  return {
    found: true, state, complete: state === 'complete',
    image: img && messageId ? { src: img.currentSrc || img.src, messageId } : null,
    tail: (turn.innerText || '').slice(-200),
  };
}
