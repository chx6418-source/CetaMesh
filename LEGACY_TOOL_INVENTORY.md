# LEGACY_TOOL_INVENTORY — CetaMesh Desktop 1.0 / 鲸桥 历史工具审计

> 审计对象仓库：`D:\GIT-QQ-BRIDGE`（git）
> 审计时 HEAD：`ce83264eeeb2552ffa6894f69e91fa8731568e40`（分支 `feature/tools-mcp-plugin-restoration-v1`）
> 全历史 refs：`main` / `codex/*` / `feature/*` / `backup/pre-identity-rewrite`（共 170 commits，git log --all）
> 审计方式：只读 git（`git log --all`、`git log -S`、`git show <sha>:<path>`、`git grep <sha>`）+ 当前 HEAD 源码 + 已安装 DSH 配置只读检查。
> 本文件不修改任何其它文件、不写新代码、不 commit。

## 汇总计数

| 指标 | 数量 | 说明 |
| --- | --- | --- |
| 历史工具/能力条目总数 | **90** | 64 个工具条目 + 26 个 Capability/扩展能力条目 |
| 当前仍有实现数 | **83** | HEAD 内 74（51 MCP 工具 + 23 Capability）+ 侧分支 6（Task MCP）+ 扩展能力 3 |
| 当前可调用数（默认配置、HEAD、DSH 已挂载 5 个 MCP） | **50** | MCP 工具 47（51 − 2 个需 allowProcessControl − 1 个默认不注册 − 1 个默认 403）+ 扩展能力 3 |
| 建议恢复数 | **0（无条件）；8（有条件 partial）** | 6 个 Task MCP（侧分支未合并，需评审）+ 2 个 snowluma-host 进程控制（仅 owner 模式） |
| 建议废弃数 | **2** | `query_action`（被 snowluma-safe 取代）、`invoke_action`（任意 OneBot 写动作执行器） |
| 因安全原因不能恢复数 | **3** | `invoke_action`、`cetamesh_task_process_run`、`channel.send`（真实发送传输） |

计数口径：
- “工具条目”= 一个可被 agent/模型调用的具名工具（含 MCP 全名）。
- “Capability/扩展能力条目”= `src/capability/**` 注册的 capability id 与扩展 manifest 声明的 capability。
- “当前可调用”= HEAD 源码已注册 **且** 默认配置下不会被启动期跳过/执行期 403 的条目（白名单、会话令牌、审批仍可进一步拒绝单次调用）。
- “建议恢复”仅指当前不可达但建议重新接线的条目；已经在线的 47 个工具按现状保留，不计入“恢复”。
- 依赖外部 DSH 插件、仓库内无实现的 5 个模型侧/视觉条目单列，不计入“当前仍有实现”。

---

## 证据与命名口径

- MCP 全名由 `src/dsh-integration.js` 的 `MCP_SERVERS`（`server.id.replace('mcp-','')` → `serverName`）与 DSH 客户端命名空间拼接而成：`mcp__<serverName>__<toolName>`。已安装 profile `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 与之逐条一致（5 个 server：snowluma / snowluma-host / web-search-safe / qq-file-send / bilibili）。
- 安装器事实源：`src/dsh-integration.js:27-33`（当前）与 `git show 4b8147a:src/dsh-integration.js`（首次引入 5-server 列表）。
- MCP 分派事实源：`src/core-dispatch.js:16-30`（`MCP_MODES` + `MCP_ALIASES`）。
- 工具白名单事实源：`dsh/agent-presets/whale-chat/qq-tool-restrict.mjs:39-57` 与 `.../whale-chat-v2/qq-tool-restrict.mjs`（`SAFE_PREFIXES` / `SAFE_EXACT`）。
- Capability 事实源：`src/capability/service.js:11-16`（`WORKSPACE_CAPABILITIES`）、`src/capability/service.js:88-215`、`src/capability/adapters.js:47-107`、`CAPABILITY_COVERAGE.md:20-40`。
- “Direct（by design），不迁 Broker”依据：`CAPABILITY_COVERAGE.md:38`（QQ MCP 工具链保留适配器边界，不迁 Capability Broker）。

### 历史 MCP 工具演进（未发生“删除”）

- `906f919`（initial import）：`src/mcp-snowluma-safe.js` 36 个 qq_* 工具；`mcp-host-server.js` 3 个；`mcp-web-search-safe.js` 2 个；`mcp-qq-file-send.js` 5 个；`mcp-bilibili.js` 2 个。
- `9c00595`：新增 `qq_get_card_msg`（37）。
- `756925f`：新增 `qq_click_card_button`、`qq_get_card_button_approval`（39）。
- 结论（取证）：QQ MCP 工具集合在全部 refs 上**单调递增，没有任何 qq_* 工具被删除或改名**。所谓“工具后来不可用”不是源码删能力，而是**挂载/白名单/开关**层面的事实（见下）。

---

## 表 1 — QQ 仿生聊天 MCP 工具（`mcp__snowluma__*`，即 `mcp-snowluma-safe` 模式 `snowluma`）

历史路径统一为 `src/mcp-snowluma-safe.js`（首次入库 `906f919`，当前 HEAD 同路径）。Capability 列统一 `none（Direct by design, CAPABILITY_COVERAGE.md:38）`。

| 名称（MCP 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp__snowluma__qq_status` | src/mcp-snowluma-safe.js | 查询机器人登录状态与账号（只读） | 有（src/mcp-snowluma-safe.js:174, 906f919 起） | 是（注册于 MCP server 启动；OneBot 直连） | none | low（只读 OneBot 查询） | yes（已在用，保持） |
| `mcp__snowluma__qq_list_groups` | src/mcp-snowluma-safe.js | 列出机器人群（只读，白名单过滤） | 有（:190） | 是（social 模式执行期拒绝，见 :198） | none | medium（读群清单/PII） | yes（保持） |
| `mcp__snowluma__qq_get_group_members` | src/mcp-snowluma-safe.js | 群成员列表（只读，群号白名单 + authorizeRead） | 有（:218） | 是（受群白名单 + 读取鉴权） | none | medium（读成员 PII） | yes（保持） |
| `mcp__snowluma__qq_get_group_history` | src/mcp-snowluma-safe.js | 群历史（只读） | 有（:241） | 是（受群白名单 + 读取鉴权） | none | medium（读群历史） | yes（保持） |
| `mcp__snowluma__qq_send_group_message` | src/mcp-snowluma-safe.js | 发群消息（可选引用） | 有（:265） | 是（受白名单 + social 会话令牌） | none | high（发送/触网） | yes（保持） |
| `mcp__snowluma__qq_reply` | src/mcp-snowluma-safe.js | 引用/回复群消息 | 有（:288） | 是（受白名单 + 令牌） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_send_private_message` | src/mcp-snowluma-safe.js | 发私聊消息 | 有（:311） | 是（受 allow.private + 令牌） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_get_prompt` | src/mcp-snowluma-safe.js | 读 v2 提示词/角色/可用工具 | 有（:335） | 是（需会话令牌） | none | low（读本地状态） | yes（保持） |
| `mcp__snowluma__qq_get_unread_messages` | src/mcp-snowluma-safe.js | 未读消息（只读） | 有（:349） | 是（需令牌；受 tools.getUnread） | none | medium（读消息） | yes（保持） |
| `mcp__snowluma__qq_get_recent_messages` | src/mcp-snowluma-safe.js | 最近消息（只读） | 有（:363） | 是（需令牌；受 tools.getRecent） | none | medium（读消息） | yes（保持） |
| `mcp__snowluma__qq_social_state` | src/mcp-snowluma-safe.js | v2 唤醒/未读状态（只读） | 有（:382） | 是（需令牌；受 tools.socialState） | none | low（读状态） | yes（保持） |
| `mcp__snowluma__qq_mark_read` | src/mcp-snowluma-safe.js | 标记已读 | 有（:396） | 是（需令牌；受 tools.markRead） | none | low（改本地未读态） | yes（保持） |
| `mcp__snowluma__qq_set_wake_config` | src/mcp-snowluma-safe.js | 设置唤醒/潜水策略 | 有（:410） | 是（需令牌；受 tools.setWakeConfig） | none | medium（改自身唤醒行为） | yes（保持） |
| `mcp__snowluma__qq_send_burst` | src/mcp-snowluma-safe.js | 分条发送 | 有（:444） | 是（需令牌；受 tools.sendBurst） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_send_message` | src/mcp-snowluma-safe.js | v2 主发送工具（数组分条） | 有（:486） | 是（需令牌；受 tools.sendMessage） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_send_poke` | src/mcp-snowluma-safe.js | 发拍一拍 | 有（:533） | 是（默认 tools.sendPoke!==false 时注册；需令牌） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_wait_for_messages` | src/mcp-snowluma-safe.js | 等待消息/静默窗口（含沉睡前观察） | 有（:557） | 是（需令牌；受 tools.waitMessages） | none | low（轮询本地态） | yes（保持） |
| `mcp__snowluma__qq_report_feedback` | src/mcp-snowluma-safe.js | 上报反馈 | 有（:582） | 是（需令牌；受 tools.feedback） | none | low（写反馈记录） | partial（v2 persona 未推荐，可保留） |
| `mcp__snowluma__qq_get_my_recent_messages` | src/mcp-snowluma-safe.js | 自己最近消息（只读） | 有（:605） | 是（需令牌；受 tools.getMyRecent） | none | low（读消息） | partial（persona 未列出，可保留） |
| `mcp__snowluma__qq_get_message_detail` | src/mcp-snowluma-safe.js | 单条消息详情（只读） | 有（:623） | 是（需令牌；受 tools.getMessageDetail） | none | medium（读消息） | yes（保持） |
| `mcp__snowluma__qq_get_active_members` | src/mcp-snowluma-safe.js | 活跃成员（只读） | 有（:641） | 是（需令牌；受 tools.getActiveMembers） | none | medium（读成员活动/PII） | yes（保持） |
| `mcp__snowluma__qq_memory_append` | src/mcp-snowluma-safe.js | 写轻量记忆 | 有（:659） | 是（需令牌；受 tools.memory） | none（独立于 src/capability 的 memory.*，见 src/memory/） | medium（持久化写入） | yes（保持） |
| `mcp__snowluma__qq_memory_query` | src/mcp-snowluma-safe.js | 查轻量记忆 | 有（:689） | 是（需令牌；受 tools.memory） | none | low（读取） | yes（保持） |
| `mcp__snowluma__qq_memory_remove` | src/mcp-snowluma-safe.js | 删单条记忆 | 有（:709） | 是（需令牌；受 tools.memory） | none | medium（破坏性写入） | yes（保持） |
| `mcp__snowluma__qq_memory_clear` | src/mcp-snowluma-safe.js | 清空分类/全部记忆 | 有（:733） | 是（需令牌；受 tools.memory） | none | medium（破坏性写入） | yes（保持） |
| `mcp__snowluma__qq_slang_query` | src/mcp-snowluma-safe.js | 查已收录黑话 | 有（:755） | 是（需令牌；受 tools.slangQuery） | none | low（读取） | yes（保持） |
| `mcp__snowluma__qq_slang_submit` | src/mcp-snowluma-safe.js | 提交黑话候选（需管理员确认） | 有（:774） | 是（需令牌；受 tools.slangSubmit） | none | low（写候选） | yes（保持） |
| `mcp__snowluma__qq_get_message_images` | src/mcp-snowluma-safe.js | 取消息图片/表情并返回图像 | 有（:799） | 是（默认 tools.getImages!==false 时注册） | none | medium（读图 + 本地读盘） | yes（保持） |
| `mcp__snowluma__qq_list_stickers` | src/mcp-snowluma-safe.js | 收藏表情列表（读） | 有（:845） | 是（默认 sticker.enabled + tools.listStickers） | none | low（读取） | yes（保持） |
| `mcp__snowluma__qq_get_sticker_image` | src/mcp-snowluma-safe.js | 取表情图（读，返回图像） | 有（:871） | 是（默认 sticker.enabled + tools.getStickerImage） | none | low（读取） | yes（保持） |
| `mcp__snowluma__qq_send_sticker` | src/mcp-snowluma-safe.js | 发送收藏表情 | 有（:899） | 是（默认 sticker.enabled + tools.sendSticker） | none | high（发送） | yes（保持） |
| `mcp__snowluma__qq_collect_sticker` | src/mcp-snowluma-safe.js | 收藏表情到 QQ 账号（写） | 有（:926） | 是（默认 sticker.enabled + tools.collectSticker） | none | medium（写 QQ 账号收藏） | yes（保持，受频率限制） |
| `mcp__snowluma__qq_get_self_image` | src/mcp-snowluma-safe.js | 取自身 Q 版形象图（读） | 有（:952） | 是（默认 tools.getSelfImage!==false） | none | low（读取静态资源） | yes（保持） |
| `mcp__snowluma__qq_sticker_note` | src/mcp-snowluma-safe.js | 写本地表情笔记 | 有（:980） | 是（默认 sticker.enabled + tools.stickerNote） | none | low（写本地） | yes（保持） |
| `mcp__snowluma__qq_set_sticker_remark` | src/mcp-snowluma-safe.js | 改 QQ 官方表情备注（写 QQ 账号） | 有（:1011） | **否**（默认 `socialV2.tools.setStickerRemark=false`，启动期不注册；src/config/migrate.js:65） | none | high（写外部账号） | no（安全红线，保持默认关闭） |
| `mcp__snowluma__qq_get_forward_msg` | src/mcp-snowluma-safe.js | 查看合并转发/聊天记录（读） | 有（:1037） | 是（默认 tools.getForwardMsg!==false） | none | medium（读消息） | yes（保持） |
| `mcp__snowluma__qq_get_card_msg` | src/mcp-snowluma-safe.js | 读 QQ 官方机器人卡片（markdown/ark/json，只读） | 有（:1112，9c00595 新增） | 是（常驻注册，执行期读 tools.getCardMsg；默认 true） | none | medium（读消息内容） | yes（保持） |
| `mcp__snowluma__qq_click_card_button` | src/mcp-snowluma-safe.js | 点击卡片按钮（高风险写，触发外部副作用） | 有（:1143，756925f 新增） | **否**（常驻注册但执行期 `tools.clickCardButton!==true` → 403；src/config/migrate.js:60） | none | critical（代表 QQ 账号触发签到/抽奖/订阅等外部状态变更） | no（安全红线，保持默认关闭 + 逐次审批） |
| `mcp__snowluma__qq_get_card_button_approval` | src/mcp-snowluma-safe.js | 查询卡片按钮管理员审批状态（只读） | 有（:1176，756925f 新增） | 是（注册于 server 启动） | none | low（只读审批记录） | yes（保持） |

---

## 表 2 — SnowLuma 进程/宿主 MCP（`mcp__snowluma-host__*`，模式 `snowluma-host`）

历史/当前路径：`src/mcp-host-server.js`（906f919 起；`src/core-dispatch.js:18,26` 分派）。Capability 统一 none。

| 名称（MCP 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp__snowluma-host__snowluma_status` | src/mcp-host-server.js | 探活 OneBot 网关（只读；admin 时才附路径/PID） | 有（src/mcp-host-server.js:145） | 是（始终注册） | none | low（只读探活；admin 分支会暴露本机路径/PID） | yes（保持） |
| `mcp__snowluma-host__start_snowluma` | src/mcp-host-server.js | 启动 SnowLuma 并等待就绪（最长 90s） | 有（:162） | **否**（仅 `snowluma.allowProcessControl===true` 时才注册；且需 owner-agent 模式） | none | critical（进程控制） | partial（仅 owner 模式按需；不可默认恢复） |
| `mcp__snowluma-host__stop_snowluma` | src/mcp-host-server.js | 按安装目录 taskkill 停止 SnowLuma | 有（:200） | **否**（同上） | none | critical（进程控制/断 QQ 连接） | partial（仅 owner 模式按需；不可默认恢复） |

---

## 表 3 — 安全联网 MCP（`mcp__web-search-safe__*`）

路径：`src/mcp-web-search-safe.js`（906f919 起）。Capability 统一 none（`CAPABILITY_COVERAGE.md:36-37` 记录 Broker 的 `web.search` / `network` 是另建的 Desktop 能力面，MCP server 本身仍是独立适配器）。

| 名称（MCP 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp__web-search-safe__web_search` | src/mcp-web-search-safe.js | 只读网页搜索 | 有（src/mcp-web-search-safe.js:375） | 是（随 MCP server 注册） | none（Broker 侧同名能力 `web.search` 另注册于 src/capability/service.js:200） | medium（联网） | yes（保持） |
| `mcp__web-search-safe__web_fetch` | src/mcp-web-search-safe.js | 抓取 HTTP(S) 正文（SSRF 拦截） | 有（:400） | 是（随 MCP server 注册） | none（Broker 侧 `network` 另注册于 src/capability/service.js:187） | high（联网抓取；已做内网/本机拦截） | yes（保持） |

---

## 表 4 — QQ 文件/音频 MCP（`mcp__qq-file-send__*`）

路径：`src/mcp-qq-file-send.js`（906f919 起）。开关：`socialV2.tools.fileSend` / `socialV2.tools.audioSearch`（`=== false` 才关闭；不在 `SOCIAL_V2_TOOLS_DEFAULTS` 中，故默认开启）。Capability 统一 none。

| 名称（MCP 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp__qq-file-send__qq_send_file` | src/mcp-qq-file-send.js | 发文件/音频（读本地绝对路径 + 上传） | 有（src/mcp-qq-file-send.js:343） | 是（默认开启；受目标白名单，src/mcp-qq-file-send.js:354） | none | critical（任意本地文件读取 + 外发） | partial（保留但应维持在受控/owner 边界，属“读本地文件”能力） |
| `mcp__qq-file-send__qq_search_audio` | src/mcp-qq-file-send.js | 酷狗搜歌（联网） | 有（:481） | 是（默认开启；`tools.audioSearch===false` 才关，:490） | none | medium（联网 + 第三方 API） | yes（保持） |
| `mcp__qq-file-send__qq_send_audio_from_url` | src/mcp-qq-file-send.js | 从 URL 取音频并发语音 | 有（:569） | 是（默认开启，:578） | none | high（联网下载 + 发送） | yes（保持，已有 safe-fetch 限制） |
| `mcp__qq-file-send__qq_search_local_audio` | src/mcp-qq-file-send.js | 本地音频搜索 | 有（:642） | 是（默认开启；文件发送开关，:650） | none | high（本地文件系统枚举） | partial（受控边界内保留） |
| `mcp__qq-file-send__qq_read_local_audio` | src/mcp-qq-file-send.js | 读本地音频元数据 | 有（:705） | 是（默认开启；文件发送开关，:712） | none | high（本地文件读取） | partial（受控边界内保留） |

---

## 表 5 — Bilibili MCP（`mcp__bilibili__*`）

路径：`src/mcp-bilibili.js`（906f919 起）。开关 `socialV2.tools.bilibili===false` 时 403（`src/mcp-bilibili.js:25-27`），默认开启。Capability 统一 none。

| 名称（MCP 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp__bilibili__bili_search_video` | src/mcp-bilibili.js | B 站视频搜索（只读联网） | 有（src/mcp-bilibili.js:185） | 是（默认开启；bilibili===false 时 403） | none | medium（联网，锁定官方公开接口） | yes（保持） |
| `mcp__bilibili__bili_hot_videos` | src/mcp-bilibili.js | B 站热门视频（只读联网） | 有（:221） | 是（同上） | none | medium（联网） | yes（保持） |

---

## 表 6 — 历史外部 legacy MCP：`@snowluma/mcp` 动作执行器

证据：`scripts/test-mcp-exec.mjs`（`906f919` 起，当前 HEAD 同路径）第 1-3 行注释“测试 @snowluma/mcp 的 write 模式”、第 14 行 `node_modules/@snowluma/mcp/dist/server.js`、第 35-38 行断言 `query_action` / `invoke_action`；依赖声明 `package.json:93`（`@snowluma/mcp ^1.14.10`）；postinstall 修补 `scripts/patch-snowluma-sdk.mjs:11`。该 server **从未出现在 `MCP_SERVERS`/DSH profile 配置中**，因此仓库内查不到它曾经挂载的 `serverName` 与完整 MCP 全名。

| 名称（历史工具名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `query_action`（外部包 `@snowluma/mcp`，write 模式） | scripts/test-mcp-exec.mjs（引用 node_modules/@snowluma/mcp/dist/server.js） | 按名字查询 OneBot 动作（通用只读动作调用） | 无（仓库内无源码；外部 npm 包） | 否（不在 5 个 MCP server 清单中，未挂载） | none | medium（通用 OneBot 只读动作，可探测任意动作） | no（已被 mcp-snowluma-safe 的安全子集取代，建议废弃） |
| `invoke_action`（外部包 `@snowluma/mcp`，write 模式） | scripts/test-mcp-exec.mjs | 按名字执行 OneBot 写动作（任意动作） | 无（仓库内无源码；外部 npm 包） | 否（未挂载；即使挂载也应拒绝） | none | critical（可执行任意 OneBot 动作，含群管理/文件等） | no（安全原因不可恢复，建议废弃） |

---

## 表 7 — CetaMesh Task MCP（`cetamesh_task_*`，侧分支）

证据：`dsh/agent-presets/cetamesh-task/task-tools-contract.json` 与 `src/tasks/task-mcp-gateway.js`，均在提交 `9391bb8`（`feat(desktop): add task agent execution loop`）引入，**只存在于分支 `codex/d1-unified-config-service`，不是 HEAD 的祖先**（`git merge-base --is-ancestor 9391bb8 HEAD` 返回 1；`git branch -a --contains 9391bb8` 仅该分支）。当前 HEAD 另有不同实现的 `src/task/**`（`16e073a` 引入），但没有 MCP 工具。

| 名称（MCP/agent 全名） | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cetamesh_task_workspace_list` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | 列 Task Workspace 目录 | 有（侧分支 src/tasks/task-mcp-gateway.js） | 否（未合并/未挂载） | workspace.read（src/capability/service.js:11-16） | medium（受控文件系统读） | partial（评审后按 capability 面承接） |
| `cetamesh_task_workspace_read` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | 读 Workspace 内 UTF-8 文件（有界） | 有（侧分支） | 否 | workspace.read | medium（文件读） | partial |
| `cetamesh_task_workspace_write` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | 审批后创建/覆盖 Workspace 文件 | 有（侧分支） | 否 | workspace.write | high（文件写 + 审批） | partial（必须保留审批） |
| `cetamesh_task_git_status` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | Workspace git status（只读） | 有（侧分支） | 否 | workspace.git.status | low/medium（只读 git） | partial |
| `cetamesh_task_git_diff` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | Workspace git diff（只读） | 有（侧分支） | 否 | workspace.git.diff | medium（只读 git，含敏感路径抑制需求） | partial |
| `cetamesh_task_process_run` | dsh/agent-presets/cetamesh-task/task-tools-contract.json | 审批后执行进程（cwd=Workspace） | 有（侧分支） | 否（历史设计为显式审批） | process.run（能力面不存在；src/capability/types.js:4 将 process 列为 FORBIDDEN） | critical（任意进程执行） | no（安全原因不可无条件恢复；与 FORBIDDEN_PERMISSIONS 冲突，需重新设计） |

---

## 表 8 — 模型侧 / DSH 内置工具（白名单引用，仓库内无实现）

证据：`dsh/agent-presets/whale-chat/agent.cordis.yml:47-59`（只挂载 `dsh-tool-web`（search/fetch 关闭）、`dsh-tool-ask-user`、`dsh-tool-todo`）；`dsh/agent-presets/whale-chat/qq-tool-restrict.mjs:39-57`（`SAFE_PREFIXES` 含 `vision_`；`SAFE_EXACT` 含 `ask_user_question`、`todo_write`、`read_image`、`describe_image`）。仓库内没有这些工具的注册实现。

| 名称 | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ask_user_question` | dsh/agent-presets/whale-chat/agent.cordis.yml:53-54 | 向用户/管理员提问 | 有（DSH plugin `@deepseek-ai/dsh-tool-ask-user`，非本仓库） | 是（preset 已挂载） | none | low（只提问） | yes（保持） |
| `todo_write` | dsh/agent-presets/whale-chat/agent.cordis.yml:56-59 | 任务列表 | 有（DSH plugin `@deepseek-ai/dsh-tool-todo`，非本仓库） | 是（preset 已挂载） | none | low（只维护列表） | yes（保持） |
| `read_image` | dsh/agent-presets/whale-chat/qq-tool-restrict.mjs:52-57 | 只读看图 | 无（仓库内无实现；白名单声明） | 否（preset 未挂载对应 provider；即使全局存在也未验证） | none | low（只读图） | partial（需先确认 DSH 视觉插件是否挂载，否则是死白名单项） |
| `describe_image` | dsh/agent-presets/whale-chat/qq-tool-restrict.mjs:52-57 | 图像描述 | 无（仓库内无实现；白名单声明） | 否（同上） | none | low（只读图） | partial（同上） |
| `vision_*`（前缀） | dsh/agent-presets/whale-chat/qq-tool-restrict.mjs:45-47 | OCR/定位等视觉工具族 | 无（仓库内无实现；白名单声明） | 否（preset 未挂载对应 provider） | none | low/medium（只读图） | partial（同 read_image/describe_image；需 DSH 侧确认） |

---

## 表 9 — Capability Plane（`src/capability/**`）

这些不是 MCP 工具，而是 CetaMesh Desktop 的 generic capability id；是“当前 Capability”列的映射目标。全部在 HEAD 有实现。

| Capability id | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| `workspace.read` | src/capability/service.js:11-16, 88-160 | 读 Workspace 文件（含敏感路径保护） | 有 | 是（Broker 注册；owner/agent+grant 决定） | medium | yes（保持） |
| `workspace.write` | 同上 | 写 Workspace 文件 | 有 | 是（需对应 permission/审批） | high | yes（保持） |
| `workspace.file.search` | 同上 | Workspace 文件搜索 | 有 | 是 | low | yes（保持） |
| `workspace.git.status` | 同上 | git status（只读） | 有 | 是 | low | yes（保持） |
| `workspace.git.diff` | 同上 | git diff（只读；agent 路径抑制敏感路径） | 有 | 是 | medium | yes（保持） |
| `workspace.git.commit` | 同上 | git commit（审批） | 有 | 是（high 审批） | high | yes（保持） |
| `workspace.test.run` | 同上 | 执行 Workspace 登记的测试/受控 Runner | 有 | 是（owner 直执行；agent 需 grant + Owner Approve Once） | high | yes（保持，审批不可省） |
| `workspace.create` | 同上 | 创建/恢复 Workspace | 有 | 是 | high | yes（保持） |
| `memory.read` | src/capability/service.js:171-174 | 读 CetaMesh Memory | 有 | 是 | low | yes（保持） |
| `memory.write` | src/capability/service.js:175-180 | 写 Memory（agent 只能 working，其余候选） | 有 | 是 | medium | yes（保持） |
| `memory.link` | src/capability/service.js:181-185 | Memory 链接/上下文包 | 有 | 是 | medium | yes（保持） |
| `memory.desktop.read` | src/capability/service.js:163-170 | Owner 管理读 | 有 | 是（owner-only） | low | yes（保持） |
| `memory.desktop.write` | 同上 | Owner 管理写 | 有 | 是（owner-only） | low | yes（保持） |
| `memory.desktop.link` | 同上 | Owner 管理链接 | 有 | 是（owner-only） | low | yes（保持） |
| `network` | src/capability/service.js:187-199 | 只读 GET（safe-fetch，防 SSRF） | 有 | 是 | high | yes（保持） |
| `web.search` | src/capability/service.js:200-204 | 联网搜索（adapter；searchImpl 未绑定则 PROVIDER_UNAVAILABLE） | 有 | 视 searchImpl 绑定 | medium | yes（保持） |
| `clock.now` | src/capability/service.js:205-206 | 当前时间 | 有 | 是 | low | yes（保持） |
| `agent.run` | src/capability/service.js:207+ | 分配 Managed/DSH Agent 会话（owner-only，task/workspace 绑定） | 有 | 是（owner-only） | medium | yes（保持） |
| `channel.status` | src/capability/adapters.js:47-50 | 通道清单（只读） | 有 | 是 | low | yes（保持） |
| `channel.declarations` | src/capability/adapters.js:51-54 | 适配器声明（只读） | 有 | 是 | low | yes（保持） |
| `channel.send` | src/capability/adapters.js:55-95 | 发送校验面（allowlist + actor/channel/target） | 有 | **否**：sendImpl 未绑定 → `PROVIDER_UNAVAILABLE`（adapters.js:82-84） | high | no（真实发送传输因安全边界不恢复；QQ 发送继续走 MCP/白名单边界） |
| `mesh.status` | src/capability/adapters.js:99-102 | 节点状态（只读） | 有 | 是 | low | yes（保持） |
| `mesh.capabilities` | src/capability/adapters.js:103-106 | 能力清单（只读） | 有 | 是 | low | yes（保持） |

---

## 表 10 — Extension 能力（`extensions/**/extension.json`）

| 名称 | 旧路径 | 功能 | 当前是否还有实现 | 当前是否可调用 | 当前 Capability | 危险级别 | 是否应该恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cetamesh.hello-tool / hello.greet` | extensions/cetamesh-hello-tool/extension.json | 纯计算问候（无敏感权限） | 有（extensions/cetamesh-hello-tool/index.js:11-19） | 是（示例扩展；需安装并启用） | extension.`hello.greet` 经 src/extension/runtime.js:111 动态注册 | low | yes（保持） |
| `cetamesh.http-meta / meta.fetch-title` | extensions/cetamesh-http-meta/extension.json | 取网页标题（hosts 白名单 example.com） | 有 | 是（示例扩展；需安装并启用） | extension.`meta.fetch-title`；requires `network` | high（联网） | yes（保持） |
| `cetamesh.http-meta / meta.last-title` | extensions/cetamesh-http-meta/extension.json | 读本扩展私有存储的最近标题 | 有 | 是（需先 fetch） | extension.`meta.last-title`；requires `storage` | low | yes（保持） |

---

## 安全边界清单：不能恢复 / 必须保持不可达

1. `invoke_action`（`@snowluma/mcp`）：任意 OneBot 写动作执行器，绕过 QQ 适配器的白名单/只读子集/审批边界 —— 建议废弃，不恢复。
2. `cetamesh_task_process_run`：任意进程执行；`src/capability/types.js:4` 的 `FORBIDDEN_PERMISSIONS` 明确包含 `process`，两者冲突 —— 不能按旧设计无条件恢复。
3. `channel.send` 的真实发送传输：当前 `sendImpl=null`，如实返回 `PROVIDER_UNAVAILABLE` —— 按 `CAPABILITY_COVERAGE.md:32`，QQ 发送继续走既有 MCP/白名单边界，不绑入 Broker。
4. `mcp__snowluma-host__start_snowluma` / `stop_snowluma`：进程控制，默认关闭；即使开启也仅 owner-agent 模式 —— 不可作为默认能力恢复。
5. `mcp__snowluma__qq_click_card_button` / `qq_set_sticker_remark`：对外部账号/机器人的写操作，默认关闭且 `src/config/migrate.js:36` 标注“安全红线，不得改动” —— 保持默认关闭。
6. 扩展权限 `shell` / `native` / `download` / `process`：`src/extension/types.js:45-50` 定义为 `forbidden`，根本不可授予 —— 任何历史工具若依赖它们都不可恢复。

## 关键发现（哪些工具有实现但没接线）

1. **QQ MCP 工具没有任何“被删除”的历史**：`906f919`（36）→ `9c00595`（+qq_get_card_msg，37）→ `756925f`（+qq_click_card_button / qq_get_card_button_approval，39），全程只增不减；当前 `src/mcp-snowluma-safe.js` 仍是 39 个。所谓“工具不可用”不是能力删除，而是挂载/白名单/开关问题。
2. **“有实现但在默认配置下不可调用”的 QQ 工具**：`qq_set_sticker_remark`（默认 `false` → 启动期不注册）与 `qq_click_card_button`（默认 `false` → 执行期 403），二者是 `src/config/migrate.js:60,65` 明文安全红线。
3. **“有实现但默认未接线”的 host 工具**：`start_snowluma` / `stop_snowluma` 仅在 `snowluma.allowProcessControl===true` 且 owner-agent 模式下才注册/可用（`src/mcp-host-server.js:159,206-214`）。
4. **白名单死项**：`read_image` / `describe_image` / `vision_*` 在 `qq-tool-restrict.mjs` 中被放行，但 `whale-chat` / `whale-chat-v2` preset 并未挂载任何视觉 provider（`agent.cordis.yml:47-59` 只有 tool-web/ask-user/todo/qq-tool-restrict/compaction），仓库内也无实现 —— 需确认 DSH 全局是否提供，否则调用必然失败。
5. **侧分支未合并的完整 Task 工具面**：`cetamesh_task_*`（6 个）与 `src/tasks/**`、`dsh/agent-presets/cetamesh-task/**` 只存在于 `codex/d1-unified-config-service`（`9391bb8`），HEAD 无此 preset 也无此 MCP gateway；其中 `process_run` 与当前 `FORBIDDEN_PERMISSIONS` 冲突。
6. **外部 legacy 动作执行器已被取代**：`@snowluma/mcp` 的 `query_action` / `invoke_action` 仅在测试脚本 `scripts/test-mcp-exec.mjs` 与 `package.json:93` 留有痕迹，从未进入 `MCP_SERVERS`（5 个 server 清单）；其 `invoke_action` 是任意写动作执行面，属安全原因不能恢复。
7. **Capability 面与 QQ MCP 面是两套边界**：`CAPABILITY_COVERAGE.md:38` 明确 QQ MCP 工具链“不迁 Broker”；因此所有 `mcp__snowluma__*` 的 Capability 列都是 `none`，其安全由发送白名单、只读子集、风险卡逐次审批保证，而不是 capability policy。
8. **安装器事实源是 5 个 MCP server**：`src/dsh-integration.js:27-33` 的 `MCP_SERVERS` 是产品化恢复时必须同步的唯一白名单；已安装的 `~/.dsh/profiles/web/cordis.patch.yml` 与之一致（`WhaleBridgeCore.exe --mcp <mode>`）。任何历史工具若不在这 5 个 server 内，都需要先决定是否新增 server。

## 审计时的并发未提交工作树（非 HEAD 事实，仅作旁证）

审计过程中 `git status --porcelain` 显示工作树存在**非本次审计产生的**未提交改动（父任务正在进行的工具/插件恢复 WIP）：`scripts/run-all-tests.mjs`、`src/app/bootstrap.js`、`src/app/ipc-runtime.js`、`src/app/service-container.js`、删除的 `assets/project-intro.mp4`，以及未跟踪的 `src/integrations/**`、`scripts/test-mcp-registry.mjs`、`scripts/test-integration-tool-registry.mjs`、`scripts/test-integration-descriptors.mjs`、`scripts/test-bionic-chat-plugin.mjs`。本审计**未修改**这些文件，所有结论均以提交 HEAD `ce83264` 为准。

旁证（不构成历史证据，因未提交）：未跟踪的 `src/integrations/catalog.js` 把工具目录归纳为 5 个 MCP 命名空间（`mcp__snowluma__` 39、`mcp__qq-file-send__` 5、`mcp__web-search-safe__` 2、`mcp__bilibili__` 2、`mcp__snowluma-host__` 3）外加一个 Agent Provider 命名空间 `agent__`（`read_image` / `describe_image`），与本审计的工具清单一致；这是“产品化恢复”的进行中实现，不能作为“当前 HEAD 可调用”的依据。

---

## 存疑（未能从仓库取证）

1. **`@snowluma/mcp` 曾经的 MCP 全名/命名空间**：仓库 Git 历史中没有任何 `cordis.patch.yml` 或配置把它挂载为 DSH MCP server，只有测试脚本直接 spawn `node_modules/@snowluma/mcp/dist/server.js`。因此无法确定它历史上面向 agent 的完整名字（`mcp__???__query_action`），本文件只记录裸工具名。
2. **`read_image` / `describe_image` / `vision_*` 的提供方**：可能由 DSH 全局插件（如视觉路由插件）提供，但仓库内无挂载声明也无实现，无法证实当前是否全局可见。`docs/DSH_SETUP.md:136` 只提到“视觉路由插件”的存在，未给出工具名与挂载点。旁证：未提交 WIP `src/integrations/catalog.js:161-176` 把 `read_image` / `describe_image` 归为 Agent Provider 的 `agent__` 命名空间只读视觉工具，但这是进行中实现，不能证明历史或当前 HEAD 的可用性。
3. **“历史上一度可用、现在不可用”的外部证据**：全历史 `git log -S` 检索（mcp / tool / snowluma / sticker / slang / card / music / image / file / qq / weather / search / browser / desktop / clipboard / memory / workspace）未发现任何“工具被移除/下线”的提交或文档记录；`weather`、`clipboard`、`browser` 等关键词仅命中 UI/主题/更新相关文本，未发现对应的 MCP 工具名。若“大量工具不可用”指生产环境现象，仓库内可直接证实的机制只有：MCP server 未挂载/路径失效、`qq-tool-restrict` 白名单拒绝、以及上述默认关闭开关。**没有发现任何被删除的工具名，故不凭想象补充。**
4. **小鲸鱼主机外部状态**：`C:\Users\Administrator\.dsh\.agent-presets\whale-chat*\qq-tool-restrict.mjs` 与仓库内容结构一致（控制台读取时显示为乱码系终端编码，非文件损坏）；未发现额外的历史 preset（仅 `liangshen` 为用户自建，与鲸桥工具无关）。

---

## 审计所用命令（可复现，全部只读）

```
git log --all --oneline
git log --all --date=short --pretty=format:"%h|%ad|%s"
git log --all --diff-filter=D --name-status --pretty=format:"COMMIT %h %ad"
git log --all --pretty=format: --name-only --diff-filter=A
git log --all --oneline -S"<term>"          # term 见上列关键词
git grep -h -o -E "'qq_[a-z_]+'" <sha> -- src/mcp-snowluma-safe.js
git show <sha>:<path>                        # docs/archive/**, src/tasks/**, dsh/agent-presets/**
git merge-base --is-ancestor 9391bb8 HEAD
git branch -a --contains 9391bb8
```

审计文件（当前 HEAD）：
`src/mcp-snowluma-safe.js`、`src/mcp-host-server.js`、`src/mcp-web-search-safe.js`、`src/mcp-qq-file-send.js`、`src/mcp-bilibili.js`、`src/core-dispatch.js`、`src/dsh-integration.js`、`src/config/migrate.js`、`src/config/schema.js`、`src/capability/**`、`src/extension/**`、`src/workspace/**`、`dsh/agent-presets/**`、`extensions/**`、`scripts/test-mcp-*.mjs`、`CAPABILITY_COVERAGE.md`、`docs/DSH_SETUP.md`、`docs/PROJECT_GUIDE.md`、`docs/archive/**`；只读外部：`C:\Users\Administrator\.dsh\.agent-presets\whale-chat*\`、`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml`、`C:\Users\Administrator\.dsh\.whalebridge-integration.json`。
