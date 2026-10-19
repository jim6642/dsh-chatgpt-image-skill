# DSH × 桌面 ChatGPT：QQ 生图、角色参考图与固定聊天

这是一次真实跑通后的匿名整理：在已有 **DSH + QQ 桥接 + OneBot/SnowLuma** 环境上，增加 `qq_generate_image`，让模型调用本机桌面 ChatGPT 生图，再把图片发到当前 QQ 私聊或群聊。后续持续使用同一个带角色参考图的 Chat 聊天。

这里从“QQ 机器人已经能正常聊天”开始，不重复基础安装教学。仓库提供中文教程、可安装的 Codex skill、桌面生成器示例及接入片段；**不是下载后自动接管整个 QQ 机器人的一键整合包**。

## 实际链路

```text
QQ 消息（群聊保留真实 @ 触发）
  → 桥接唤醒 DSH
  → 模型选择 qq_generate_image
  → MCP 调用受保护的桥接 generate-image 接口
  → Node 驱动本机桌面 ChatGPT 的既有固定 Chat
  → 在原参考图上下文中生成 → 只提取本次新图
  → 桥接发送 OneBot image 段 → QQ 读回验证
```

本实现走桌面页面自动化，不是官方 Images API，也没有把 ChatGPT 登录状态做成公共反代。它仍依赖用户自己的登录、可用生图权限和客户端页面结构，不保证所有版本支持。请遵守所用账号、应用和自动化工具的规则；不导出 Cookie、不分享登录状态、不规避限制。需要正式 API 服务的场景应单独设计，不能把本例当成受支持的 API 接口。

### 实测范围

2026-10-19，在 Windows、Node 22、提供 CDP 的 Electron 桌面客户端中验证过：普通出图、QQ 私聊/群聊发送、固定 Chat 续用、根据原始三视图画同一角色。该客户端同时有 Chat/Work 界面，主页面 URL 是 `app://-/index.html`。**这不意味着所有名为 ChatGPT 的桌面应用都有这个结构**；不匹配时先用探针观察，再适配，不要强行照抄选择器。

公开包只做离线回归测试；上述真人链路来自整理前的私有环境，未附带私有消息、编号或截图。

## 1. 先准备好账号和软件

- 已有能文字聊天的 DSH + QQ 桥接，不必重装基础环境。
- Node.js 22 或更高，PowerShell。
- 在自己的桌面 ChatGPT **Chat** 登录，并先手动画出一张普通图片，确认这个账号能用。
- 选择自己有权使用的角色参考图，最好是清楚的正/侧/背三视图。
- 备份你将修改的脚本和配置；不要关闭正在生成中的任务。

## 2. 让桌面应用提供本机 CDP

本例需要应用自身支持 Chromium 调试端口。先正常退出应用，再按你实际安装位置启动。例如 PowerShell：

```powershell
$chatGptExe = 'C:\path\to\ChatGPT.exe' # 改成你自己的真实路径
Start-Process -FilePath $chatGptExe -ArgumentList '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9224' -WindowStyle Hidden
Invoke-RestMethod http://127.0.0.1:9224/json/list |
  Select-Object type, title, url
```

如果已有不带参数的实例，单实例机制可能忽略新参数；先保存工作并正常退出，再重新启动。`-WindowStyle Hidden` 是后台启动方式，应用自己的窗口行为可能仍由客户端决定。**端口能监听还不够**，下一步探针必须读到正确的主页面。检查 `Get-NetTCPConnection -LocalPort 9224 -State Listen`，不要向局域网或公网暴露调试口。

如果应用不提供该端口、规则不允许自动化，或只出现不兼容页面，到这里停止，不能通过复制登录凭据或换浏览器规避限制。本仓库不包含账号登录自动化。

在仓库目录执行：

```powershell
node scripts/probe-desktop.mjs
```

探针仅输出本机页面类型、URL、可见编辑器数和工具栏标题，不发消息、不生图。输出仍可能含你自己的标题，不要原样发到公共 issue。

## 3. 手动建立角色固定 Chat

在桌面 **Chat** 创建一次新聊天，上传参考图，把下面提示词改成你的角色后发送：

```text
这是角色“小蓝”的固定绘图聊天。附件是标准三视图，包含正面、侧面和背面。
今后本聊天里“你”“小蓝”“你自己”“自拍”都指附件的同一个虚构角色。
请以原图为准保持脸型、发型、配色、服装、比例和各角度的一致性。
可以根据要求改变动作、表情、镜头和场景；没有明确要求换装时保留原服装。
明确要求其他主体（例如猫、企鹅、风景）时，正常画那个主体，不强行加入小蓝。
其他生成图也不替代最初这张三视图作为角色标准。
之后会持续在这个聊天生图，每次画小蓝请参考最初三视图，不要只参照上一张图。
现在请确认你已看到参考图并描述特征，暂时不要生图。
```

确认它描述的是上传的角色，再把聊天改名为 **`小蓝｜固定形象与生图`**（名称必须唯一）。保留这张原始参考图和聊天。长聊仍可能遗忘或出现形象漂移，必要时在同一聊天重新上传原图；固定聊天不等于永久、精确的角色记忆。

复制聊天链接中 `/c/` 后面的 UUID，填在本地配置的 `conversationId` 中供人工核对。**实际自动选择依据是唯一标题与工具栏，不是此 UUID**；不要给别的聊天起相同名字。

## 4. 配置并先检查绑定

```powershell
Copy-Item fixed-chat.example.json fixed-chat.local.json
notepad fixed-chat.local.json
```

需要改：`title`、`conversationId`、`promptPrefix`。只有你已经上传原图并确认识别后，才把 `referenceConfirmed` 改为 `true`。图片路径不需要写进配置：图片已在 Chat 聊天里，本地路径不会让模型自动读取文件。

```powershell
node scripts/check-binding.mjs
node scripts/check-binding.mjs --open
```

第一个命令只检查唯一的现有聊天是否出现在侧栏；第二个选择该聊天并核对工具栏标题。都不会创建聊天、发提示词或生图。固定聊天被折叠、滚出虚拟列表或重名时，手动打开并确保它在侧栏可见，再试。

## 5. 独立验证一次真实生图

以下命令会消耗你登录账号的生图额度，明确要测试时才执行：

```powershell
node scripts/generate-image.mjs '画一张小蓝双手抱热可可、坐在暖色沙发上的Q版插画' './out/cocoa.png'
```

验收：图片确实落盘且能打开；图中是原图角色；桌面聊天列表没有多出新生成聊天；提示词和图片追加到第 3 步的固定聊天。再画一张其他主体，确认它仍追加到原聊天且不被强行画成角色。

脚本保护包括：唯一主窗口、聊天加载等待、唯一标题、生成互斥锁、旧图基线、超时停止。它只接受本机 CDP；失败时不自动新建聊天，也不自动重画。多个 QQ 请求同时来时返回“忙”，不是并行绘图队列。

## 6. 接入桥接与 MCP

独立脚本成功后，按 [接入说明](references/integration.md) 完成以下增量改动：

1. 桥接用 `spawn` 运行生成脚本并读取图片字节。
2. 加入鉴权、会话隔离、白名单、静默、限流和发送队列都适用的生图接口。
3. MCP 注册 `qq_generate_image`，工具内部调用这个接口，成功就表示图片已经发到 QQ。
4. DSH 实际使用的 profile / preset 允许加载该工具。
5. 所有层的超时覆盖真正出图时间；工具发送成功归类为已发送，避免桥接又自动转发一遍。

这一步与桥接版本有关，文档中的代码有明确接入点，不是完整替换文件。不要为了跑通绕开已有授权检查。

## 7. 证明 DSH 真看见工具，而不只是 MCP 里存在

这是本次最关键的坑：**MCP 单独握手能看到新工具，不代表正在运行的 DSH 会话已经重新加载 schema。**

依次检查 MCP `tools/list`、实际 DSH 会话工具清单、模型 `tool/call`、桥接接口结果。若前者有、实际会话没有：找 GUI 真正连接的后台，重启/重连该后台的 MCP。仅重启另一个 Web 后台无效。必要时新建一个探测会话，不要先删掉原来的正常聊天。

Windows 只读检查进程示例：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'DeepSeek Harness.exe' } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath
```

找到实际 GUI 的后台子进程，确认桥接配置指向它的端点。桌面后台端口可能会变，不要把某个固定端口当成“桌面版”的标志。profile 的位置也是版本相关的，`~/.dsh/profiles/desktop/cordis.patch.yml` 与 `~/.dsh/profiles/web/cordis.patch.yml` 只是常见候选，必须从实际进程/配置确认。

## 8. 在 QQ 私聊、群聊分别验收

从你自己的允许会话发测试请求。群聊沿用你原先的触发规则：仅 @ 模式必须真实 @ 机器人。依次取得：

| 层级 | 应看到什么 |
| --- | --- |
| 入站 | 正确的当前会话 key，群聊命中真实 @ |
| DSH | `tool/call` 为 `qq_generate_image`，不是口头声称会画 |
| 桌面 | 同一个固定 Chat 出现这次提示词和新图 |
| 桥接 | 生图成功、发送接口 `status=ok` 且 `retcode=0` |
| QQ | `get_msg(message_id)` 读回，发送者为机器人，目标会话正确，包含 `image` 段 |

不要把“本地 PNG 出来了”“模型说发了”当成已经发到 QQ 的证据。

## 常见失败

详细定位见 [排错表](references/troubleshooting.md)。包括工具未挂载、15 秒假超时、固定聊天找不到、浮窗误选、旧图误取、群聊只看似无效、普通聊天工具参数 JSON 错误等。

## 作为 Codex skill 使用

将本仓库整个目录复制到 `$CODEX_HOME/skills/dsh-chatgpt-image-skill`，未设置 CODEX_HOME 时通常是 `~/.codex/skills/dsh-chatgpt-image-skill`。重新加载 Codex 的 skill 后这样说：

```text
使用 $dsh-chatgpt-image-skill，先检查我的现有 DSH 和 QQ 桥接，再按本机实际路径打通桌面生图并绑定固定聊天。保留原白名单、角色卡和启动方式。
```

skill 提供操作知识，不会自动获得 QQ、ChatGPT 或电脑的权限。它可以辅助配置，但用户仍需自己登录、准备参考图，并使用当前工具允许的操作方式。

## 本地测试与分享前检查

```powershell
npm test
npm run privacy
```

测试不需要登录、不访问模型、不发 QQ。扫描排查私有编号、用户目录、凭据和意外产物；它是辅助检查，发布前还应审阅全部待提交文件及 Git 作者邮箱。

本仓库不提供或上传实际角色图、生成图、QQ 账号/群号、聊天 UUID、消息 ID、Token、Cookie、本机用户路径、运行日志与机器人配置。

## 资料和实现边界

- [OpenAI：Skills 的目录结构](https://developers.openai.com/plugins/concepts/skills)：本仓库的 `SKILL.md`、references、scripts 按此结构组织。
- [OpenAI：图像生成与参考图](https://learn.chatgpt.com/docs/image-generation)：说明图像生成和参考图的产品能力。

以上官方资料不为本仓库的 CDP 自动化或 DSH/QQ 接入背书。桌面选择器、工具缓存和超时处理来自本地排错经验，客户端更新后可能需要调整。
