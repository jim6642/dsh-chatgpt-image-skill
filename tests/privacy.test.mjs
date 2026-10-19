import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privacyIssues } from '../scripts/privacy-scan.mjs';

test('识别隐私类别但不在测试中使用真实数据', () => {
  assert.ok(privacyIssues(randomUUID()).includes('非示例 UUID'));
  assert.ok(privacyIssues(String(10 ** 9 + 7)).includes('可能的账号、群或消息编号'));
  assert.ok(privacyIssues('C:' + '\\Users\\' + 'Example\\file').includes('Windows 用户目录'));
  assert.ok(privacyIssues('ghp_' + 'a'.repeat(30)).includes('疑似访问凭据'));
  assert.ok(privacyIssues('sample' + '@' + 'example.org').includes('邮箱'));
  assert.deepEqual(privacyIssues('00000000-0000-4000-8000-000000000000'), []);
});
