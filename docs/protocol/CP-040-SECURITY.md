# CP-040 — 安全、Capability Broker 与审批协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT；优先复用 `src/capability/types.js`, `policy.js`, `broker.js`, `approval.js`, `operation-identity.js`, `src/agent/protocol/agent-permission-bridge.js`。**

## 1. 权限主体与边界

现有 Capability 可信主体类别：`owner`, `agent`, `external`, `extension`, `device`。身份和 grant 由可信 Core 入口注入；**来自插件、网页、LLM、远程 Agent 的 `actor`, `taskId`, `workspaceId`, `grants`, `approved` 字段都属于不可信数据**，不得提升为执行身份。

- 安装信任、包来源、配对信任、登录认证、能力声明与执行授权必须单独标识。
- Source content、角色卡、MCP 工具说明、网页和 Agent 输出都是 Reference Data，不是 System/Owner 指令。
- 使用 `Capability Broker` 作为所有敏感能力的唯一执行入口，不在插件、Agent 或 Mesh 模块各建一套绕过 Core 的授权缓存。

## 2. 授权处理顺序

`Validate Protocol/Schema → Bind Trusted Identity → Check Descriptor & Version → Scope/Workspace/Task → Permission & Policy → Owner Approval/Bounded Grant → Execute → Record Effect/Receipt → Audit`。

任一步失败即拒绝；未知权限默认拒绝。确认身份**不能**代替 Permission 和 Scope；安装或启用插件**不能**自动授权 `filesystem.write`。

## 3. Permission 与 Risk 映射

Capability Broker 当前权限目录包含 `filesystem.read/write/search`, `git.status/diff/commit`, `test.run`, `memory.read/write/link`, `extension.invoke`, `network`, `web.search`, `agent.run`, `message.send` 等。Extension 可以申请的权限是严格更小的白名单（见 CP-020），不能通过“使用同名字段”直接获得 Core 的任意能力。

Risk 等级 `low/medium/high/critical/forbidden`；效果类别以现有 `CAPABILITY_EFFECTS` 为准：`read-only`, `idempotent-write`, `conditional-write`, `non-idempotent`, `unknown`。不是所有标记为低风险的外部操作都可以无人工审批；应以实际 Operation Descriptor/Policy 为权威。

## 4. 审批契约

每次审批绑定：可信主体、capability ID、descriptor version/Hash、输入摘要、Scope、Task/Attempt、Workspace、工具身份、资源范围、有效期和使用次数。当前已有 `requestFingerprint`、有界 grant、一次性消费/撤销等基础，必须继续复用。

- 任何敏感字段或执行参数变化，都需要重新计算指纹和复审。
- 插件升级或 Provider 运行时变化后，旧审批不得继续授予新二进制能力。
- `pending` 审批不表示操作已执行。`approved` 也不等于 `completed`。
- 拒绝、撤销、过期和未确认状态必须可审计；不能通过换插件或换 Agent 自动绕过。

## 5. 操作状态与幂等性

状态区分 `prepared`, `started`, `completed`, `failed-no-effect`, `outcome-unknown`, `reconciled`（按现有 Continuity/Operation Context 的真实映射使用）。

- 只有可信执行层能证明 `failed-no-effect`；Provider 自称安全不能授权自动重放。
- `operationId` 是 Core 可信身份，现有 `operation-identity.js` 要求 Task/Workspace 绑定；同一 ID 的不同输入必须拒绝，不能复用为另一授权请求。
- 执行中断、RPC timeout、Agent cancellation、插件崩溃后仍可能已产生文件/网络/消息副作用；返回 `outcome-unknown`，先用 Workspace / Receipt 对账，再决定恢复。
- 跨插件连续写入非原子事务；必须保留每步真实状态。

## 6. 秘密、日志与诊断

凭据存入受管 Secret Store；普通 Manifest、Task Packet、Memory Pack、诊断 JSON、MCP tool result、Event Journal 不得包含 API Key、Bearer Token、会话 Cookie、设备私钥、用户私有文件正文。诊断白名单与脱敏机制必须继续使用；按最小必要保留审计指纹、状态码、版本号和源引用。

MCP HTTP 授权与本机 Extension 安装审批互相独立；不得向下游服务透传任意上游 Token。外部网络请求采用固定协议、TLS/SSRF 防护、重定向审查和目的主机白名单。

## 7. 设备与原生系统安全

Desktop/Mobile 配对默认只授予 Presence/Manifest；其他远程能力必须逐次授权。Android/iOS 的相机、麦克风、文件、通知使用其本地 Native Capability Provider，设备信任不能自行获得原生权限。

Windows `native-permissions` 不能冒充 OS Sandbox。进程型 Extension Host 也不意味着可以运行恶意 DLL 或 `.node`。Windows Defender RELEASE HOLD 归发布安全门禁，不能通过自检成功直接解除。

## 8. 强制负测试

未知 actor、未授权 Scope、参数偷换、审批重放、插件权限扩大、循环委托、Token 泄漏、跨 Provider Handoff 授权继承、Native 工具输入缺失、签名协议被变更、超时副作用重试、Memory 先取再过滤、撤销后的在途执行，均需拒绝或进入明确安全恢复状态。
