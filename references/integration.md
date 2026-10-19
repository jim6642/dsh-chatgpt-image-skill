# 接入现有 DSH / QQ 桥接

这些是**适配片段**，不是独立服务器或整文件补丁。先读现有代码，复用自己的鉴权、会话和发送队列。未完成这些检查前不要让模型调用端点。

## A. 将生成器作为子进程调用

本仓库所有生成器文件放在一起，固定配置默认是仓库根目录 `fixed-chat.local.json`。桥接通过环境变量指向它，也可以沿用默认位置。

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// imageSkillDir 来自本地配置。不要照抄别人的绝对路径。
async function generateBytes(prompt, imageSkillDir) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-'));
  const out = path.join(temp, 'image.png');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [path.join(imageSkillDir, 'scripts/generate-image.mjs'), prompt, out],
        { cwd: imageSkillDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
      const timer = setTimeout(() => {
        child.kill(); reject(new Error('生成器超过外层时间预算；不自动重画'));
      }, 330000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderr || `生成器退出 ${code}`));
      });
    });
    return await fs.readFile(out);
  } finally {
    // temp 是本函数自己创建的随机临时目录，只删除这一目录。
    await fs.rm(temp, { recursive: true, force: true });
  }
}
```

生成器按序运行、超时退出；MCP 调用时间预算要覆盖子进程与 QQ 上传，例如 MCP 请求 360 秒、子进程 330 秒、生成等待 260 秒。原环境曾用 240 秒 MCP 超时跑通过，但它小于某些外层超时，慢请求会形成“报超时后其实仍在生成”的歧义；新接入不要复制这种预算倒置。

## B. 桥接 generate-image 端点的控制流

可以使用 `POST /api/socialV2/generate-image`，按现有桥接的 API 约定适配。接口请求体含 `key`、`prompt`，请求头有会话令牌及桥接需要的内部鉴权标记。不要公开无鉴权端点。

下面是控制流，名称如 `authorizeAgent` 都是需要接入原桥接的函数，**不是本仓库自带函数**：

```text
解析并限制 key / prompt
authorizeAgent(key, 会话令牌)：验证当前会话与令牌匹配
确认当前模式、白名单、静默、暂停和 sendImage 开关允许
检查生图额度 / 发送限流，记录一次占用
调用 generateBytes(prompt)
若生成失败：释放尚未发送的占用，返回失败，不自动重画
校验字节大小及真实图片格式
进入现有统一发送队列
  再次校验令牌、白名单、暂停、静默和会话是否仍有效
  根据 key 的 kind 选择 send_private_msg / send_group_msg
  发送 [{type:'image', data:{file:'base64://' + bytes.toString('base64')}}]
  检查 status === 'ok' 且 retcode === 0
记录本会话成功发送；返回 {ok:true, messageId}
```

会话 key 是当前请求上下文带来的 `private:<用户ID>` 或 `group:<群ID>`，不要由模型自由指定任意目标。应用应拒绝 key/令牌不匹配；生图成功也不等于仍然有发送权限，所以发送前必须再检查。

若 QQ 上传超时、返回结果不明，先查消息/日志，别直接再次生图。图片 bytes 应在临时文件清理前读完；别把 PNG 本身长期留在公开仓库。

## C. 注册 MCP 工具

沿用已有 `server`、`z` 和 `agentApi`，注册一个工具即可；不要为此重装整套 MCP。

```js
server.tool('qq_generate_image',
  '按具体画面描述生成一张图片并直接发到当前 QQ 会话。成功后不要重复调用发送图片工具。',
  { key: z.string(), token: z.string(), prompt: z.string().min(2).max(1000) },
  async ({ key, token, prompt }) => {
    try {
      const data = await agentApi('/api/socialV2/generate-image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, prompt }),
        timeoutMs: 360000,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
```

`agentApi` 应将 `timeoutMs` 转成真正的 AbortSignal；仅把自定义字段塞给 fetch 不会延长等待。它还应沿用现有内部请求标记、控制台令牌、会话令牌与 `ok:false` 检查，失败不能伪装成功。

一些桥接有工具开关表，例如 `TOOL_CONFIG_FLAGS.qq_generate_image = 'sendImage'`；如果存在，应与现有图片工具使用同一开关。发送成功识别表（常见 `SEND_TOOL_RE`）也应包含 `qq_generate_image`，避免工具已经发图，桥接又把内部总结自动发一遍。

## D. 让 DSH 真正加载新工具

1. 找到正在使用的 GUI 与它的后台进程，确认桥接连的是这个后台。
2. 在这个后台实际使用的 profile 配置 MCP server 启动命令、Node 路径和工作目录。`mcpServers` 结构及 preset 工具规则按本地 DSH 版本确认，不能盲贴另一版 YAML。
3. 用该 MCP 的 `tools/list` 确认 `qq_generate_image` 存在。
4. 检查 preset 允许规则是否放行完整工具名。现有工具的前缀可能是 `mcp__snowluma__`，但以真实 schema 为准，不凭名称猜测。
5. 重连这个 MCP 客户端或重启正确的 DSH GUI/后台；只重启另一份 Web 后台不会刷新当前会话。
6. 用一次受控实际会话确认模型能调用此工具；不要只靠提示词说“你会画图”。

角色提示词加几句话即可：

```text
收到明确生图请求时调用 qq_generate_image，prompt 写具体画面描述。
它成功就代表图片已发送，不再调用 qq_send_image 重复发送。
画“你/自拍”时指固定聊天里的角色参考图；其他主体按用户要求绘制。
工具失败如实说明，不声称成功，不因超时自动再画。
```

无需把 QQ 账号、主人资料或完整角色卡写进这个公开 skill；这些仍由你自己的私有配置提供。

## E. 启动与验收

手动启动链应覆盖 QQ/SnowLuma、DSH 桌面实际后台、桥接，以及已登录且 CDP 可用的桌面 ChatGPT。可以接入原来的桌面启动脚本，但不要默认创建开机启动项。skill 只协助配置；脚本装好后，运行不需要 Codex 持续在线。

先用本地生成器证明 PNG，再分别私聊和真实 @ 群聊验收。最终证据是：模型 tool/call → 当前固定 Chat 新图 → 桥接发送成功 → QQ get_msg 读回正确的 image 段。记录匿名成功摘要即可，不必对外贴真实 message_id 或聊天记录。
