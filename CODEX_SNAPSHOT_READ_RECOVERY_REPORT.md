# Codex 快照读取失败与有界恢复报告 — Build 1107

日期：2026-10-20。分支：codex/codex-readonly-workspace-recovery。

## 结论与边界

RELEASE_BLOCKED。FIXED_CODE / VERIFIED_FIXTURE：单次可恢复文件读取错误立即阻塞回合的反例已修复。VERIFIED_REAL_E2E / VERIFIED_RELEASE_INTEGRATION：合成隔离工作区的真实 Codex 三轮 Chat 分别在生产服务装配和正式 SEA 通过。原用户 Task 的具体底层 errno 未被1106保存，仍未证实；原任务尚未恢复成功，不能标记 CLOSED。当前实际安装仍为1106，未擅自升级1107或取消新任务。

## 实际用户故障与操作

20:46截图对应新Task task_mvgofttr_78f532317e，而非此前已批准取消的 task_mvglwpll_230fa59795。原旧Task取消已完成，不能把旧取消修复视为本次快照修复。

只读核对新Task：blocked / STAGING_READ_FAILED，只有一个Codex绑定、无Continuity事务、无平台工具执行证据。Core与诊断进程均为Medium完整性级别，没有调整ACL、提权或沙箱。保留Stage与当前来源均1482文件、153831110字节；两次只读Hash比对均0差异。最长Stage文件路径246字符，未发现>=260路径。这只能证明检查时可读且内容相同，不能证明失败当时无读取问题。

经产品正式Work“继续”入口进行一次恢复，新Task短暂running后再次blocked / STAGING_READ_FAILED。没有重复点击重试、取消该任务、删除锁或批准文件导入。重新进入Chat后生成中消失、显示Codex未完成，正文仍在；本轮没有基于该UI现象作未经复现的前端修改。

无法追溯的内容：原errno、syscall和失败路径未持久保存。不得推断成Defender、EBUSY、权限、Handoff或用户工作区改动已经被证实。

## 复现、修改与安全性

RED：隔离fake CLI先完成只读回复，第一次Stage枚举注入EBUSY，旧实现立即reconciliation-required，断言期待completed失败。

修改：
- src/workspace/staging.js：保留Storage错误cause，并区分stage/source区域。原边界、敏感文件过滤、大小/数量限制、冲突检查及导入基线不变。
- src/agent/codex-agent-provider.js：仅collectStagedChanges的只读扫描对STAGING_READ_FAILED且底层EBUSY/EACCES/EPERM/ENOENT最多3次，等待50/150ms；不重跑CLI、工具、审批或导入。路径越界、冲突、限制失败立即拒绝。取消/关闭阻止下一次扫描和导入。
- 最终失败保留errno、syscall、区域、次数和SHA256路径指纹；无原始文件路径、文件内容或凭据。status与安全日志提供诊断，用户错误提示包含诊断类别。
- scripts/test-agent-provider-expansion.mjs：瞬时读取、持续读取失败、有界次数、路径越界不重试、取消中止且不导入。
- scripts/test-codex-chat-snapshot.mjs：登记现有npm test；相同1482文件/153831110字节合成工作区，三轮不同指令、正式消息、当前Task状态、无源文件修改及无导入审批；支持生产服务装配和正式SEA后端。
- release/version.json：1.0.0-rc.2 Build1107。

未重写Broker、Task、Continuity或Store。1106精确终态取消及未知副作用栅栏保留。

## 真实测试范围与失败记录

新增真实Chat测试最初两次三轮主业务断言通过，但自动Continuity处理使清理阶段失败（TASK_HANDOFF_IN_FLIGHT / 90秒仍未settle），因此这两次整体FAIL，不能算通过。后续将该专用快照测试的隔离配置显式设为autoRollover=false，仍断言无在途Handoff并通过正式取消清理；未修改产品默认策略、未删除清理断言。该配置下的通过不验证默认自动Rollover/Handoff，前两次失败保留为待另行定位的限制。

当前测试：
- 定向npm：test-agent-provider-expansion / test-workspace-staging-boundary / test-desktop-chat-product / test-error-hygiene，4 PASS /0 FAIL。
- 全量npm test：131 PASS /0 FAIL /10 NOT_RUN_ENVIRONMENT。包括新增真实测试默认未opt-in，Rust默认未opt-in；另外单独运行真实/Rust套件。
- opt-in真实Codex生产createCetaMeshServices三轮：1 PASS /0 FAIL。合成数据，自动Rollover显式关闭。
- opt-in相同用例正式Build1107 SEA：1 PASS /0 FAIL，子进程PATH仅System32、独立StateDir/IPC、无系统Node、真实CodexCLI；自动Rollover显式关闭。不是用户安装版GUI或真实项目恢复验收。
- Rust：cargo:check/test两套件PASS；199单测PASS /0FAIL。
- build:core /build:ui /desktop:check /desktop:build /desktop:build:debug /build:release：exit0。
- 首次发行聚合：11 PASS /1 FAIL。test-m6-pure-core-sea中伪Codex(Node二进制)探测实际ETIMEDOUT、期待CLI_PROTOCOL_UNSUPPORTED。原断言单独重跑PASS；最终同一完整发行聚合重跑12 PASS /0 FAIL /0 NOT_RUN_ENVIRONMENT（exit0）；其中RC安装/运行/崩溃恢复/单实例/卸载保留测试数据通过。未改断言、超时或基线，首次原因尚未证实，不以重跑抹去记录。

日志：D:/GIT- CetaMesh/live-model-repair/1107-full-test.log、1107-rust-test.log、1107-large-green.log、1107-sea-chat.log、1107-release-test.log。首次真实测试原始失败还记录于本会话工具输出及1107-large-repro.log；后续green日志不代表先前失败不存在。

## 发行候选

产品/测试Commit：799169f7166f98960a51408e90018a7c571b1a43。
sourceCommit同上；构建时dirtySourceTree=false；Version 1.0.0-rc.2；Build1107。
安装包：D:/GIT- CetaMesh/releases/1.0.0-rc.2/build-1107/CetaMesh-Setup-1.0.0-rc.2-build1107-x64.exe。
大小43454464 bytes；SHA256 7f62751436d0464996971c742f190b65f7379f2a00e8d606aa7f75dd3bc44826。
Authenticode：NotSigned / SIGNING_PENDING。

## 剩余动作

1. Owner批准正常退出和保留数据升级1107后，才可验证原任务；若需结束当前新任务须单独批准，不继承旧Task取消许可。
2. 原快照读取错误若持续，使用新增诊断定位具体原因；禁止以跳过校验、清空Store或扩大权限解决。
3. 默认自动Rollover/Handoff的真实清理阻塞未在本次修复关闭。
4. 安装器“关闭并继续”超时强制结束的既有边界未修复；升级必须先正常退出并确认锁自行释放，不能使用该回退。
5. 未签名、更新可信链及其他真实QQ/DSH验收保持原阻塞。

未push、合并、Stable、真实迁移、用户数据直接编辑、删除锁或强制终止真实进程。
