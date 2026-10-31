# CP-023 — 递归组合插件（插件里的插件）正式提案

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED / 尚非当前 Extension Runtime 的打包与安装能力。** 当前已实现的是 `extension.invoke` 及受控调用链，不能把它误报为已支持任意嵌套安装。

## 1. 明确三种不同的“嵌套”

| 类型 | 示例 | 关键区别 | 当前实现状态 |
|---|---|---|---|
| **Package Nesting** 物理包嵌套 | A 包内含 B 包，B 包内含 C 包 | 独立插件 ID、版本、包签名/哈希和生命周期；需原子安装计划 | **NEW**；旧 Manifest v1 无此打包规则 |
| **Composition Graph** 逻辑依赖 | A 必需 B，B 可选 C | DAG 可共享外部依赖；版本锁、兼容、禁用传播；不必物理复制 | **NEW**，现有独立插件装配不可假定已支持 |
| **Runtime Delegation** 运行时委托 | A→B→C 使用某个 capability | 经过 Broker 的受控调用；与包装层级无关 | **PARTIAL**：Manifest v1 的 `delegates`/`extension.invoke`、8-hop 限制已实现 |

三者可以共同出现，也可以单独出现。**插件 A 的源码 import B 的模块，绝不等同于 B 是一个获得独立授权的子插件。**

## 2. 嵌套架构与身份

```text
Composite ROOT: cetamesh.dev-studio@1.0.0
  ├─ parser       : cetamesh.parser@1.0.0   (embedded / required)
  │    └─ ocr     : cetamesh.ocr@1.0.0      (embedded / optional)
  │         └─ lang: cetamesh.lang@1.0.0    (embedded / optional)
  └─ git-provider : cetamesh.git@1.2.0      (external / required)

UI: 一个「开发套件」产品
Core: 独立 Component 实例、独立 Host/私有存储、独立授权及审计；共享能力通过 Broker
```

- 公开分发身份使用 **Publisher-Scoped 稳定 `pluginId`**；当前合法 ID 文法以 `src/extension/types.js` 为准。禁止用 `../`、用户任意路径、大小写别名当作插件身份。
- **ComponentKey**（如 `ocr`）只是在组合根内部稳定定位，不能代替全局插件 ID；**InstancePath** `root/parser/ocr` 由 Core 构造，用户不能冒充 Core 赋予其他根的身份。
- 每个 Component 必须记录：`pluginId`、精确 `version`、内容 SHA-256、HostKind、归属根、直属父亲、实例路径、启用状态、实际 grants、持久状态所有者和引用计数。身份与版本不得仅凭显示名称推导。
- 共享外部依赖可以被多个根引用，但必须按每条消费关系单独授权；禁用一个根仅吊销其引用，不得卸载别人的共享插件或删除别人的数据。
- 嵌入插件具有独立数据隔离与授权视图；如果 Host 共享进程，必须能证明不弱于独立 Host 的安全边界，否则只能共享无执行权限的 Data Pack，不能合并可执行插件进程。

## 3. 初始安全限制（本提案默认值，不代表当前源码已实现）

| 限制项 | 提案值 | 理由 |
|---|---:|---|
| 包含根在内的 Package Nesting 层数 | 5 层（ROOT + 最多 4 级子项） | 支持 A→B→C→D，但避免极深安装图 |
| 单个组合中的 Component 数 | 32 | 安装、审计、迁移与资源可界定 |
| 单个 Component 的直接子项 | 8 | 避免爆炸式扇出 |
| 跨插件 Runtime Invoke 链 | **沿用现有 8 hops** | 不能把打包深度当调用深度；保留旧授权约束 |
| 单次协作并发 | 草案默认 8，可按用户/Task 更低配额 | 防止多级 fan-out 失控 |
| 委托目标 | 沿用 Manifest v1 每插件最多 20 个 `delegates` | 不将组合图隐式当成授权委托名单 |
| 图结构 | 无循环；无自依赖；无多父 Embedded 子项 | 明确生命周期和身份归属 |

未来需加深层级时，必须升级协议版本/测试上限并核算资源，不允许靠递归配置文件绕过限制。

## 4. 独立 Composition v1 侧车（避免破坏 Manifest v1）

新文件名建议 `composition.json`，与原 `extension.json` 同级；**现有 v1 安装器不应因为文件存在就自动解析、安装或授权子插件。** 只有未来显式启用 Composition Host，先验证侧车、锁定依赖、计算审批差异后才装配。

```json
{
  "compositionVersion": 1,
  "rootPlugin": "cetamesh.dev-studio",
  "rootVersion": "1.0.0",
  "components": [
    {"key":"parser", "parent":"root", "pluginId":"cetamesh.parser",
     "version":"1.0.0","mode":"embedded","packagePath":"components/parser",
     "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","required":true},
    {"key":"ocr", "parent":"parser", "pluginId":"cetamesh.ocr",
     "version":"1.0.0","mode":"embedded","packagePath":"components/parser/components/ocr",
     "sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","required":false},
    {"key":"git", "parent":"root", "pluginId":"cetamesh.git",
     "version":"1.2.0","mode":"external","required":true}
  ],
  "bindings": [
    {"from":"root", "to":"parser",
     "targetCapability":"extension.cetamesh.parser.document.parse","dataClass":"internal",
     "purpose":"Parse reviewed documents in the authorized task"}
  ]
}
```

`compositionVersion` 属于新的 **Composition sidecar**，不是 Extension Manifest `manifestVersion`、Worker frame `v` 或产品 SemVer。

组合侧车不得包含可执行 JS、Token、用户私有数据、权限 Grant、批准指纹或 `actor` 字段；内嵌子包的完整 Manifest/内容仍须独立验证和审阅。`sha256` 锁定内容而不证明发布者身份。公钥签名在未来 Plugin Service 正式落地前不得宣称已验证。

## 5. 安装与依赖解析（无隐式授权）

1. **只读解析**：校验 root manifest/sidecar、分类标签、每个 Component package、版本区间/锁、路径归属和 Hash；禁止 URL 递归安装、跨目录符号链接和路径穿越。
2. **构建有向无环图（DAG）**：每个 `parent` 存在且不能循环；运行时 `delegates` 关系另作 DAG/循环检查，防止隐藏在外部依赖中的跨包环。
3. **生成安装计划**：列出新增/更新/沿用/可选缺失的每个包、所有权限差异、Host、网络/设备/文件范围、数据出口；**用户明确审批整个计划**。审批不自动授予每个子插件全部权限。
4. **阶段安装**：先把包在受管隔离目录中检验，安装默认 disabled；只有实际安装、用户批准、策略和依赖满足时逐个启用。
5. **激活交易**：验证完所有必需 Component 才切换根的可用版本；写入锁文件/依赖图记录、版本和审计；失败回滚到原状态，不覆盖旧版本数据。
6. **无默认市场递归下载**：外部依赖缺失时显示来源及风险；只有用户批准明确来源和包摘要后才能从可配置可信仓库下载，不能安装附带的恶意隐式依赖。

如果可选项缺失，仅依赖该 Component 的公开能力 `UNAVAILABLE`；如果必需项缺失，组合根 `DEGRADED/NOT_READY`，**不应让整个 CetaMesh Core 启动失败**。

## 6. 生命周期与状态

- 根 `disable` ⇒ 立即撤销根生成的所有能力路由/事件订阅/新 Task 委托；独占 Embedded 子插件有效态随根失效，独立外部依赖保持运行供其他消费者使用。
- 子插件 `disable/crash/update` ⇒ 向父上报可读健康状态并撤销过期 Capability；父的无关功能可继续运行，依赖功能返回稳定错误。
- `effectiveReady` 由每节点自有 enabled/installed、所有父边界、必需依赖健康、绑定指纹/Grants 和 Broker 决策共同决定，不得仅依据 UI 显示开关。
- 运行中升级通过影子版本/版本锁和受控切换，正在执行的写操作保留原 Operation Identity；旧 Host 不得被新版本静默接管。
- 停止/取消沿链传播，但已发生副作用不可自动“撤回”；`outcome-unknown` 必须对账。
- 父包卸载时列出受影响子插件和数据：独占 Embedded 可以停用但数据保留待用户决策；共享外部依赖只移除引用，不删包、不删数据。

## 7. 权限公式与数据流

对 A→B→C：

```text
EffectiveScope(C) = Owner/Task grant
                    ∩ A actual grant
                    ∩ B actual grant
                    ∩ C actual grant
                    ∩ all ancestors' constrained scopes
                    ∩ local Core policy
```

- 每跳重新核验精确 `delegates[]`、包身份/版本/描述符哈希、Scope、Workspace、工具效果、风险和审批；**组合父子关系本身不授予权限**。
- B 拥有本地文件读取许可，不代表 A 可以读取 B 的私有数据；即使能通过 B 获取文件摘要，也不代表 B 有权发给 C 或外部模型。
- 文件/Memory/附件的跨插件引用优先使用 Core 管理的 **有界引用句柄**，带接收方、目的、TTL、Scope 和撤销指纹；拒绝把本地绝对路径、凭据或原始数据库连接直接传给子插件。
- Data Pack / Skill 文本永远是不可信参考；不论嵌套多少层，不能覆盖系统权限/开发安全规则。
- 向外部域、远程模型、云端设备转发原始数据，需要明确 `recipient + purpose + dataClass + transfer scope`，不得从 A 的 `filesystem.read` 推导出任意 B 的网络外发权。

## 8. 循环、超时、背压与幂等

- 组包依赖图和运行时委托调用链都做循环检测：出现 A→B→A 时拒绝并输出完整（脱敏）链路。自调用或互调用经过显式 Loop Guard，不能只靠深度 8 截停。
- 预算在根 Task 由 Core 下发：最大调用 hops、并发、Token/Cost（涉及模型）、总时长和可用效果类别；每跳只能减少，不能加大预算。
- read-only 调用可在限定次数内安全重试；`non-idempotent/unknown` 写调用在超时/断开后必须 `outcome-unknown` 并进入 Reconciliation，不自动换一个子插件重放。
- 每层记录 `traceId`, `parentSpanId`, `operationId`, `instancePath`, `pluginId`, `capability`, `descriptorVersion`, 授权决策、耗时、结果/回执引用；禁止日志保留原始密钥/未批准的私有数据。

## 9. 兼容性与回滚

- 当前 `extension.json` v1 与 Worker v1 继续按旧方式运行；无 `composition.json` 的旧包原样安装与调用。不要把组合子包语法硬塞进已有 `delegates`。
- 正式引入 Composer 时按 `Off → ReadOnlyInspect → PreviewPlan → ControlledEnable → Stable` 渐进启用，必须保留 Feature Flag 和 Rollback。
- 组合版本锁应记录确切根包、子包哈希、权限指纹、兼容范围和用户审查版本；已发布兼容包不能在用户不知情时被后台替换。
- 组件安装失败、权限失效或策略版本变化时，保持最后已知正确版本，显示清晰恢复原因。

## 10. 测试矩阵（必须负例优先）

- 嵌套 A→B→C 正常只读、A→B→C→D 正常；级数超过上限拒绝；Component 超限拒绝。
- 缺失父亲、循环父子、自依赖、多父 Embedded、路径穿越、重名 key、损坏 SHA-256、篡改子 Manifest、软链接逃逸拒绝。
- A→B 与 B→C 委托必须分别授权，父授权不下发给孙；B 未获准外发时禁用网络传输。
- 共享依赖被根 A 停用时根 D 继续可用；独占内嵌停止不删除私有状态。
- 子插件崩溃/重启/升级/卸载/权限缩减时，新调用 fail-closed；在途非幂等操作结果未知时进入对账。
- 版本锁漂移、异步安装竞态、重复安装请求、审批过期、撤销后一跳继续调用、跨 Workspace/Task、Data Pack 注入不得通过。
- 插件内容 hash 归属与来源、锁文件写入失败回滚、断网/离线、未认证远程仓库、Mobile 不支持的 Host 提示缺失能力，而不是成功。

**最终定义：递归嵌套是受控依赖/身份/安装/协作图，不是让一个 JS 进程无限 `require` 另一个插件，也不是无限递归提升权限。**
