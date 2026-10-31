# CP-070 — Device Mesh、配对、信任与跨设备能力协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：EXISTING + ALIGNMENT；本文件不是 `docs/protocol/UNIFIED_PAIRING_V1_1.md` 的替代品。**

## 1. 现有权威配对规范

Desktop ↔ Mobile 使用 `UNIFIED_PAIRING_V1_1.md` 定义的签名邀请、Nonce、证书 pinning 和显式 Trust。其线缆上的 `protocol:"cetamesh", version:1` 不得为了与 CP-001 一致而改名/升级。原有 Golden Fixtures 必须逐字节保留。

现有 `src/mesh/protocol.js` 还存在旧内部 `v/ts/sig` envelope；这是需要梳理的**不同历史实现/契约**，不代表它与配对 v1.1 可以盲目互换。重构前需列出实际调用链、签名生成与验证者、历史数据和双端版本。

## 2. Trust 与授权分离

- Pairing 完成 ≠ Memory/Chat/Task/文件/摄像头/麦克风授权。
- 配对后默认 `mesh.presence` 与 `mesh.manifest`（按现有 v1.1 协议）进行低风险状态/能力发现。
- `mesh.capability.request` 经结构、身份签名、重放、对端 Trust、能力可用性、本地 Scope/Policy、必要 Owner Approval 后才可执行。
- 远程节点的 capability manifest 只是声明，用户仍需本地显式授权；未知权限默认拒绝。

## 3. Desktop/Mobile 独立边界

Mobile 是独立 Node，Native 权限由 Kotlin/Swift Provider 实现。Desktop 的 Workspace、Git 和 Native Agent 策略不能通过设备信任传播到手机。默认 Memory Local Only；同步需要用户选择数据类型/Scope/设备方向/时限和撤销方式。

## 4. 签名、重放、回收

受签名保护的 payload hash、canonical string、时间偏差、nonce/cache、TLS pin 是协议不可变部分。丢失证书身份、签名错误、重放、过期、收件人不符应 fail closed。撤销 Trust 必须移除活跃 grants 和未完成授权租约；不自动删除已在另一节点存储的用户数据，应提供清晰的影响提示。

## 5. 可扩展适配

未来 Relay、互联网互联或云服务都必须通过单独协议版本/网关适配设计；不把在 LAN 成功的 Peer Trust 当成公网安全前提。`packages/` 的共享类型只能存放稳定协议定义与测试 Fixture，不允许把 Desktop Runtime 和 RN Native 依赖混入。

## 6. 测试

现有 pairing golden vectors、签名负例、token 复用、TLS pin 不匹配、版本不兼容、信任撤销、只读能力清单、未授权能力默认拒绝、移动端 Local Only、真实双设备验证（缺少环境时 `NOT_RUN_ENVIRONMENT`）。
