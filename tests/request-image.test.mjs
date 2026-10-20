import assert from 'node:assert/strict';
import vm from 'node:vm';
import { requestImageSnapshot } from '../scripts/request-image.mjs';
const marker = '【绘图请求 test-current-request】';
const image = (src, messageId = 'current-image-message', naturalWidth = 1024) => ({ src, currentSrc: src, naturalWidth,
  closest: () => ({ getAttribute: () => messageId }) });
const turn = (text, state, imgs) => ({ innerText: text, getAttribute: () => state,
  querySelectorAll: selector => { assert.equal(selector, '[data-testid="generated-image-preview"] img'); return imgs; } });
const old = turn('旧的白发少年提示词', 'complete', [image('blob:old-image-lazy-reloaded')]);
const makeDoc = turns => ({ querySelectorAll: selector => {
  assert.equal(selector, '[data-talvt-turn-state]', 'must not search the whole page for images'); return turns;
} });
assert.deepEqual(requestImageSnapshot(makeDoc([old]), marker), { found: false }, 'late historical images never qualify');
assert.equal(requestImageSnapshot(makeDoc([old, turn(marker, 'streaming', [image('blob:preview')])]), marker).complete, false, 'image preview must wait for turn completion');
assert.equal(requestImageSnapshot(makeDoc([old, turn(marker, 'complete', [image('blob:current')])]), marker).image.src, 'blob:current');
assert.equal(requestImageSnapshot(makeDoc([old, turn(marker, 'complete', [image('blob:current', null)])]), marker).image, null, 'require a generated-message identity');
assert.equal(requestImageSnapshot(makeDoc([turn(marker, 'complete', [image('blob:loading', 'id', 0)])]), marker).image, null);
assert.throws(() => requestImageSnapshot(makeDoc([turn(marker, 'complete', []), turn(marker, 'complete', [])]), marker), /多个消息块/);
assert.throws(() => requestImageSnapshot(makeDoc([turn(marker, 'complete', [image('blob:a'), image('blob:b')])]), marker), /多张图/);
const doc = makeDoc([old, turn(marker, 'complete', [image('blob:current')])]);
const result = vm.runInNewContext(`(${requestImageSnapshot.toString()})(document, ${JSON.stringify(marker)})`, { document: doc });
assert.equal(result.image.src, 'blob:current', 'serialized browser function has no module dependencies');
console.log('PASS request-bound image extraction: historical lazy loads excluded, exact request and message identity required, completed turn only, ambiguity rejected');
