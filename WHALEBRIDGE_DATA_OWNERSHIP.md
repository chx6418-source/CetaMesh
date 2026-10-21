# WhaleBridge / CetaMesh 数据所有权（M0，M5 前置）

审查起点 `f6586c323b41bb55872fac1d96e2a783ceeb7592`。本表描述**当前写者**和拟定 M5 约束；没有执行真实用户数据读取、备份、迁移或写者切换。`StateDir` 指 `src/app-paths.js` 解析的数据目录下 `state/`；路径以最终用户选择的数据根为准。源代码 `src/storage/json-file.js` 是现代持久 JSON 的统一 primitive，Bridge 旧写法是待收敛项。

| 数据/资产 | 当前权威写者及代码 | 读者/版本与风险 | M2～M5 唯一写者、兼容及回滚原则 |
| --- | --- | --- | --- |
| `state/tasks/tasks.json`、Task 运行态/关联 | `src/task/store.js`、`src/task/runtime.js`，Core | Capability、Chat、Continuity/Agent 读取；恢复、revision 和 Workspace writer 占用 | **Core Task 单写者**，不可启动第二 Task Runtime 指向同一 StateDir；保留 ID/rev/阻塞态语义，M5 前后对账 |
| `state/memory/memories.json`、候选及 links | `src/memory/{store,runtime,links}.js`，Core 经 JSON primitive | Chat/Task/QQ 只读 adapter；损坏恢复可能生成备份文件 | **Core Memory 单写者**；QQ/Bionic 仅提交候选，Owner 确认后写长期记忆；不直接改旧社交文件 |
| `state/workspaces.json` 与授权工作树 | `src/workspace/registry.js`、`tools.js`、`transaction.js`，Core/Capability Broker | Registry 经 config loader 读 JSON，损坏时回空清单，写入经 JSON primitive；真实 Workspace 文件由授权事务写，可能有原生 Agent staging | **Core Workspace grant/lease 单写者**；同一 Workspace 不得有两个写者；失联先核验副作用再释放；迁移时冻结写入并明确坏清单恢复策略 |
| `state/continuity/` packet/history/policy | `src/continuity/runtime.js`，Core | 关联 Task/Session、rollover 事务；`latest.json` 为缓存 | Core 唯一写；以提交历史/packet 为权威，缓存可重建；不能把断流伪装完成 |
| Chat 历史、Settings、Provider secrets、设备状态 | `src/desktop/chat-service.js`、`src/settings/`、`src/providers/`、`src/mesh/`，Core | Harbor 与 Agent 读取；正式消息提交后需 `chat.updated` | Core 持有；迁移保持 request/turn/message ID、凭据权限和 UI 提交顺序；Secrets 不进日志/报告 |
| `state/integrations/plugins.json`、`state/extensions/` | `src/integrations/store.js`、`src/extension/{store,settings,private-storage}.js`，Core | 插件注册、批准指纹、独立私有数据；坏文件 fail-closed，不得静默清空 | Core 管配置/批准；插件只能经受限 Broker/私有存储 API；坏插件不影响 Task/Memory；不可自动覆盖损坏数据 |
| `state/social-v2.json`、会话/卡片/贴纸/黑话 | `src/bridge.js` 旧社交循环及相关 helper；`src/memory/adapters/qq.js` 仅读 | QQ/Bionic 语义与 Core Memory 交叉；Bridge 有直接 JSON 原子写 | M4 前仍由 Bridge 单写；M4 切换采用**停旧消费者→快照校验→启新消费者**；Bionic 与 QQ transport 分责任，Core Memory 不回写此源 |
| `state/sessions.json` QQ↔DSH 映射、`current-role.json`、`mode.json` | `src/bridge.js:129-175,341-355` 及后续控制路径 | 旧控制/社交用途；与现代 Task Session ID 不等同 | 保留旧 ID 映射，先版本化只读导出；迁移窗口禁止旧/新同时写；失败恢复旧写者和旧入口 |
| `config.json`、角色与本机服务路径 | `src/config/` 与 Bridge 旧控制动作、`src/dsh-integration.js` setup | 既有 `WHALEBRIDGE_*` 路径别名；配置格式错误会阻断当前 Bridge 入口 | M2 拆 Core 必需配置和可选 Connector 配置；M5 不在原文件原地猜测升级，保留可回滚快照/显式版本 |
| DSH 用户 preset 与 `dsh/agent-presets/` 模板 | 外部 DSH 用户目录由用户/DSH 拥有；仓库 6 个文件是只读发布模板 | coding/social purpose 与 QQ 工具权限不同；现有 setup 有强制覆盖参数 | **不迁移或覆盖用户 preset**。未来仅显式授权、内容哈希比较、backup 与 dry-run；失败不降级安全规则 |
| `state/bridge.lock` 与 `.core-owner.lock` | 旧 Bridge 锁和 `src/app/state-owner.js` Core 锁 | 锁目前同进程取得，分别保护旧 QQ 与 Core StateDir；不能视为跨版本租约协议 | M2 保证仅一个 Core owner；M4 QQ 单消费者另用独立 lease/epoch；旧锁不能被当作唯一防双写证明 |
| `state/agent-token`、Owner pipe/token、日志和缓存 | Bridge/Core/Rust 各自生成；`src/bridge.js` 写 bridge/QQ/tool 日志 | 机密/诊断；安装器默认保留用户数据 | 不复制到报告或迁移日志；令牌只在所属 IPC 面有效；回滚不复用泄露/过期 token |
| SEA `resources/`、安装 payload | `scripts/build-core.mjs`、`scripts/build-release.mjs`，构建产物非用户写入 | `WhaleBridgeCore.exe` 与 `%LOCALAPPDATA%\WhaleBridge` 兼容 | M6 保留旧入口与资产直到可逆升级通过，安装/卸载不得删旧数据；sourceCommit/清单/hash 对账 |

## 写者切换的最低门槛（设计，尚未执行）

1. 停止旧 Bridge QQ 消费者和旧 Core worker；确认进程/lease/StateDir owner 释放，快照文件清单、字节哈希、版本、ID 引用和未完成 Task/审批。**不能同时运行双 QQ 消费者、双 Task 写者或双 Memory 写者。**
2. 在隔离副本上 dry-run：逐文件解析和 schema 检查，预估目的文件、冲突、磁盘量与不可逆外部副作用；坏文件保持原样并报告，不以空对象替代。
3. 得 Owner 单独批准后才可做真实备份/迁移：不可变备份、按步骤 journal、写入临时目标、fsync/原子提交、每一步 checksum/计数/ID/rev 对账。任一步未知就停在 `needs_review`，不启动第二写者。
4. 回滚：先停新写者，再按 journal 验证并恢复旧副本和入口；外部发送/工具副作用无法自动“反写”，必须人工核验。旧读写入口的弃用由 M6 另行批准。

本轮测试仅使用 `os.tmpdir()` 中独立夹具，损坏状态文件的原字节在测试结束前比较一致，随后删除**夹具目录**。没有碰 `%LOCALAPPDATA%\WhaleBridge`、实际 DSH preset 或真实 Workspace。
