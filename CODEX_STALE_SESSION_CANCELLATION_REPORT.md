# Codex 旧 Session 丢失后的正式取消恢复

日期：2026-10-20。Version 1.0.0-rc.2 / Build1106。分支 codex/codex-readonly-workspace-recovery。RELEASE_BLOCKED 保持。

## 实际复现与判断修正

Owner 在 Build1105 的正式 Harbor 中确认取消旧任务后，实际收到 Codex Task session is not available。只读核对任务 task_mvglwpll_230fa59795 仍为 blocked，progress.note 为 STAGING_READ_FAILED。此前把没有状态变化归因于自动点击未生效的说法没有充分证据；Owner 手动确认后的截图和实际代码链已明确，这是取消处理返回 SESSION_NOT_FOUND，而非 CLI 未安装或新的沙箱失败。

链路：Harbor Work 取消确认 → ui.task.cancel → stopTask → Agent Broker.cancel → Codex.requireSession → SESSION_NOT_FOUND。Task 持久化，Codex Session 为进程内状态；此前只为 cetamesh Managed Session 提供了重启后缺失恢复，Codex 一律被拒绝。

## 最小修复及证据边界

- Codex 增加只供可信 Core 调用的 verifyStoppedTask，重新解析真实 Task/Workspace，检查当前 Provider/Session、blocked、精确 STAGING_READ_FAILED，以及当前 Adapter 没有该 Session。
- 该精确错误码在现有 finalizeRun 中由 handle.done 完成后的快照读取失败分支产生，在 applyChanges 之前。当前受支持执行链禁止 blocked Task 新发用户回合；重新执行会改变状态，重启中断也会覆盖旧原因。因此本次只恢复这一种已知的子进程结束、导入前失败情形。
- 这不是通用进程退出凭证，不接受任意缺失 Session、超时、断线或手工伪造/修改的 Task 数据作为停止证明。未知状态继续拒绝；不推广到 DSH、其他 Provider 或其他错误码。
- 仅 Owner 正式取消允许该恢复。Capability 未完成请求、工具恢复状态、待审批和交接事务仍拒绝；最终 task.cancel 保留 expectedRev，期间状态/绑定变化会冲突。
- 没有新建 Broker/Store，没有直接改用户 Task、删除锁、恢复旧指令、导入修改或放宽 Native Sandbox。旧 Staging 数据不由该恢复直接删除。

## 修改与本地提交

产品提交：119209da4a53873f4003b5fed88c95551327f127。
发行回归提交：04ce9e71f643d0a7a32c7cd48560321e924c0dd8。

- src/agent/codex-agent-provider.js：绑定现有 Task 的窄范围停止核验。
- src/desktop/ui-service.js：正式取消路径接受匹配的停止证明，保留副作用、审批、交接及 revision 门禁。
- release/version.json：Build1106。
- scripts/test-desktop-chat-product.mjs：真实 createCetaMeshServices 的取消、持久化恢复及未知执行/审批/工具/交接拒绝场景。
- scripts/test-m6-c-business-sea.mjs：正式 SEA、无系统 Node、Owner IPC、重启后的旧 Session 取消与未知状态拒绝，沿用既有 npm test 聚合器。

## 验证结果

| 类别 | 结果 | 证据 |
| --- | --- | --- |
| 修复前复现 | RED，SESSION_NOT_FOUND，任务仍 blocked | npm test -- --suite test-desktop-chat-product 的实际失败输出 |
| 定向回归 | Agent/Task/Workspace/错误处理通过；最终新增产品场景通过 | 统一 npm 聚合器实际输出 |
| 全量 npm test | 131 PASS /0 FAIL /9 NOT_RUN_ENVIRONMENT | D:/GIT- CetaMesh/live-model-repair/1106-full-test.log |
| Rust，经 npm 聚合器 | 2 suites PASS，199 cases /0 FAIL | 1106-rust-test.log |
| Core、UI、Desktop release/debug、发行构建 | PASS | 1106-build-results.json |
| 新发行包分类与 RC | 12 PASS /0 FAIL /0 NRE | 1106-release-test.log |
| 新增正式 SEA 取消/重启回归 | VERIFIED_RELEASE_INTEGRATION；取消后重启仍 cancelled，未知执行保持 blocked/currentAgent | npm test -- --suite test-m6-c-business-sea --verbose，实际输出含 SEA post-exit missing Codex Session cancellation survives restart |
| 安全代码复核 | 未发现可确认 Critical/Important；正常可信 Core 管理路径成立 | 独立只读代码复核，未冒充实际运行测试 |

第一次绿色回归扩展在测试装配中误读未公开的 toolExecutionCoordinator，4 PASS/1 FAIL；改为测试侧通过现有 UI Service 注入 guard，未新增生产测试接口、未删拒绝断言。之后产品/交接回归 2 PASS/0 FAIL，再执行上述全量验证。

全量的 9 个 NRE：legacy Console、2 个 release-dist 场景、2 个 Cargo opt-in、真实 MCP/OneBot 网关、外网搜索、真实 Codex opt-in。后续 Rust 与完整发行分类分别补齐 Cargo 和 release-dist。真实网关、外网搜索与本轮真实 Codex Task 未运行；Build1105 的 Native Task E2E 是历史证据，不冒充1106真实模型执行。新增 SEA 使用受控 Model 和历史任务 Fixture，不是新真实 Codex 推理。

## 真实安装与任务现状

Build1105 已经 Owner 批准并正常退出后完成覆盖安装。1105-authorized-upgrade.json 记录 exit=0，68 份既有 JSON Hash 无变化，仅新增4份安装备份 JSON，没有 DSH 集成写入或强制终止。用户的真实旧任务没有因此自动修改。

升级前的只读预检实际输出：该旧任务当时仍 blocked/STAGING_READ_FAILED；Capability in-flight、pending approval、started tool、pending continuation 均为0，未发现 prepared Handoff；预检不写真实任务或租约。

Owner 随后明确批准升级1106和取消该旧任务。已通过应用自有 QuitRequest 与“退出 CetaMesh”确认正常退出；两次只读进程核对确认安装目录下无存活进程，Owner锁自行释放。未使用强制结束回退。

1106-authorized-upgrade.json：exit=0，安装阶段72份既有JSON Hash全部不变，仅新增4份安装备份JSON，noDshIntegration=true，forcedProcessStop=false。Task状态的后续变化是Owner已批准的正式取消操作，不属于安装覆盖或直接编辑。

重新启动实际安装版后，已在真实Windows Harbor中点击该旧任务的“取消任务”及“确定”。页面显示cancelled，历史执行者显示结束时间；未再返回SESSION_NOT_FOUND。1106-installed-cancellation-result.json只读确认：status=cancelled、currentAgent=null、同工作区活动Agent绑定=0、全部7项历史Task记录仍在。安装目录Host与Core的Hash分别匹配本轮正式发行包；About实际显示1.0.0-rc.2-build1106+119209d。

实际安装版取消链标记VERIFIED_REAL_E2E，仅指本次Windows Harbor→Owner IPC→旧Task取消/持久化，不代表新真实Codex推理或所有产品功能通过。用户应用没有为测试再次重启；取消后重启的行为由隔离SEA回归验证。当前应用已留在无关联Task的空白Chat，没有发送真实项目的新指令，没有代替用户确认原生安全范围。

## 发行产物与可追溯性

- 安装包：D:\GIT- CetaMesh\releases\1.0.0-rc.2\build-1106\CetaMesh-Setup-1.0.0-rc.2-build1106-x64.exe
- 大小：43454464 bytes。
- SHA256：5567b8c7e66160ee318f6cf4c974c579a9fe47a52f9611620dec8fb1a674ff17
- sourceCommit：119209da4a53873f4003b5fed88c95551327f127；dirtySourceTree=false。
- 后续提交仅含测试/报告，已核对 src、desktop-shell、desktop-ui、release 与构建提交无差异。
- Authenticode：NotSigned /SIGNING_PENDING。更新签名、真实 QQ/DSH、其他发布验收不因本次修复关闭。

补充已知安装器边界：原生安装器的“关闭并继续”仍含正常退出超时后的强制结束回退；本次没有使用该入口。真实升级只允许先确认应用正常退出再安装，无法退出则停止。该既有风险没有在本轮伪称修复。

无 push、合并、Stable、真实迁移、直接删锁或强制结束用户进程。保持 RELEASE_BLOCKED。
