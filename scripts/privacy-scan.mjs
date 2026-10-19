import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function privacyIssues(text) {
  const issues = [];
  const uuids = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [];
  if (uuids.some(u => u !== '00000000-0000-4000-8000-000000000000')) issues.push('非示例 UUID');
  const withoutUuids = text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '');
  if (/\b\d{7,12}\b/.test(withoutUuids)) issues.push('可能的账号、群或消息编号');
  if (/[A-Z]:[\\/]Users[\\/][^\s\\/<>]+/i.test(text)) issues.push('Windows 用户目录');
  if (/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}/.test(text)) issues.push('疑似访问凭据');
  if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) issues.push('私钥');
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) issues.push('邮箱');
  return issues;
}

export function scan(root) {
  let files;
  try {
    // 包括已暂存/已跟踪与未忽略文件；force-add 的隐私文件也会被检查。
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    const ignored = new Set(['.git', 'node_modules', 'out', 'logs', 'state', '__pycache__']);
    const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      if (ignored.has(e.name) || /\.local\.|^\.env(?:\.|$)|^generation\.lock$/.test(e.name)) return [];
      const rel = prefix + e.name;
      return e.isDirectory() ? walk(path.join(dir, e.name), rel + '/') : [rel];
    });
    files = walk(root);
  }
  const failures = [];
  for (const rel of new Set(files)) {
    if (/(^|\/)(?:state|logs|out|node_modules)\/|\.local\.|(^|\/)\.env(?:\.|$)|\.(?:png|jpe?g|gif|webp|zip|db|sqlite|log)$/i.test(rel)) {
      failures.push({ file: rel, issues: ['不应发布的配置、数据或产物'] }); continue;
    }
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    if (fs.lstatSync(file).isSymbolicLink()) { failures.push({ file: rel, issues: ['不发布符号链接'] }); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) { failures.push({ file: rel, issues: ['未审核二进制文件'] }); continue; }
    const issues = privacyIssues(bytes.toString('utf8'));
    if (issues.length) failures.push({ file: rel, issues });
  }
  return { files: files.length, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scan(fileURLToPath(new URL('../', import.meta.url)));
  // 只输出文件名和类别，避免把匹配到的隐私再次打印到日志。
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
