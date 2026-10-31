# CP-025 — 17 类插件开发标准、SDK 与交付验收规范

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED；代码示例表示规划中接口，不是当前 Extension v1 现成 SDK。**

## 1. 制作插件前的类型与宿主选择

开发者应先选择 `primaryCategory` 与 `categories[]`，再选择**可证明适合的 Host**：

| Host 类型 | 推荐类别 | 禁止越界 |
|---|---|---|
| Data Pack | Skill、Identity、Knowledge、Data Memory Pack | 不执行代码、不调用宿主任意工具、不把文本当系统指令 |
| Extension Process | Tool、Workflow、Connector、受控 API | 当前 `shell/native/process/download` 仍禁止，不是 OS 沙箱 |
| Managed App / Service Host | App、Service、复杂 Connector | 必须独立安全评审、生命周期、资源限制；目前是设计目标 |
| Isolated System / Device Host | OS、Device、隔离环境 | 特权限于独立 Host + 用户授权，不转嫁到普通插件 |

一个插件可多类别；Host 不能因增加类别标签自动获得能力。根插件和每个 Embedded 子插件都按相同规则选择 Host。

## 2. 开发工程结构（建议）

```
cetamesh-example/
  extension.json             # 当前真实安装入口：Manifest v1
  index.js                   # 当前 Runtime 支持的实现入口（受运行时限制）
  composition.json           # 可选、仅提案；旧安装器不读取/不自动装配
  categories.json            # 产品分类侧车（仅描述元数据）
  components/parser/...      # 未来嵌套包，子插件自身有 extension.json
  contracts/input/*.json
  contracts/output/*.json
  test/fixture/*.json
  README.md                  # 用途、权限、限制与故障处理
  CHANGELOG.md
  LICENSE
```

不在 `extension.json` v1 中直接新增 `categories/dependencies/subplugins` 必填字段；先按既有插件验证器与新侧车验证器分别检查，待 Manifest v2 ADR 批准再统一。

## 3. Descriptor 规范

插件每项 capability 必须声明：稳定 ID、版本、标题、输入与输出 Schema、风险/效果类别、最小权限、最大输入输出大小、平台和 Host 要求、健康状态、取消语义、可重试性、审计字段；其中当前 v1 Manifest 不支持的字段放协议侧车，不可伪装为已执行校验。

输入 Schema 必须 `additionalProperties:false`（新协议推荐）；任何自由文本、文档或模型响应一律不可信，重复检查路径、URL、资源归属、大小和 Scope。输出验证失败返回稳定错误，不能返还未经脱敏的底层错误。

### 既有 Extension v1 基础示例（现实可验证形状）

```json
{
  "manifestVersion":1,
  "id":"cetamesh.example-tool",
  "name":"Example Tool",
  "version":"1.0.0",
  "type":"tool",
  "entry":"index.js",
  "permissions":["log"],
  "capabilities":[{"id":"echo","kind":"tool","title":"Echo","description":"Return a string","requires":[],"inputSchema":{"type":"object","properties":{"value":{"type":"string","maxLength":100}},"required":["value"],"additionalProperties":false}}],
  "network":{"hosts":[]},"scope":{"workspace":null,"paths":[]}
}
```

## 4. 权限与执行约束

- 用户安装授权、Task Workspace 授权、插件授予和对外接收方/用途授权彼此独立；Manifest 权限声明只是请求，不是允许。
- 编排插件可调用其他插件，但必须经现有 `extension.invoke + delegates[]`，遵守 8 hops、委托精确目标、所有祖先有效、权限交集、未知效果恢复。
- 不允许插件读取其他插件私有配置/存储/Memory；跨插件分享必须通过 Core 颁发的有界 Ref 与审批。
- 所有异步执行必须支持超时、取消和真实状态；业务层不得把取消解释成未发生副作用。
- 插件开发阶段不得调试时绕过 Broker；需要完整宿主特权的 App/OS 必须等待独立 Host 协议批准。

## 5. 17 类最低验收维度

| 分类 | 正向场景 | 必测安全/失败场景 |
|---|---|---|
| Agent Tool | 文件、检索、代码、数据单项能力 产生真实受控输出 | 越界文件访问、伪造完成 |
| Agent Skill | 可复用提示、技能方法、步骤模板 产生真实受控输出 | 技能文本越权指令、版本漂移 |
| Agent Memory | 角色/插件/任务的私有与受控共享记忆 产生真实受控输出 | 跨 Scope 探测、私有记忆外传 |
| Agent Knowledge | 文档索引、结构化资料、RAG 引用 产生真实受控输出 | 引用伪造、隐私索引泄漏 |
| Agent Workflow | 多工具/Agent 编排、条件分支和重试 产生真实受控输出 | 重复提交、循环工作流、重试外部写入 |
| Agent Service | 常驻服务、队列消费者、API 与后台作业 产生真实受控输出 | 无界任务/无限重启、异常资源耗尽 |
| Agent Connector | MCP/ACP/OneBot、IDE、平台、外部 Agent 产生真实受控输出 | SSRF、凭据越界、冒充授权 Actor |
| Agent Model | 模型 Provider 与本地推理桥接 产生真实受控输出 | 模型调用失败虚报成功、隐式收费 |
| Agent Device | 手机、树莓派、摄像头、外部设备 产生真实受控输出 | 配对后直接控制设备、跨设备记忆泄漏 |
| Agent Automation | 定时、事件触发、受控桌面操作 产生真实受控输出 | 重复触发、无人值守高风险动作 |
| Agent Team | 角色分工、任务协作、交接和验收 产生真实受控输出 | Agent 交接丢进度、伪造子任务完成 |
| Agent Identity | 角色人格、角色卡、认证资料和行为偏好 产生真实受控输出 | 人格卡注入系统权限、角色资产迁移损失 |
| Agent UI | 面板、可视化、受控交互 产生真实受控输出 | XSS、WebView 注入、伪装审批 UI |
| Agent Guard | 风控扫描、内容策略建议、质量检查 产生真实受控输出 | Guard 输出 allow 绕过 Core 拒绝、死锁 |
| Agent Inspector | 事件轨迹、健康、资源、失败回放 产生真实受控输出 | 未经授权导出日志、跨 Task 观测 |
| Agent App | Agent 专用浏览器、代码、Office、Data Lab 产生真实受控输出 | 在普通 Extension 中开启任意进程/原生权限 |
| Agent OS | Linux/WinPE VM、远程设备与 Agent 专用系统 产生真实受控输出 | 把普通插件权限升级为任意 Host 操作 |


## 6. 开发工具与命令

- 使用仓库现有示例 `extensions/cetamesh-hello-tool` / `extensions/cetamesh-http-meta`，配套 `docs/plugin-development/` 文档；兼容校验以仓库真实脚本为准：`npm run plugin:validate -- <plugin-directory>`。
- 当前草案只读验证：`npm run contracts:validate -- plugin-composition path/to/composition.json`；只检查 DTO/图，不检查包内容、不安装、不授权。
- 新协议运行时实现后增加 `plugin:validate-composition`（**规划命令，不是现有 npm script**）：解析 sidecar、锁、子包、权限差异、循环/上限和 Schema。
- 新增小型合成 Fixture：只读插件、事件插件、组合 A→B→C、版本升级、权限收缩、子插件崩溃及未知副作用。
- 合约测试注册在根 `scripts/run-all-tests.mjs`；Mobile Host 能力独立测试，不因 Desktop 通过而宣称 iOS/Android 已交付。
- SDK 最少提供：类型定义、稳定错误码、Manifest/schema 校验、Mock Broker、Fixture、Trace/审计投影、权限矩阵、运行环境说明和最小示例。不能给出假的 Host API。

## 7. 开发与交付流程

1. 编写目的和分类 → 确认 Host 类型及风险。
2. 定义能力、输入输出、效果分类与数据接收方。
3. 声明最小权限、Scope 和精确 Delegate。
4. 编写 Manifest v1 与可选规划侧车；打包校验与依赖 DAG 预演。
5. 使用合成 Mock 环境完成 schema、失权、禁用、超时、取消和重放测试。
6. 真正启用仅在 Owner 审核后；App/OS 的隔离和设备权限必须实机验证。
7. 正式打包前记录版本锁、SHA-256、可回滚版本、许可证及第三方依赖。
8. 用户可查看插件做了什么、读取什么数据、发送到何处、耗费多少资源；不得暗自安装依赖或外传。

## 8. 文档与兼容

每个插件必须有开发者说明、能力清单、权限/数据流、兼容版本、示例请求响应、错误码、版本迁移、回滚和卸载时的数据保留说明；任何权限扩大、数据出口变化、重大副作用变化需显式审批与新 ADR。

## 9. 可交付定义

目录可读、安装和配置流程明确；能力有 Schema 与实测证据；拒绝授权后不会继续执行；外部未验证时如实报告 `BLOCKED_ENV/NOT_RUN_ENVIRONMENT`，不把模拟成功当真机成功。
