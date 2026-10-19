# Codex Windows 沙箱兼容性核验（Build1102）

## 结论

**Codex Workspace Task 仍为 BLOCKED / RELEASE_BLOCKED。** 本轮没有发现能在本机、当前 CLI、现有严格文件读取边界下安全启用 Codex 的配置。没有关闭沙箱、允许根目录读取或改用 unrestricted 模式。普通模型聊天及 Managed Agent 的真实生产 SEA 路径重新通过，不能用它们的成功代替 Codex 成功。

本轮无产品源码修改，无新 Build、无覆盖安装。沿用 Version `1.0.0-rc.2` / Build `1102`；产品 sourceCommit `7f83854c501366ad6ff2801e589a72ceea5114b8`，开始核验时 HEAD `dd6cf7a95128b1d884e2cc40f7e0a403cd2d7072`，分支 `codex/live-model-tool-repair`，工作树干净。后续本报告提交不改变产品来源。

## 实际配置与原因

`src/agent/codex-agent-provider.js` 的 `profileOverrides()` 使用已有 `cetamesh-task` Profile：`:root=deny`、`:minimal=read`、临时目录 deny、仅 staging workspace 可写，`.env`/`.env.*` deny，网络禁用。`buildCodexExecArgs()` 强制 `--ask-for-approval never`，exec 使用 `--ignore-user-config --ignore-rules --strict-config`。因此 Task 不继承用户任意沙箱、插件、MCP 和 hooks 配置。不能简单去掉 ignore-user-config 来继承整个用户环境。

现有真实 Codex 调用落到 unelevated 沙箱，拒绝 split filesystem read restrictions。只切换 elevated 仍不能解决：已安装 CLI 明确要求 effective `:root` read；这与当前禁止读取 staging 外用户数据的契约不兼容。将 `:root=deny` 改为 read 属于权限扩大，本轮没有这样做。

## 当前机器及独立探针

| 检查 | 实际结果 | 结论 |
| --- | --- | --- |
| 实际二进制 `codex --version` | `codex-cli 0.163.0-alpha.10.2` | 已安装，不是 CLI_NOT_FOUND |
| Windows 只读系统查询 | Windows 11 专业版 `10.0.22631` | 本机事实 |
| CLI `features list` | prefer_mxc 存在，under development，false | 不自动开启未知能力 |
| 从同一二进制生成实验 API Schema | 存在 `windowsSandbox/readiness`，params=null | 依据真实 Schema 调用 |
| app-server initialize → readiness | `{status: ready}` | 仅说明一般设置就绪，不证明特定 Profile 可执行 |
| 官方 MXC 单命令探针 | `failed to prepare MXC sandbox: native MXC is unavailable on this executor` | 本机不可用 |
| 现有严格 Profile + 显式 elevated + 独立 staging | exit1：`windows sandbox failed: elevated Windows sandbox requires effective :root read access` | 相同权限边界下不可用 |

外层工具受限环境第一次 MXC 查询还出现 HOME 临时目录拒绝访问和 CIM 拒绝访问，因此在获准的工具执行环境重新运行，仍然是 MXC unavailable；不把外层工具权限错误当成产品错误。

`CODEX_HOME/.sandbox/setup_error.json` 的权限失败记录与 setup_marker 时间均为 2026-09-16。它们属于历史证据，**不能**用来断言当前设置未完成；当前 readiness=ready 已排除该推断。没有调用 setupStart、uninstall 或设置命令，没有重建系统账号/防火墙规则或自动更改安全配置。

elevated 探针在全新测试目录创建 allowed.txt、合成 .env 和目录外合成文件，计划验证允许和拒绝边界；CLI 在命令开始前拒绝 Profile，故这些访问断言并未执行，**不标记边界测试 PASS**。测试目录已由脚本 finally 清理。脚本最初 Windows ESM import 路径错误已修正，错误尝试不算产品反例。

## 本轮新运行的回归

通过现有统一入口：

`npm test -- --suite test-agent-provider-expansion --suite test-managed-agent-provider --suite test-desktop-chat-product --suite test-codex-discovery --verbose`

结果 **4 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**。包含桌面 Chat 42 组、Managed Provider 55 个断言，以及原有 Codex 沙箱失败分类、权限限制和旧会话取消保护。没有改断言、删测试或改基线。

## 本轮新运行的真实模型生产装配验证

直接执行 Build1102 正式 SEA `--worker`，独立 StateDir / 随机 Owner IPC；PATH 仅 System32，不依赖系统 Node。先读取产物 build-info 并断言 Build1102 / sourceCommit7f83854，再执行既有三轮验收脚本的1102副本。已有用户 DeepSeek 凭据仅用于授权测试的临时凭据存储，未输出凭据，结束后清理测试目录；只向模型发送合成 CountBox 项目内容。

| 路径 | 结果 | 证据等级 |
| --- | --- | --- |
| Agent none + DeepSeek + Broker 只读分析 | 连续三轮均完成，正式回答非空、无 DSML；不创建 Task、不派发 Agent；隔离测试中另一个 blocked writer 不影响普通聊天 | VERIFIED_REAL_E2E（真实模型）+ VERIFIED_RELEASE_INTEGRATION（SEA） |
| Managed Agent + DeepSeek + Broker 只读分析 | 连续三轮均 completed，正式回答非空、无 DSML，合成权威文件未变 | VERIFIED_REAL_E2E（真实模型）+ VERIFIED_RELEASE_INTEGRATION（SEA） |
| Codex 当前 Windows Workspace Task | 前次真实执行拒绝 + 本轮两种 native sandbox 探针不满足 | BLOCKED，不能标记 Codex VERIFIED_REAL_E2E |

这两条 SEA 验证不是 Windows GUI 三轮点击验收。此前 Build1102 全量134 PASS / Rust199 PASS / Release12 PASS仅引用既有报告，本轮没有重新运行全量或构建；产品代码未变化。

另在用户已安装的 Build1102 Windows WebView2 窗口，经实际 UI 点击历史错误卡片的“新建普通聊天”，创建独立会话；显示“不使用 Agent / deepseek-flash”。输入“你好，请用一句话回复：普通聊天已连接。不要调用工具。”后实际点击发送，看到生成中，再看到正式回答“普通聊天已连接。”、idle、没有关联任务、Work总数仍为3。保持该会话打开供用户继续。没有重试失败的 Codex Task，也没有切换旧 Task 执行者。本项为真实 GUI 普通聊天单轮验收，不宣称所有 GUI 功能或 Codex 已通过。

首次观察到正式回答后超过10秒再次抓取同一窗口，回答仍然存在；截图证据 `1102-live-normal-chat-visible.jpg` 位于外部证据目录。

## 证据位置

均位于 `D:/GIT- CetaMesh/live-model-repair/`：

- `codex-sandbox-readiness.mjs`：只读 API 查询，只输出 readiness 和退出信息。
- `codex-0163-schema/`：来自实际安装 CLI 的 Schema。
- `codex-elevated-probe.mjs`、`codex-elevated-probe-result.json`：显式 elevated 严格 Profile 反例。
- `1102-sandbox-focused.log`：本轮四套聚合回归。
- `reverify1102-model-paths.mjs`：断言实际产物来源，顺序重跑两条已存在真实模型路径。
- `1102-recheck-real-chat-none-results.json` / `.log`、`1102-recheck-real-sea-results.json` / `.log`：六轮真实模型 SEA 结果。

## 安全后续路径与 Owner 边界

1. 立即使用：普通模型聊天（不使用 Agent），需要工作区任务时可选 CetaMesh Managed Agent；其权限继续经 Core/Broker，不借用 Codex 的失败会话。
2. Codex 解除阻塞需要另一个**确实能执行同等文件/网络边界**的受支持环境。候选包括经 Owner/IT 核验的兼容 Windows/MXC 环境或专门的隔离执行环境。不能保证单纯更新系统一定成功；必须先跑同一 Profile 的正负边界测试，再跑真实 Task、取消与重启回归。
3. 不自动执行 Windows 升级、sandbox setup、安装 WSL/VM 或新增宿主集成。这些系统变更和新执行架构需要单独范围/批准。当前 CLI 的 sandbox help 没有 setup 子命令，不照抄其他版本文档命令。
4. 当前不要求再次安装1102或取消其他真实任务。Documents 的既有 blocked Task 未在本轮操作。没有真实迁移、锁释放、QQ 外发、DSH Preset 修改、push、合并或发布。

官方依据：[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。文档说明 unelevated 不支持 denied read paths、MXC 有设备与策略前置条件、readiness 不能代替实际受限命令。当前 CLI 的 elevated `:root` read 要求以本轮二进制输出为证。
