# CP-020 — 插件/Extension Manifest、生命周期与宿主协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT；当前实际合同为 `src/extension/manifest.js` 的 `manifestVersion:1`，不是本提案创造的新 v2。**

## 1. 设计原则

Plugin Center 是展示、安装和审批界面；唯一执行引擎是现有 Extension Runtime，不允许另外建立一套 Plugin Runtime。插件能够声明功能，但一切受保护操作都经过 Capability Broker。

## 2. Manifest v1（现有约束）

- 入口：`extension.json`，兼容 legacy `manifest.json`；`manifestVersion:1`；稳定小写 ID；插件 SemVer；类型；包内相对 `entry`。
- 支持类型（以 `src/extension/types.js` 为准）：`tool`, `external-api`, `workflow`, `memory-pack`, `channel-adapter`, `agent-adapter`, `ui`。`ui` 当前仅接口，不意味着已经实现完整 UI 插件沙箱。
- `capabilities[]` 声明 `id`, `kind`, `title`, `description`, `requires[]`, `inputSchema?`。Input schema 只是第一层验证，handler 还需对输入和授权重新校验。
- 权限集与风控以 **Extension 的** `src/extension/types.js` 为准，而不是把 Capability Broker 的宽泛权限目录直接视为可供第三方申请。普通 Extension 明确禁止 `shell`, `native`, `download`, `process`。
- `network.hosts` 是 network 权限前提；`scope.paths` 是 filesystem 范围前提；声明不是授予。
- `minCetaMeshVersion/maxCetaMeshVersion` 为已有兼容字段；**插件 SemVer 与 Manifest schemaVersion 是两类不同的版本**。
- 包发布者名称/元数据不构成密码学签名。目前不能宣称发行身份签名体系已完成。

### 与旧包兼容的 Manifest 示例

```json
{
  "manifestVersion":1,"id":"cetamesh.demo-tool","name":"Demo Tool","version":"1.0.0",
  "type":"tool","entry":"index.js","capabilities":[{
    "id":"demo.echo","kind":"tool","title":"Echo","description":"Echo a string",
    "requires":[],"inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}
  }],"permissions":["log"],"network":{"hosts":[]},"scope":{"workspace":null,"paths":[]}
}
```

该示例仅为新文档示意，仍须使用项目 `plugin:validate` 验证真实 Manifest。

## 3. Host 生命周期

`staged → reviewed → installed(disabled) → enabled → disabled / disabled_due_to_crash → update/rollback/uninstall`。

- 本地插件需要 Developer Mode 和首次启用独立 Owner Review。
- 安装默认为禁用；启用前验证包身份/版本/Hash、权限授予与内容签名/来源能力（如有）。更新时权限扩大必须再次审批。
- 禁用、更新、崩溃或包指纹变化应撤销可调用能力，停止相关 Worker，并让在途动作按已有恢复策略结算。
- 卸载不得静默删除属于用户的 Memory、文件或历史成果。

## 4. 现有 Worker 传输保持不变

Process Host 使用当前 `v:1` JSON 行帧：`invoke/result/error/cancel/ping/pong/shutdown`；线上限制与超时来自 `src/extension/process-transport.js`、`process-host.js`。这是**已有数据帧协议**，不能因为 CP-001 引入新的领域信封就改变 `v:1`。

进程隔离可缓解故障，但**不是 Windows Sandbox/AppContainer 等完整 OS 安全边界**；不允许运行未经验证的任意原生代码。任何宿主特权仍须走 Core 授权接口。

## 5. MCP 插件桥接

MCP 工具目录属于外部工具协议适配层，必须固定 MCP 版本并将 `tools/list` / tool call 转换为 CetaMesh 受控 Capability。工具自身声明、MCP OAuth、外部登录、Plugin 安装信任、CetaMesh Owner 审批互不替代；远端 MCP 返回的工具 Schema 属不可信元数据，需要审查并限制。

## 6. 未来兼容演进

本次**不要**因为想新增依赖、插件协作或 Memory Provider，就直接把 v1 的可选字段改成必须。若当前 Manifest v1 容纳不了新能力：先正式发布 v2 提案、定义双版本解析/兼容矩阵/迁移脚本/负测试，再启用。避免修改历史 `extension.json` 导致旧插件失效。

## 7. 契约测试

Manifest v1 正常包/缺字段/未知权限/目录穿越/权限扩大、重复 capability、运行身份绑定、超时和取消、崩溃撤销、离线场景、包升级/回滚、子进程恶意输出、无审核拒绝安装、UI 中权限来源可见。


## 8. 分类与组合边界（v1.1 补充）

17 类产品类型见 [CP-022](CP-022-PLUGIN-TAXONOMY-17.md)；不新增到 Manifest v1 的 `type` 枚举。多层子插件打包/安装与依赖见 [CP-023](CP-023-NESTED-PLUGINS.md)，须独立 Sidecar/ADR 审批；现有单插件装配保持不变。
