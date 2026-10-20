# CetaMesh Codex 安全执行兼容性：WSL2 隔离原型预检

日期：2026-10-20（Asia/Shanghai）

基线：`7e4caf7387d071c6f9bea00493aeec8719181d13`，Version `1.0.0-rc.2` / Build1103

本地分支：`codex/codex-wsl2-secure-prototype`

## 1. 唯一结论

**PROTOTYPE_STATUS：BLOCKED_ENVIRONMENT**

**EXECUTION_DECISION：DENY**

**FINAL_STATUS：RELEASE_BLOCKED**

本机当前用户没有可验证的 WSL2 Linux 执行环境。只读预检已实际运行；Linux Codex、bubblewrap、受限身份、真实 app-server Session/Streaming/工具/取消及宿主文件拒读均未运行，不能声称隔离原型已经通过。没有创建 Linux 执行进程，没有复制用户凭据，也没有回退到不安全的 Windows 参数。

本报告交付实际阻塞证据和下一次原型的安全设计、验收条件。它不是新的正式执行器，也不是 WSL 安装授权。保留现有 Windows Native Adapter；本机当前已确认的 Native 沙箱不满足权限边界，仍不可执行 Workspace Task。

## 2. 当前实际预检

| 项目 | 实际操作与结果 | 状态/解释 |
| --- | --- | --- |
| Windows 基线 | 用户已确认 Build22631，本轮沿用，不重试 Native 沙箱 | 已确认前提，不是本轮新测 |
| wsl.exe | 实际存在于 Windows System32 | VERIFIED_HOST_PREFLIGHT；可执行文件存在不等于 WSL2 ready |
| WSL 状态 | `wsl.exe --status`：exit50，无 stdout/stderr | BLOCKED；不是正常运行态证据 |
| 发行版列表 | `wsl.exe --list --verbose`：exit1，返回安装型帮助文本，没有发行版列表 | BLOCKED；不能推断某个 Linux 已可执行 |
| WSL 版本 | `wsl.exe --version`：exit1，返回帮助文本 | UNVERIFIED；不能提供可靠 WSL runtime 版本 |
| 当前用户发行版注册 | 只读检查 `HKCU/Software/Microsoft/Windows/CurrentVersion/Lxss`：ABSENT | 本用户没有注册项；不推断其他 Windows 用户情况 |
| Store WSL 包 | `Get-AppxPackage -Name '*WindowsSubsystemForLinux*'`：无返回包 | 没有查询到本用户包，不据此断言所有 WSL 组件都未安装 |
| 服务 | 指定查询 WslService/LxssManager/vmcompute，只返回 vmcompute Running | 虚拟机计算服务运行不能代替 WSL2/发行版就绪 |
| 系统功能 | `Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux` 与 VirtualMachinePlatform 均提示需要提升 | NOT_RUN_ENVIRONMENT；当前执行环境不是管理员，功能状态未知；没有自动 UAC 提升 |
| Linux Codex CLI、版本和认证 | 无可进入的发行版，未执行 Linux 命令 | NOT_RUN_ENVIRONMENT，不标记已安装或未安装；Windows 登录不能代替 Linux 认证 |
| Linux bubblewrap/user namespace/seccomp | 无 Linux 执行环境，未执行 | NOT_RUN_ENVIRONMENT；不能依据 Windows 工具或文档宣称可用 |
| 受限 Linux 身份 | 没有创建用户、修改组或设置 sudo | NOT_RUN_ENVIRONMENT |

第一次 shell 直接输出 WSL 帮助时编码损坏。后续探针以 Buffer 采集并按实际 UTF-16LE 解码，得到了可读的帮助文本。不得把乱码当作成功、发行版数据或新的产品异常。即使在外层工具沙箱之外执行只读预检，仍得到上述状态，因此没有将工具内权限限制误判为 WSL2 可用。

未运行 `wsl --install/update/import/set-default-version/shutdown/terminate/unregister`，未启用 Windows 功能、安装 Linux 包、修改全局/发行版配置或停止用户进程。

### 可复核证据

随报告保存：

- `docs/repair-evidence/codex-secure-execution/wsl-preflight-20261020.json`：三条 WSL 命令的退出码和正确解码输出。
- `docs/repair-evidence/codex-secure-execution/wsl-preflight-20261020.mjs`：本轮一次性只读命令探针，不是产品 Adapter，也不进行安装或启动 Linux 会话。
- `docs/repair-evidence/codex-secure-execution/host-preflight.txt`：注册项、包、服务、系统功能查询结果。

探针只向独立证据目录写报告，没有读取真实工作区正文、Codex auth.json、聊天记录或用户密钥。没有导出真实账号、Token、Cookie。

## 3. 复用当前实现的边界

| 当前实现 | 本轮查到的实际职责 | 后续原型应如何使用 |
| --- | --- | --- |
| `src/agent/service.js` | 默认 Agent Registry 装配，包括现有 Codex Provider | 原型不注册/替换正式 Provider；将来经过评审才添加受限 Backend 选择 |
| `src/agent/broker.js` | Chat/Task/Continuity 的统一会话入口 | 保留唯一 Broker，不能由 WSL 创建第二个 Core/Owner IPC/Task Store |
| `src/agent/codex-agent-provider.js` | 当前 Native exec JSONL、会话事件缓存与独立 Follow cursor、严格 staging Profile、沙箱失败健康状态 | 原样保留，不在本轮重写；Linux app-server 不假装与 exec JSONL 同协议 |
| `src/workspace/staging.js` | `createStagingWorkspace`：有界、敏感资源过滤、拒绝外部/嵌套 Workspace、拒绝符号链接；`collectStagedChanges` 校验来源变化 | 仍从唯一授权 Workspace 生成快照，不把权威目录挂到 Linux |
| `src/capability/service.js` | `applyAgentWorkspaceChanges` 核验 Task/Workspace/provider/session，走 Broker `workspace.apply` 和审批 | 唯一权威导入入口；WSL 不获得 Owner Token 或任意 IPC 调用权 |
| `src/desktop/ui-service.js` | 已知 `sandboxCapable=false` 时拒绝 Codex Task，错误 `CODEX_SANDBOX_UNAVAILABLE` | 保留拒绝语义；不能把 installed/authenticated 当作 task-ready |
| Task runtime/store 与现有 Continuity | Task 执行者、结果/工具证据和恢复归属 | Run 停止与副作用核验继续由 Core 权威决定 |

**现有缺口也必须保留：** 当前 Codex Follow 缓存和 Desktop UI Event Bus 是进程内有界状态；本轮未发现可直接当作通用持久 Agent Event Journal 使用的现成模块。`src/channel/delivery-journal.js` 是 Channel 专用账本，不能未经契约设计直接改成 Codex 日志。原型的跨重启事件映射、持久 cursor 和 gap 处理仍需设计及实测，不能宣称“已复用所以已通过”，也不能另造一套权威任务系统来绕开。

## 4. 建议原型结构（DESIGN_ONLY / UNVERIFIED）

```text
Windows Core / 唯一 Task、Workspace、Capability、Approval 权威
  ├─ 既有过滤 Staging 快照、来源 Hash、Task/Run 授权
  ├─ 测试用受控 WSL Adapter（本轮未创建正式实现）
  │    └─ 显式专用 WSL2 发行版 + 非 root 执行用户
  │         └─ 经验证的 bubblewrap 稀疏文件系统/namespace/seccomp
  │              └─ Linux Codex app-server stdio
  │                   └─ Codex 自身 Linux 工具沙箱保持启用
  └─ 回传有界变更 → 来源冲突校验 → workspace.apply → Owner 审批 → 导入
```

选择 WSL2 只是待验证方向，不是“WSL 即沙箱”的安全结论。外层隔离必须覆盖 app-server 本体和子进程，内层 Codex 沙箱也不能关闭。bubblewrap 只提供构造隔离环境的机制，最终边界由具体策略与测试决定。

### 4.1 身份、挂载和宿主隔离

- 只能使用 Owner 明确准备的专用测试发行版，不调整用户现有 Linux 环境。WSL1 或无法确认 WSL 版本时拒绝执行。
- 执行身份必须是专用非 root 用户，无 sudo、docker/lxd 管理组和可提权能力；UID、组、可执行文件版本/Hash 及环境变化均重新预检。仅 `wsl --user` 或目录0700本身不构成充分隔离。
- 专用发行版拟使用 `[automount] enabled=false, mountFsTab=false` 与 `[interop] enabled=false, appendWindowsPath=false`。这是待批准的配置要求，本轮没有写入；关闭自动挂载并不能阻止手工挂载，所以还要检查实际 mountinfo、权限和命名空间。
- 不使用 `--ro-bind / /`，不绑定宿主盘、权威 Workspace、Windows USERPROFILE、用户 Linux home、全局 CODEX_HOME、SSH/GPG/浏览器目录、Docker/DBus/Agent socket。允许只读挂载的 Linux runtime 必须是经检查、无用户秘密的最小运行树。
- 可写对象仅为本 Run 的 Linux ext4 staging、独立临时目录和必要的受控运行元数据。清空继承环境/不必要 FD；不暴露 WSL_INTEROP、WSLENV、Windows PATH、Owner IPC Token、其他服务端口或 Socket。
- 必须验证 Windows 盘改名挂载、DrvFS/9p、符号链接/硬链接、`/proc/<pid>/root`、继承 FD、Windows `.exe` interop、vsock/宿主桥接等绕路。阻止 `/dev/dxg` 等无关设备、挂载/namespace 逃逸、提权和跨进程读取；缺少适用 seccomp/namespace 控制就拒绝，不靠 prompt 禁止。
- PID/用户/挂载/网络命名空间、no-new-privileges、能力移除和资源限制均需在该实际 Linux 内验证。最小挂载、完整 namespace 和审查过的 seccomp 不可被“bwrap 已安装”替代。WSL 内核及可信启动器仍是信任边界，不承诺抵御所有内核逃逸。

### 4.2 模型网络与凭据

- 第一阶段运行无凭据、无网络的本地拒读/拒写 canary；通过后才讨论真实模型调用。
- 真正 Session 不能借用 Windows auth.json 或在 `/mnt/c` 上查找凭据。Linux 认证是独立条件，未完成不能冒充 authenticated。
- 不将长期 Token/API Key 传入模型可读环境、共享 HOME 或可读取的命令行；短期令牌也不自动等同安全。拟由可信模型出口代理在隔离边界外持有凭据，只给受控、限用途/额度/时效的模型通路；代理的可达性、目标验证及秘密不会返回给命令的性质仍需实测。
- 无法既完成真实推理又维持宿主文件、秘密与网络隔离时保持拒绝。绝不能为了联网而放开整个 WSL 网络、宿主回环服务或系统凭据。不能继承宿主代理变量来绕过出口策略。

### 4.3 工作区传输与审批导入

1. 在 Core 中复用已授权 Task 的 staging 创建逻辑；记录 Task/Workspace/Run、来源快照 Hash 和排除项。
2. 经受限 stdio/数据通道复制快照到 Linux 私有 staging，不用宿主盘挂载或开放整个 `\\wsl$` 用户目录。传输端校验路径、长度、数量、Hash，拒绝绝对路径、`..`、链接、设备、NTFS ADS、保留名和大小写碰撞；不直接解压不可信 tar。
3. 只把 Linux staging 作为 app-server 的 cwd。启动器和 app-server 的控制参数不接受模型任意改写；使用固定 argv，不拼接模型生成的 shell 命令。
4. 结束后由可信边界提取普通文件变更，保留来源 Hash；Core 再做路径和并发修改校验。原型不向真实 Workspace 导入，审批测试也只操作全新合成数据。
5. 正式导入只能走 `applyAgentWorkspaceChanges → Broker workspace.apply → Owner Approval`。审批缺失、Task 归属变化、Session 过期、快照变化均拒绝；不同 requestId 不能因内容相同被合并。

### 4.4 app-server、事件和取消

- 先从**实际 Linux 二进制**获取版本、help 和生成 Schema；Windows CLI 的 Schema、认证和登录状态不能代替 Linux 兼容性证据。本机没有 Linux CLI，所以以下方法仅为官方协议设计参考。
- 一个 stdio 读取者执行 `initialize → initialized → thread/start → turn/start`，捕获 `item/agentMessage/delta`、工具生命周期和最终 `turn/completed`。Task ID、Core Session、Run、原生 threadId/turnId/requestId 分别映射；accepted 不等于 completed。
- Chat/Task/Continuity 复用现有 Broker Follow 分发的独立 cursor 模式。传输断开后的重放能力依实际协议确定；无可靠原生序列时，只能明确使用 Core 已持久化的事件或报告 gap，不能声称任意断点原生重放。
- 不暴露任意 app-server RPC 透传；仅允许审查过的方法。外部工具/审批请求必须经 Core 授权，拒绝隐式提权和越界权限变更。没有真实 Broker 归属的原型只做独立 Fixture，不伪造生产 Task。
- `turn/interrupt` 的响应只是取消请求应答；须等待终态 interrupted，并确认本 Run 子进程/资源结束，才可考虑 stopped。不会把 interrupted、EOF 或 app-server 消失当 completed。
- 取消超时、崩溃或 IPC 断开时标记 stop-unconfirmed / needs-reconciliation，不立即解除 Workspace 执行权；仅凭 PID 消失不足以证明没有后台执行者或未知副作用。
- 禁止调用全局 `wsl --shutdown`，禁止影响其他发行版或用户进程。受控回收只能针对本原型可证明拥有的 Linux namespace/cgroup/Run；停止能力未经验证不得启动真实任务。

### 4.5 崩溃与重启

记录 Run nonce、启动器身份、Linux boot/process-start 证据、Task binding、staging 快照、审批和导入 requestId。重启后先核验旧执行者与副作用，不自动恢复发送或导入。终态和变更写入前后中断均需测试；未知结果留待核验。需要持久化的生产 Schema/Journal 扩展必须经过兼容性设计，复用既有 Storage Primitive 与权威 Store；本轮不直接实施迁移。

## 5. 门禁及验收矩阵

| ID | 必须实际完成的验证 | 本轮结果 |
| --- | --- | --- |
| W01 | 可验证 WSL2 runtime 与专用发行版 | BLOCKED，见exit50/exit1及注册项证据 |
| W02 | Linux Codex、bubblewrap、namespace/seccomp 版本与能力 | NOT_RUN_ENVIRONMENT |
| W03 | 非root受限身份，无提权组/多余FD/秘密继承 | NOT_RUN_ENVIRONMENT |
| W04 | 同时运行直接 canary 与通过 Codex 工具读取：stage可读，stage外拒绝 | NOT_RUN_ENVIRONMENT；不能标拒读PASS |
| W05 | 宿主测试canary经 `/mnt/c`、其他盘挂载、interop、proc/fd及链接均无法读写 | NOT_RUN_ENVIRONMENT；只用合成文件，不读取真实私人文件 |
| W06 | 阻止主机凭据、用户home和网络/宿主服务绕路 | NOT_RUN_ENVIRONMENT |
| W07 | app-server真实初始化、Session、三轮Streaming，不混淆回合 | NOT_RUN_ENVIRONMENT |
| W08 | 真实受限读工具、受控staging修改，权威合成Workspace不变 | NOT_RUN_ENVIRONMENT |
| W09 | Broker拒绝未授权导入，审批后仅准确变更一次 | NOT_RUN_ENVIRONMENT；现有Broker实现不能当成本次Linux集成PASS |
| W10 | 取消应答、实际interrupted、子进程结束、执行权恢复 | NOT_RUN_ENVIRONMENT |
| W11 | app-server/Adapter崩溃、Core重启、旧事件与新Run隔离 | NOT_RUN_ENVIRONMENT |
| W12 | 来源修改、重复请求、审批中断、导入中断、未知副作用 | NOT_RUN_ENVIRONMENT |
| W13 | 双/三消费者独立cursor、重复事件、重放和gap | NOT_RUN_ENVIRONMENT |
| W14 | 预检失败不启动Codex、不复制凭据、不改用户工作区 | 本轮流程实际执行到拒绝门禁；未实现产品级WSL启动器，不能外推为正式拦截测试PASS |
| W15 | Native Adapter保留且安全不满足时不可执行 | 本轮未改；既有CODEX_SANDBOX_UNAVAILABLE门禁保留，不重复Native参数测试 |

这里没有 Linux Session、工具或宿主拒读成功数量；它们都是待运行项。没有用 Windows/MCP Fixture 代替 WSL2 OS 隔离测试。

## 6. 后续最小必要条件与停止边界

1. Owner/IT 单独批准并准备 WSL2 与**专用测试发行版**，明确允许创建受限身份和隔离配置。当前系统功能状态仍需有权限的只读确认；本报告不要求或授权立即启用。
2. Linux Codex、bubblewrap 及其依赖来自明确来源、真实版本可核验；离线工具链预检后，先完成无模型、无凭据边界 canary。
3. 再评审凭据/网络代理、停止与事件持久化设计，确认 Linux CLI 的实际 Schema 和嵌套沙箱行为。若任一前置条件不成立，拒绝执行；不改用 root、大范围挂载或关闭内层沙箱。
4. 在合成 Workspace 内完成 W01～W13 才能评价原型可行性；通过也不自动替换 Native Provider。正式切换、安装器包含WSL能力、用户认证迁移和数据写入均属于另一期批准范围。

本轮没有产品代码修改或安装包变更，因此不递增 Build、不构建安装包、不重跑无关全量npm/Rust。先前 Build1103 的134 PASS/Rust199/Release12是历史基线，**不是本次WSL验证结果**。仅对报告/证据做JSON解析和Git差异检查。没有push、合并main、发布、真实数据迁移、强制停止进程、未知锁释放或更改DSH Preset。

## 7. 参考依据及适用边界

- [Microsoft WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)：自动挂载、fstab及interop是不同开关；关闭自动挂载不等于阻止手工挂载。此处配置为设计要求，未写入本机。
- [OpenAI app-server](https://learn.chatgpt.com/docs/app-server)：初始化、回合事件与中断语义。Linux版本未知，实际Schema必须以后续Linux二进制为准。
- [bubblewrap 上游说明](https://github.com/containers/bubblewrap)：它是隔离机制，不自带完整安全策略；需要按挂载、namespace、设备、socket等实际选择验证安全边界。引用上游原理不等于当前主机验证通过。
