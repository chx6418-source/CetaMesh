# WhaleBridge M2：Core 启动反向依赖解除

状态：**RELEASE_BLOCKED**。本报告记录本地 `codex/whalebridge-decoupling-m2` 的实现与验证；不表示 Stable 放行，也不授权 M3～M6、数据迁移、推送或合并。

## 基线与边界

- 起点：`a715111b1ba71460dfaedc9a9f4652f4e03b3e39`，继承 M0/M1、六阶段及 AUD-001/002/003 的本地修复；工作目录为 `D:\GIT- CetaMesh\audit-critical-repair`，与 `D:\GIT-QQ-BRIDGE` 的其他会话工作树隔离。
- 本地分支：`codex/whalebridge-decoupling-m2`。产品 Build Number：`1071 → 1072`。
- 真实 StateDir、DSH 用户 preset、QQ/Bionic 数据库均未迁移或清空；测试使用临时数据目录。

## 新的启动调用链

`desktop-shell/src/core_launch.rs` 仍传入 `--worker` → `src/core-entry.js` / SEA `src/core-sea.js` → `src/core-dispatch.js` → `src/app/core-worker.js` → `bootstrapCetaMesh()` → `createCetaMeshServices()` → `.core-owner.lock` → `createDesktopIpcRuntime()` 与 `startDataIpcServer()`。Rust Supervisor 注入的 UI pipe 和 64 位十六进制认证令牌沿用原协议。Core 自己持有服务、两个 pipe 和生命周期；在 Shell stdin EOF、SIGINT、SIGTERM 时关闭自身资源并释放所有权锁。

`src/core-dispatch.js` 不再导入或调用 `runBridge()`。`--worker` 不读取 QQ/Social 运行态，不启动 QQ WebSocket、SnowLuma 或旧 HTTP Console；损坏的可选旧 `config.json` 不会被 Core 覆盖。DSH 未安装或未认证时仍可构造普通 Core 服务；真实模型推理未配置 Key，本轮不标为真实推理通过。

## 兼容与权限

- `node src/bridge.js` 保留显式 Legacy 入口、旧 QQ/Social 运行流程及开发环境显式启用的旧 HTTP API。MCP 五种 CLI 模式仍由统一 Core 可执行文件提供，SEA 测试完成 initialize/listTools/callTool。
- 纯 Core 数据 pipe 只接受 `data.call`，服务令牌仅可查询 `/api/status`；旧 QQ 路由和带 Legacy 会话令牌的调用被拒绝。数据 pipe 不能调用 Owner/control 方法。纯 Core 未创建旧 `console-token`，状态自描述为 `service-only`。Harbor `ui.*` 方法仍走原生 Owner IPC，未引入第二个 IPC Server。
- 未知的旧控制方法在纯 Core 返回稳定的 `METHOD_NOT_FOUND`。Rust Shell 的 smoke 检查已改为验证 Chat、Task、Memory、Workspace、Settings、Agent 与 UI 事件方法，不再把 QQ policy 写入当作 Core 就绪条件。
- 独立 `.core-owner.lock` 拒绝第二个 Core 对同一 StateDir 写入；冲突退出码为 2，Supervisor 不会无限重启。Legacy Bridge 的 `bridge.lock` 不由纯 Core 创建。

## Workspace 清单保护

`src/workspace/registry.js` 只在文件确实不存在（`ENOENT`）时创建空清单。已存在而损坏或不可读的清单抛 `REGISTRY_CORRUPT`，保留原文件字节，不写入默认空状态。该错误状态优先保护用户清单；人工恢复/只读浏览 UX 尚未实现。

## 进程与数据完整性证据

- 生产 Worker：隔离路径中无系统 QQ/DSH/SnowLuma；损坏旧配置原字节保留；无旧 `bridge.lock`、无旧 HTTP 监听。双 Core 启动时第二个退出 2，首个数据 pipe 保持可用。Rust Shell smoke 通过原生认证 IPC 读 Chat/Task/Memory/Workspace/Settings/Agent 与事件，并验证重启与 stdin EOF 后进程/锁释放。SEA suite 在无系统 Node PATH 下检查后代进程，不见第二个 Node Core。未接真实 QQ 网关，因此 QQ 消费者并发的真实 E2E 仍未验证。
- Task/Memory：`test-whalebridge-core-isolation` 使用真实 `createCetaMeshServices()` 在无 DSH、损坏可选插件状态下创建并读取 Task/Memory/Workspace；`test-task-runtime` 与 `test-phase4-memory` 分别验证相同 StateDir 上 Runtime 重建后 ID 和内容保留。**这些是隔离 fixture 与服务层重建证据**；本轮没有对真实用户 StateDir 做进程级 Task/Memory 迁移或读写对账。故真实安装版的跨 Worker 重启数据完整性仍是发布验收项。

## 先复现后修复

| 反例 | 首次复现 | 修复与回归 |
| --- | --- | --- |
| `--worker` 仍创建 `bridge.lock` | `test-core-entry` FAIL | 直接 Core bootstrap 后 PASS；同时检查损坏可选配置仍原样保留 |
| Workspace 损坏清单被吞掉 | `test-workspace-runtime` FAIL | `REGISTRY_CORRUPT`，原始字节未变，PASS |
| 新 Core 对 Shell stdin EOF 不退出 | `test-core-entry` FAIL | Core 生命周期清理与锁释放，PASS |
| 同一 StateDir 第二 Core | 生产路径双进程断言 | 第二进程退出 2，首进程 pipe 仍可用，PASS |

## 验证记录

| 项目 | 结果 | 证据边界 |
| --- | --- | --- |
| `npm test` 全量 109 suite | PASS 101 / FAIL 0 / NOT_RUN_ENVIRONMENT 8 | 最终轮在 Build 1072 重建 SEA 后执行；8 项依赖 Legacy Console、真实网关/网络/Codex、RC 产物或 Cargo 聚合开关；Cargo 已单独执行 |
| `npm run build:core` | PASS | Windows Node SEA 产出并审计 17 个资源文件；最终 EXE SHA256 `CE115D54C73851EC96D72F51BC2C96678E3E305D2BC7A38CF089811B2781CD24` |
| `npm test -- --suite test-core-dist` | PASS（含最终全量轮） | 实际 EXE 在无系统 Node PATH 下经 `/api/status` 完成数据 IPC；覆盖默认、显式、便携数据目录 |
| `npm run build:ui` | PASS | Vite 生产构建，存在非阻断 chunk 体积提示 |
| `npm run desktop:check` | PASS | Rust 编译检查，有原有 unused 警告 |
| `npm run desktop:test` | PASS | 198 passed、0 failed |
| `npm run desktop:build:debug`、`npm run desktop:build` | PASS | 实际 Shell debug/release 构建；Shell smoke 实测 Owner IPC、重启、EOF 清理 |
| `npm run build:release -- --use-current-build-number` | PASS | 干净代码提交 `1bbee5e2db47bfea7e7712115c66dd3b3c5f6b20`，`dirtySourceTree=false`；Build 1072、138 组件、发行禁止项/凭据审计通过 |
| `npm test -- --category release` | PASS 8 / FAIL 0 | 注册的 RC 验证包含真实安装器在中文及空格路径隔离安装、运行、卸载；初轮旧 `dual` 断言失败后已按纯 Core `service-only` 契约更新并复测 |
| 真实 QQ/DSH/模型服务、真实安装版人工 Harbor E2E | NOT_RUN_ENVIRONMENT | 外部组件、Provider Key、正式签名与人工环境未配置；自动化通过不能代替此验收。发行清单还明确列出 Windows 10 x64、DSH/SnowLuma 重启恢复与真实四模式未验证 |

## 尚未解除的依赖与风险

1. **Legacy Bridge 仍是独占的旧模式。** `src/bridge.js` 的显式入口目前仍在自身进程中调用 `bootstrapCetaMesh()`，持有自己的 Core 状态并提供旧控制/data API；它不能与新的纯 Core 对同一 StateDir 同时运行。这不是已完成的 Connector 独立化。现阶段只能在进程完全停止、锁释放后选择旧或新入口；禁止并发双写。把旧 QQ 路由接入单一 Core Owner 需要独立的兼容门面、请求/事件契约和单写者验收，不能用第二个 Bridge/Data pipe 冒充完成。
2. 纯 Core 的旧 `control.execute` QQ/Social 方法与数据面 QQ API 被明确拒绝；Harbor `ui.*` 核心方法已验收，但旧 egui fallback 的完整控制方法未在纯 Core 复刻。切换正式运行时前需要 Owner 确认旧入口选择/回滚策略和方法级兼容范围。
3. `src/core-dispatch.js` 仍静态打包 MCP/DSH CLI 模式代码，以维持单一 SEA 分发。**运行时初始化**已与 Bridge 分离，打包体积和静态依赖尚未完全模块化。M3/M4 再按真实协议拆 Connector，不在此轮移动目录或猜测版本。
4. Workspace 损坏清单会明确报错且不覆盖，但尚缺原生 UI 的只读恢复操作。真实用户数据未试迁移/恢复。
5. Release 和真实环境验收完成前持续 `RELEASE_BLOCKED`；不推送、不合并 main、不发布 Stable。

## 修改与提交

产品：`src/app/core-worker.js`、`src/core-dispatch.js`、`src/app/ipc-runtime.js`、`src/control/data-ipc.js`、`src/entrypoint.js`、`src/workspace/registry.js`、`desktop-shell/src/native_main.rs`。测试：`scripts/test-core-entry.mjs`、`test-core-dist.mjs`、`test-no-web-release.mjs`、`test-workspace-runtime.mjs`、`test-qq-runtime.mjs`、`test-desktop-supervisor.mjs`、`test-desktop-shell.mjs`、`test-release-candidate.mjs`。版本：`release/version.json`。

代码及 RC 来源 Commit：`1bbee5e2db47bfea7e7712115c66dd3b3c5f6b20`（该提交为本轮可执行产物的 **Build HEAD**；报告与 RC 断言修正随后单独提交，交付时 Final HEAD 见 `git rev-parse HEAD`）。

RC Build：`artifacts/rc/1.0.0-rc.2/build-1072`；安装器 `CetaMesh-Setup-1.0.0-rc.2-build1072-x64.exe`，42,995,712 字节，SHA256 `94620906A2053765E2F6B8F634ACC7A556F30DE17FBA99112733CED2CFBA4DA7`。载荷 SEA `payload/WhaleBridgeCore.exe`，SHA256 `CE115D54C73851EC96D72F51BC2C96678E3E305D2BC7A38CF089811B2781CD24`。产物未签名，未发布。

## M3 前置条件

先由 Owner 审查 Legacy 兼容门面及旧/新入口互斥切换的接口和回滚设计，确认旧 QQ/MCP 数据方法如何通过单一 Core Owner 授权、写入与事件订阅。DSH Connector 的版本/认证/Session purpose/preset 能力仍按已验证协议处理，不能覆盖用户 preset 或把未知能力标为 ready。M3 不应以本轮 Core 独立启动测试代替 QQ、DSH 与真实 Harbor E2E。
