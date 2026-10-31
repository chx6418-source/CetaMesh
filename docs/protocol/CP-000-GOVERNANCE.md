# CP-000 — 核心协议治理与兼容（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED；范围：Desktop、Mobile、Plugin SDK、Agent 接入、设备 Mesh、数据迁移。**

## 1. 事实源与规范层级

1. **运行时实现与既有已发布契约优先用于判断当前兼容事实**。只有在批准新规范并通过迁移与契约测试后，才宣布新协议生效。
2. 每个协议族应有唯一所有者：AgentProvider (`src/agent/agent-provider.js`)；Extension Manifest (`src/extension/manifest.js`)；Memory (`src/memory/types.js` 与 `policy.js`)；Capability (`src/capability/*`)；Task (`src/task/types.js`)；Continuity (`src/continuity/*`)；IPC (`src/control/ipc-protocol.js`)；配对 (`docs/protocol/UNIFIED_PAIRING_V1_1.md`)。
3. `RULES.md` 当前仍载有旧 QQ/DSH/SnowLuma 规则；这些历史规则不能未经核对直接当作未来原生 Simulation 的协议规范。应在明确版本兼容和迁移之后由 Owner 审阅更新。
4. 本文档包引入 `CP-*` 规范族；不自动使它们高于既有 v1 线上字节契约。各项标注 `EXISTING / ALIGNMENT / NEW`。

## 2. 协议与代码版本分离

- `protocolId` 用于**新的领域/交互契约**；建议 `cetamesh.core`, `cetamesh.agent`, `cetamesh.extension`, `cetamesh.memory`, `cetamesh.capability` 等命名。原有 `protocol:"cetamesh", version:1` 的配对信封和 `v:1` 的 Extension Worker 保持原义。
- 协议族使用 `MAJOR.MINOR`：增加可选字段、可选事件、可发现能力可作为 MINOR；改变已签名字段、必填字段、授权语义、默认权限或删除命令必须新 MAJOR 或建立明确的兼容适配器。
- Plugin 包版本与 Manifest schemaVersion 分开；产品版本与各协议族版本分开；ACP/MCP/A2A 上游规范版本也单独固定。
- 生产端协商**双方明确支持**的版本；不存在时 fail closed，不能只因主版本号接近就猜兼容。

## 3. 协议变更流程（强制）

1. 先提交 ADR：动机、当前调用者/消费者、实际使用路径、兼容性风险、权限与数据影响、回滚措施。
2. 更新本族规范 + 机器可校验 DTO/Schema + 错误码表 + 正负 fixtures + Provider/Plugin 示例。
3. 同步更新生产者、消费者、Core IPC 层、UI 投影和审计事件的类型边界。
4. 如影响 Mobile、配对或 `packages/`，同步两端规范/Golden Fixtures，分别运行测试；不能只合并 Desktop。
5. 引入兼容适配器，限定启用条件；不得隐式提升权限、变更用户数据或自动连接外部平台。
6. CI 增加与当前发布协议的兼容检查；Owner 审阅后才标记 `STABLE`。

## 4. 废弃策略

- 首次废弃标 `DEPRECATED`，记录最后兼容产品线、替代协议、警告码、迁移工具、预计移除版本。
- 已有稳定调用方须先迁移并通过真实契约测试，再删除旧入口。历史 ID 可以返回**明确停用错误**，但不能无审查静默重映射到新权限。
- 变更授权意义（如把 `installed` 当成 `ready`）属于破坏性变更；必须显式审批、更新测试与 UI 文案。
- 所有历史数据迁移可预览、可备份、可回滚；只读升级检查不能主动写库。

## 5. 规范词与状态

- `MUST`：可进入自动化/安全门禁的强制规范；`SHOULD`：需要例外理由；`MAY`：可选。
- 实现状态：`IMPLEMENTED`, `PARTIAL`, `PLANNED`, `DEPRECATED`, `BLOCKED_ENV`, `UNKNOWN`。
- 测试状态：`PASS`, `FAIL`, `NOT_RUN_ENVIRONMENT`, `BLOCKED_ENV`，报告附 Commit、测试命令、环境、证据路径。
- **协议成熟度不等于功能可用性**。Schema 通过不能替代真实模型、外部 Agent、安装包或双设备 E2E。

## 6. 新功能的接口优先原则

新增外部 Agent / 插件 / 通信渠道 / Memory backend 前，先查询已有 Provider、Extension、Broker、Memory、Mesh 等契约；能适配则不新建核心 Runtime。任何插件系统必须避免第二套 Task、Approval、Secrets Store 和 Event Journal。
