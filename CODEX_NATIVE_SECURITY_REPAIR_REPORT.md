# Codex Native Security Repair Report

日期：2026-10-20。最终发布状态：**RELEASE_BLOCKED**。

## 1. 任务与基线

本轮执行 Owner 已确认的新职责方向：CetaMesh 管理协作及平台权限，外部 Agent 管理原生执行安全。没有继续尝试已失败的统一 root-read Windows 沙箱组合，没有启用 WSL、管理员提权或全权限回退。

工作分支：`codex/agent-native-security`。
起点：`89b54f80563a19954e6330abed2b6ece0a550776`，其中已有 WSL 只读预检报告；产品 main 基线为 `7e4caf7387d071c6f9bea00493aeec8719181d13` / Build 1103。
产品修复提交：`cdc0639`（完整 SHA 与最终文档 HEAD 见文末核验记录）。Version 保持 `1.0.0-rc.2`，Build 递增为 **1104**。

## 2. 拒绝链与修改

旧链：Workspace Task → Capability/Task 执行权 → Codex Staging → 强制自定义 root-read deny → Windows 原生沙箱不支持该额外要求 → CODEX_SANDBOX_UNAVAILABLE。该失败不能推出 CLI 未安装、未登录或其官方原生策略完全不可用。

新链：Owner 选择 Native → 服务端真实范围描述 → 现有高风险 Capability Owner 审批 → Broker 绑定 Provider/Task/Workspace/策略 → Codex 官方 workspace-write / Windows unelevated → 原生工具 → JSONL Follow → Task Checkpoint；Staging 成果通过原有 workspace.apply 审批导入。

| 修改位置 | 内容 |
| --- | --- |
| src/agent/execution-security.js | 通用安全描述、范围披露及策略 fingerprint |
| src/agent/broker.js | 创建/发送前范围确认；Task/Session/Workspace 当前执行权；Handoff 普通发送拒绝 |
| src/agent/codex-agent-provider.js | Native/Isolated 分开；官方 Native 参数、原生 rules、配置 fail-closed；原生命令事件；独立 readiness |
| src/agent/service.js、src/app/service-container.js | 现有 Broker 的 Workspace/Task/Continuity 依赖装配 |
| src/capability/service.js | 复用 Owner Approval 的 agent.execution.authorize，agent.run 前置门禁 |
| src/continuity/runtime.js | 目标 Native 确认先于交接副作用，不继承旧 Provider 权限 |
| src/desktop/chat-service.js、platform-runtime.js、ui-service.js | native-staged 兼容与 Owner UI 接口 |
| desktop-ui/src/app/HarborApp.tsx、bridge/typed-client.ts | Chat/重试/继续、Task、Handoff 的真实范围确认 |
| desktop-shell/src/webview_policy.rs | 受限 Owner UI 方法 allowlist |
| scripts/test-new-audit-critical.mjs、test-service-container.mjs、test-agent-native-security.mjs、test-agent-provider-expansion.mjs、test-codex-discovery.mjs、test-phase3-real-codex.mjs、run-all-tests.mjs | 新增及延展契约与真实执行测试，全部登记统一聚合器 |
| release/version.json | Build 1104 |

## 3. 实际原生配置及范围

实际 CLI `codex-cli 0.163.0-alpha.10.2` 已安装、已认证。选定配置 `[windows] sandbox="unelevated"` 仅读取，没有更改用户 config、rules、凭据或 DSH Preset。

Native 参数为 `--sandbox workspace-write`、`-c windows.sandbox="unelevated"`、`--ask-for-approval never`，现有 exec JSONL 与 strict/ignore-user-config 参数保持。Native 不使用 root-read deny，也不忽略用户 execpolicy rules。`never` 表示需要升级权限时拒绝，不是自动批准。没有实现原生交互审批桥。

elevated/mxc 不因安装而自动认可；选中后拒绝。无法可靠识别的 TOML 安全设置拒绝，避免默默换后端。CLI/rules/配置身份变化使旧确认及旧沙箱结果失效。

Native 的工作区外读取仍由原生 Agent/OS 控制。Staging 不等于隔离；CetaMesh 不保证可以截获直接 OS 修改、网络或对当前 OS 用户可读私有文件的访问。平台不注入 Owner Token，私有 IPC 和平台接口鉴权继续生效。

## 4. 复现、定向回归与审查

- RED：新增 Native 参数断言在旧实现失败，记录 `native-security-red.log`；没有修改断言隐藏旧问题。
- GREEN：官方 Native 参数、替代 Agent Adapter、工作区及策略范围、Owner 审批、非 Owner 拒绝、暂停/blocked/cancelled 发送拒绝通过。
- 只读代码审查发现并修复两个问题：Handoff 竞态；非规范 TOML 被默默替换后端。新增拒绝回归后审查确认关闭，没有剩余 Critical/Important 发现。
- `native-review-fixes.log`：4 PASS /0 FAIL（包括 Handoff）。
- `native-health-final.log`：4 PASS /0 FAIL（包括 Native、Provider expansion、发现及静默失败红线）。
- 未删除测试、跳过断言、更新安全基线或降低权限检查。

## 5. 真实验证矩阵

| 场景 | 证据与结论 | 类别 |
| --- | --- | --- |
| Windows 官方 Native 可执行 | 独立合成目录的原生 sandbox canary：stage 可写，合成 outside 可读，outside 写入拒绝，原文件不变 | VERIFIED_REAL_E2E |
| Session 与三轮不同请求 | 同一真实 Codex Session 读取4217、计算4218、失败后恢复4217；保留实际 Task 身份 | VERIFIED_REAL_E2E |
| Streaming / Tool Calling | JSONL assistant/chunk、assistant/message、原生命令开始/结束/失败事件；不是 app-server token 级 Streaming | VERIFIED_REAL_E2E |
| 原生命令失败恢复 | 实际无副作用命令 exit7 后继续读取并给出正确答案 | VERIFIED_REAL_E2E |
| Staging 文件与导入 | 权威文件在批准前不存在；实际 workspace.apply Owner 审批后导入 NATIVE_IMPORT_OK | VERIFIED_REAL_E2E |
| 暂停、恢复、取消 | 停止合成 sleep，正式恢复/核验流程完成，最终 cancelled 且 Workspace 执行权释放 | VERIFIED_REAL_E2E |
| 平台越权与策略隔离 | 非 Owner 确认拒绝、错误 Workspace/旧 fingerprint/旧 Task Session/Handoff 普通发送拒绝 | VERIFIED_FIXTURE |
| 第二种 Agent 原生策略 | test-vendor-native 通过同一 Broker 描述/确认，未修改 Core 分支逻辑 | VERIFIED_FIXTURE |
| Managed Agent /普通模型/Continuity | 既有聚合测试及 Build1104 全量结果见下 | VERIFIED_FIXTURE |
| 真实 Harbor 原生安全确认弹窗与点击流程 | 本轮未操作真实用户应用，没有把程序化 Owner 合成测试称为 UI 点击验收 | NOT_RUN_ENVIRONMENT |
| 可选严格隔离、WSL、elevated/mxc | 当前没有已验证可用执行 Profile，保持拒绝 | NOT_RUN_ENVIRONMENT |

全部真实写入仅发生在独立合成测试工作区及获准导入的合成文件。没有修改用户现有项目、取消用户任务、覆盖安装应用或迁移数据。

SEA 验收脚本首轮误用了单数 `ui.approval.decide`，产品按契约返回 METHOD_NOT_FOUND；脚本改用仓库真实接口 `ui.approvals.decide` 后通过。没有为此添加兼容别名或放宽产品入口。

## 6. 全量测试、发行与追溯

最终聚合回归：**136 PASS / 0 FAIL / 4 NOT_RUN_ENVIRONMENT**。入口 npm test -- --verbose，启用 WHALEBRIDGE_TEST_CARGO=1 和 WHALEBRIDGE_TEST_REAL_CODEX=1。最终验证 HEAD：`27528286aee849837137bcd9771514cc46c5964a`。

分类通过数：runtime 46；security 21；core 25；release 12；integration 15；architecture 11；desktop 5；environment 1。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| npm 完整聚合器 | 136 PASS /0 FAIL /4 NRE | native-final-full.log |
| Rust check / test | PASS；199 passed /0 failed /0 ignored | 1104-rust-check.log /1104-rust-test.log，最终聚合器再运行 |
| Core / UI | PASS | 1104-core.log /1104-ui.log |
| Desktop release/debug | PASS | 1104-desktop.log /1104-debug.log |
| build:release | PASS | 1104-release.log |
| RC 与全部发行分类 | 见最终聚合器 release 分类；全部通过 | native-final-full.log |
| 正式 SEA + 真实 Codex | PASS：批准→读取→检查点→取消→重启；原文件未变；旧确认失效 | 1104-native-sea-results.json /1104-native-sea.log |

早期迭代结果真实保留：native-real-final.log 为132 PASS /2 FAIL /6 NRE（旧 Follow 替身未声明 Native 能力、装配测试仍只接受旧 boundary）；1104-full-test.log 为134 PASS /1 FAIL /5 NRE（装配测试）。两项经过定向修正后由上述最终完整聚合器验证为0 FAIL。没有删除旧断言；装配测试额外断言未确认调度必须拒绝，之后才在已有的调度替身内模拟已批准范围。CLI/审批/原生命令由独立真实 suite 验证。

最终未运行项：

- test-console：缺少环境：legacy-bridge
- test-mcp-exec：缺少环境：gateway
- test-mcp-web-search：缺少环境：network
- test-onebot-connection：缺少环境：gateway

### 发行对应关系

- Version：1.0.0-rc.2；Build：1104。
- 产品与安装包 sourceCommit：`cdc06390a6e7d2f12311cf30fb1779114098be39`。
- 构建时 dirtySourceTree：false。
- 后续回归提交：fd69c1dfae159fab95793943cda2da03cd3a0c9a、27528286aee849837137bcd9771514cc46c5964a，仅修改上述两个测试文件；产品/SEA/Harbor 输入没有变化。没有用后续测试提交冒充安装包 sourceCommit。交付报告另作文档提交。
- 安装包：`D:\GIT- CetaMesh\releases\1.0.0-rc.2\build-1104\CetaMesh-Setup-1.0.0-rc.2-build1104-x64.exe`。
- 大小：43454464 bytes。
- SHA-256：`cdc8292beda043fb754eca3d6e9fdf0cb2dad990bab187b6a5a3e8942ec68471`。
- Authenticode：NotSigned / SIGNING_PENDING；更新签名可信链本轮未关闭。
- 本轮没有升级真实安装。正式包生产路径通过不等于用户 GUI 安全确认已点击验收。

详细机器证据位于 D:\GIT- CetaMesh\live-model-repair；仅包含合成测试结果，不附私人配置、凭据和聊天正文。

## 7. 剩余风险与停止边界

- Native Windows unelevated 有广泛只读可见性，网络边界按原生策略而非平台防火墙执行；用户必须理解范围，强隔离需求不能使用此路径替代。
- 本轮保留 exec JSONL，未重写为 app-server。没有声称 token 级流式或所有原生交互审批已桥接。
- 确认只在 Core 进程内生效，重启须重新确认；不是持久的无限授权。
- 已有 M2/M3 部分事项、真实 QQ/DSH、原生 GUI、正式签名和可信更新链仍按原发布门禁保持未完成。Native 修复不等于产品可公开发行。
- 未 push、未发布 Stable、未自动启用系统功能、未放宽 Capability/Approval/Memory Scope/私有 IPC。

交付后等待 Owner 验收。当前不将未测安全模式切换为可用，也不自动替换用户安装版本。
