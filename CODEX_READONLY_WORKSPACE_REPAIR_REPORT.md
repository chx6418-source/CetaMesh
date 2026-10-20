# Codex 只读回合误阻塞修复

日期：2026-10-20。Version 1.0.0-rc.2 / Build1105。分支 codex/codex-readonly-workspace-recovery。RELEASE_BLOCKED 保持。

## 实际证据与根因

截图对应旧 Codex Task 已生成“你好”的回复，随后状态为 blocked，持久化 progress.note 为 STAGING_READ_FAILED。第二条请求被既有 Task 恢复门禁拒绝；不是本次 CLI 未安装或 Native 沙箱拒绝。

旧实现 collectStagedChanges 在判断 Stage 是否存在修改之前，无条件重新读取并 Hash 整个源工作区。无待导入修改时，源目录短暂不可读或任意快照文件变化也会使纯文本回合失败。Codex Adapter 又将不同的读取、大小限制等错误统一显示为 Workspace changed，造成误导。

已在隔离 Fixture 先复现旧行为失败，再修复为绿色。本轮只读核对时，原工作区已能扫描（1482 文件），未能追溯此前具体不可读路径；没有把它声称为已确认的 Hash 冲突。原错误仅持久化错误码，没有保留底层路径原因。

## 修复边界

- Stage 没有差异时返回空导入集合，不读取与导入无关的源快照；允许完成回复。
- 有新增、修改或删除时，保留原先完整的源扫描与 Hash 冲突拒绝；读取失败仍拒绝导入。
- 没有自动刷新 baseline、自动合并、批准修改、删除锁或恢复 blocked Task。
- Stage 没有差异不代表源工作区未被其他程序修改。回复基于捕获的任务快照；后续存在写入时仍会因旧基线与源不一致被拒绝，不能据此自动接管。
- 错误提示区分真实冲突与快照读取/限制失败，并保留实际错误码。

## 修改与提交

产品提交：8d2642e1ee64bec3f8ae37216f3605cd39d6af00。

- src/workspace/staging.js：先计算差异，再决定是否需要导入前源校验。
- src/agent/codex-agent-provider.js：区分错误提示。
- scripts/test-workspace-staging-boundary.mjs：新增只读源漂移、EACCES、真实写入冲突/读取失败拒绝。
- scripts/test-phase3-real-codex.mjs：新增同一原生 Session 的只读问候→运行文件变化→下一轮分析；确认不阻塞、不覆盖外部更新。
- release/version.json：1105。

上述测试均沿用 npm test 聚合器。后续仅修正实测脚本的结果观察入口，未修改产品执行逻辑或删除完成/内容断言。

## 本轮验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 初始只读误阻塞复现 | RED，原实现拒绝无导入回合 | readonly-staging-red.log |
| Staging/Provider/Chat/Handoff/审计修复/错误红线 | 6 PASS /0 FAIL | readonly-staging-green.log |
| 真实 Codex、DSH 契约、Managed Agent、Workspace 恢复 | 4 PASS /0 FAIL | readonly-real-regression-final.log |
| 发行分类与 RC | 12 PASS /0 FAIL | 1105-release-test.log |
| Rust 经 npm 聚合器 | 2 suites PASS，199 Rust cases /0 FAIL | 1105-cargo-aggregated.log |
| Core/UI/Desktop release/debug/发行构建 | PASS | 1105-build-results.json 与分类日志 |
| 正式 SEA Native Codex，源运行文件变更，取消与重启 | VERIFIED_REAL_E2E /VERIFIED_RELEASE_INTEGRATION | 1105-native-sea-results.json、1105-native-sea-final.log |

本轮没有重新运行全量140 suites；上一轮136/0/4是 Build1104 的历史结果，不能冒充 Build1105 全量通过。此次运行的是与修改相关的定向、真实 Native、Rust和全部发行分类验证。

首轮扩展实测存在两项验收脚本问题，失败证据保留：readonly-real-regression.log 为3 PASS /1 FAIL，原因是用原始 Broker.send 却等待该入口未注册的 Task Checkpoint 更新；改为检查真实 Native Follow 的完成终态、正式回复及 Task running。1105-native-sea.log 首轮把工作区放在 Core 数据根内部，被原有凭据排除规则排除；将合成工作区与 Core profile 分开后通过。没有放宽排除或取消断言。

只读安全复核未发现 Critical/Important 问题。真实验证只操作合成工作区；没有更改真实项目、原 blocked Task、真实配置、凭据或写入租约。

## 安装包及后续

- 安装包：D:\GIT- CetaMesh\releases\1.0.0-rc.2\build-1105\CetaMesh-Setup-1.0.0-rc.2-build1105-x64.exe
- 大小：43454464 bytes。
- SHA256：b20160fe550dd0eeb2456e994efb650d02db84646f4275dfc1983f15d3fc2682
- sourceCommit：8d2642e1ee64bec3f8ae37216f3605cd39d6af00；dirtySourceTree=false。
- Authenticode：NotSigned /SIGNING_PENDING。

Build1105 已经 Owner 批准并保留数据覆盖安装，68份既有 JSON Hash 不变。Owner 在实际 Harbor 确认取消旧任务后收到 SESSION_NOT_FOUND，任务仍 blocked；根因为重启后旧 Codex Session 不在内存。窄范围取消恢复已在 Build1106 修复并完成正式 SEA 回归，真实升级与取消等待本次批准。详见 CODEX_STALE_SESSION_CANCELLATION_REPORT.md。没有直接改任务或删除锁。

本轮无 push、合并、Stable、真实迁移或强制终止用户进程。整体保持 RELEASE_BLOCKED。
