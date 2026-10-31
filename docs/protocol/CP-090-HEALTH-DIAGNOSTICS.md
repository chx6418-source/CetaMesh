# CP-090 — 启动自检、模块健康和反馈协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT + NEW DTO。当前本地已实现启动诊断与执行门禁：`src/product/startup-diagnostics.js`、`src/app/bootstrap.js`、原生 Shell 及 UI 诊断视图。本文的统一投影与 Check Descriptor 仍为提案，不是实际 IPC 报告格式。**

## 1. 目标

启动时验证关键 Core 通信和必要数据/权限完整性。**核心异常阻止进入正常工作模式；可选模块离线时允许降级并禁用相应功能**。独立诊断 Shell 必须在 Core 故障时仍能展示原因、导出报告和访问反馈链接。

## 2. 检查级别

- `PASS`：关键服务实际握手/契约可用，可以进入普通界面。
- `DEGRADED`：可选 Model Provider、MCP、外部 Agent、QQ/OneBot、插件、网络或非关键功能异常；主程序正常启动，受影响功能显示 `unavailable` 和具体原因。
- `BLOCKED`：Core 无法启动或 IPC 协议不兼容；关键存储损坏且无法保证安全恢复；Capability/Permission 基础能力损坏，继续执行有越权风险；Native Shell 对核心资源完整性验证失败。
- `NOT_RUN`：不满足检测条件、主动跳过或环境不支持，不能冒充 PASS。`TIMEOUT` 是检测错误原因，不直接推断未执行副作用。

## 3. Check Descriptor 与报告投影（提案）

当前实现使用 `id/stage/critical/timeoutMs/run(signal)` 的内部检查描述与有限白名单报告。下列 `criticality/execute` 和简化报告只是目标投影；不得用草案 Schema 校验或覆盖现有持久诊断报告。实际契约见 `src/product/startup-diagnostics.js` 与 `scripts/test-startup-diagnostics*.mjs`。

每个 Check 声明 `checkId`, `category`, `criticality:core|optional`, `timeoutMs`, `requires[]`, `sideEffect:read-only`, `execute()`，以及稳定 `code/recoveryHint`。关键检查必须由可信模块实现，不能让未经审查的插件自报 READY 直接替代 Core 检查。

```json
{
  "schemaVersion":1,"runId":"health_01","startedAt":"2026-10-31T13:00:00.000Z",
  "overall":"DEGRADED","checks":[
    {"id":"core.ipc.handshake","status":"PASS","criticality":"core","code":null},
    {"id":"channel.onebot","status":"DEGRADED","criticality":"optional","code":"CHANNEL_NOT_CONNECTED"}
  ]
}
```

示例数据是 Schema 设计示范，不是当前电脑的真实检查结果。

## 4. 检测顺序

1. Shell 环境与安装版本/配置完整性；2. Core 进程/IPC 真实 `core.ping`；3. 可信权限与 StateDir 数据一致性；4. Task/Workspace/Memory/Event Journal 基础读操作；5. Extension Runtime/Plugin Center；6. 可选 Agent/Model/Channel 与 Device 探测。依赖失败的后续检查标记 `NOT_RUN`，不得等待无限超时。

不可自动发送外部 QQ 消息、调用付费模型、安装/卸载工具、修改文件或创建 VM 来完成启动自检。

## 5. 报告与反馈

沿用 `src/product/diagnostics.js` 的字段白名单/脱敏策略；报告本机保存并可导出摘要与 JSON，默认不自动上报。字段只包含版本、Build ID、平台、每项检查 code、Duration、错误码、可见的修复建议与脱敏引用；不含 Key、Token、Memory/聊天正文、路径或私人配置。

复用 `src/product/feedback-links.js` 与 `release-config.json` 的官方 HTTPS 反馈入口。正常 UI 及诊断失败 Shell 可打开系统默认浏览器；配置缺失时真实展示“未配置”。本地报告只能由用户主动复制/附加。

## 6. 运行中健康

轻量监测 Core 连接、IPC、插件子进程、Agent 当前可用性和 Task 状态，复用现有生命周期及事件机制。针对失败服务做有界恢复，避免“插件离线导致整个软件重启”与重启风暴。

## 7. 验收

Core 未启动/协议版本错、存储损坏、权限服务缺失、可选 QQ 离线、MCP 离线、健康检查超时、降级禁用、重检恢复、Core 无法启动时导出报告、脱敏、安全反馈、运行中中断。不可仅凭自动化 Mock 或普通 npm test 宣称原生安装版已通过。
