# CP-030 — 记忆协议、Memory 插件接入及数据可追溯性（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT + NEW；事实源 `src/memory/types.js`, `policy.js`, `runtime.js`, `src/extension/memory-pack.js`, `docs/plugin-development/08-memory-pack.md`。**

## 1. 记忆是 Core 所有的有权限数据域

当前类型：`working`, `chat`, `user`, `task`, `workspace`, `social`, `knowledge`, `skill`；Scope：`global`, `workspace`, `task`, `chat`, `user`；来源标识：`user`, `chat-candidate`, `qq-adapter`, `system`。这些是当前有限词表，**不得为了新插件随意添加类型或把未知类型归入 global**。

必须保持 `authorize → retrieve → rank` 次序。Store 只能扫描授权分区；不能先检索全部 Memory 然后在调用方过滤。Agent 默认读 `working/chat`，只可写 `working`；长期记忆必须提出候选，由用户确认后进入可信记忆。`factKey/validUntil` 的身份与时间事实由有权用户确定。

## 2. Memory 插件三种模式必须区分

**A. Memory Pack（已实现的 data-only）**

- `type:"memory-pack"` 的 `.json`、`schemaVersion:1`、严格字段白名单、只读 Base + 用户 Overlay、引用/摘要而非聊天消息全文；当前最多 200 entries、256 KiB。
- Memory Pack 不得请求 `memory.write`、文件写、网络、Shell、Native 或其他可执行副作用；它不是代码执行载体。用户 Overlay 可增注释/标签/禁用引用，但不能改写不可变 Base。

**B. 普通 Extension 请求记忆能力（当前权限基础已存在）**

- Manifest 声明 `memory.read` / `memory.write` 是**申请**；请求必须经 Core Capability Broker 与 Memory Policy 的双层校验。
- 返回必须限制 scope/types/limit，记录来源与可信度；未经确认写入长期记忆直接拒绝。

**C. 可替换 Memory Backend/Index Adapter（未来，尚未全面实现）**

- 例如向量索引或用户自主添加的外部检索后端，应通过 Core 管理的 `MemoryAdapter` 接口注入，而不是获得任意用户 Memory DB 直读权。
- 只允许索引已授权、已选择同步的内容；异地/跨设备默认不出本机。索引结果作为候选引用，最终再经 Core Memory Policy 授权与源记录读取。
- 远程后端需要独立来源标记、数据驻留、生命周期、删除/撤销和保留期；不能以“性能优化”静默上传 Memory。

## 3. MemoryAdapter v1 建议领域接口（新增提案）

```ts
interface MemoryAdapterV1 {
  describe(): { id: string; version: string; capabilities: string[]; locality: 'local'|'remote' };
  health(): Promise<{ ready: boolean; reason?: string }>;
  query(authorizedFilter: CoreIssuedFilter, query: string, limit: number, signal?: AbortSignal): Promise<MemoryReference[]>;
  resolve(authorizedFilter: CoreIssuedFilter, refs: string[], signal?: AbortSignal): Promise<MemoryReference[]>;
  close(): Promise<void>;
}
```

`CoreIssuedFilter` 是 Core 生成的**不可伪造**授权上下文，不得原样暴露为插件可提升范围的 token。可选 `upsertIndex/removeIndex` 只由 Core 同步管理触发，不开放通用插件自发写长期记忆。

## 4. 请求与返回

- `MemoryQuery` 至少含 `query`, `scopes[]`, `types[]`, `limit`（由 Core 严格裁剪），调用主体由 Core 注入。
- `MemoryReference` 应保留 `id`, `type`, `scope`, `source`, `provenance`, `revision`, `summary`, `time/validity`, `contentHash?`；可选内容返回仍需逐条授权。
- 插件导入的内容标记 `historical-unverified` 或受控 provenance；**模型自述、第三方网页和仿真角色台词不能自动成为用户确认的事实**。
- 写候选：`propose → pending → owner accept/reject → store`。拒绝不可由插件改写为成功；接受记录应记录来源、确认者、时间与后续更正。

## 5. 人格和范例不是普通事实记忆

原生 Simulation 的 Persona/Card、正反例 Dialogue Example Library 应作为版本化**角色资产**独立保留；Memory 只保存获授权的角色/项目关联、事实、决策和引用。不能把七千余字符的角色卡自动截断成通用 Memory Summary，更不能把对话负例当作模型推荐答复。

## 6. 范围、共享和外发

插件 A 不能直接读取插件 B 私有 Memory；需要用户授权的 Scope 并经 Core Memory API。跨角色/跨 Workspace/跨设备读写默认拒绝；跨设备使用现有 Mesh 显式授权机制，不因配对自动同步。删除/撤销应保留必要审计及可理解的清理状态。

## 7. 兼容与验收

旧 `qq-adapter` 和历史 Social Memory 只作为可审阅的数据来源，不再作为原生 Simulation 的必要前置。任何迁移需备份、列出受影响文件、Owner 确认 Scope 和原文完整性。测试应包括越权 Scope、隐式长期写、Memory Pack JavaScript 注入拒绝、错来源可信度、索引检索跨用户、撤销后访问、恢复一致性、加密存储和本机默认策略。
