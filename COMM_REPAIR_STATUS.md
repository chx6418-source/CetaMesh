# COMM-01–13 修复台账

> 后续授权（2026-10-21）：Owner 已指示提交、合并和推送。下文未提交/不推送描述为初次修复交付时的事实；后续 Git 集成按该授权进行，DEV 包证据保持原样。

> 最新提交前复核：修正重复测试暴露的 Desktop 元数据导入提前初始化数据根问题，新增隔离断言；重新构建 **DEV Build1114**，完整回归 **146 PASS / 0 FAIL / 8 NRE，Rust 199/0**，exit 0。详见 COMMUNICATION_REPAIR_REPORT.md 顶部补充及 publish-tests.log。

开始 HEAD：63f6155718e4ef7cbc182bd6b4debcde0f1faeb1。隔离分支 codex/comm-01-13-repair。
本轮不提交、合并、推送或发布；真实账号、工作区与迁移数据不参与测试。

|编号|当前状态|根因/范围|验收入口|
|---|---|---|---|
|COMM-01|源码已修复；定向自动化已验证|审批绑定 task.rev、旧 grants 及 validate 竞争|test-comm-approval；原 security-negatives 拒绝断言保持|
|COMM-02|源码已修复；定向自动化已验证|waiting 递减终态计数、续跑丢目标身份|test-comm-managed-turns / approval；真实外部 Agent 交接待验|
|COMM-04|源码已修复；定向自动化已验证|审批等待执行与模型恢复|test-comm-approval-operations / flow；实际 IPC 与操作状态|
|COMM-05|源码已修复；定向自动化已验证|Runner 不消费 signal|test-comm-runner；实际 Windows 自有进程树；POSIX 未运行|
|COMM-06|源码已修复；定向自动化已验证|关闭不 await，提前释放 owner|test-comm-lifecycle / legacy-shutdown；真实隔离进程|
|COMM-07|源码已修复；定向自动化已验证|事件/历史按条数分页|test-comm-event-budget；真实 UTF-8 帧与双向历史|
|COMM-12|源码已修复；定向自动化已验证|投影丢身份、Channel 被滤、恢复仅读一页|test-comm-event-budget；生产 bus/IPC/前端恢复 helper|
|COMM-13|源码已修复；定向自动化已验证|合块长度误当单帧长度|test-comm-channel-mesh；四种分块及容量/UTF-8|
|COMM-03|源码已修复；定向自动化已验证|包装 input 无 additionalProperties|test-comm-integration；目标 Schema/风险与审批一致|
|COMM-08|源码已修复；定向自动化已验证|默认管理动作未接线|test-comm-controls；真实 QQ/Harbor 操作未验；新账号配置限制见报告|
|COMM-09|源码已修复；定向自动化已验证|监听仅随邀请启动、close 后可重开|test-comm-channel-mesh；真实本地 TLS；手机未验|
|COMM-10|源码已修复；定向自动化已验证|重启不恢复能力描述符|test-comm-extension；真实插件 Worker、持久启用与懒启动|
|COMM-11|源码已修复；定向自动化已验证|同 ID 注册跳过旧 Schema|test-comm-extension；升级/回滚/旧授权拒绝|

历史探针只作为复现参考，不作为当前通过证据。以上为当前生产模块的定向动态验证；完整聚合结果见最终报告第 6 节，不等于真实 Codex/DSH/QQ/手机或普通用户 Windows GUI 全链路通过。

## 定向回归进度

已通过：COMM01 权限与取消竞争；真实 Managed 三回合/两审批；审批接受/持久操作/断线；真实 Runner 子孙进程取消；异步 Core/Legacy 退出；实际 IPC UTF-8 帧与前端 gap 恢复；默认 Channel 管理；真实 TLS Mesh 重启；插件懒发现/升级/回滚。

正式 build:release（无 --dev）因 dirty source 被安全拒绝，未绕过。已改用 --dev 本地包做发行集成，不能据此标记正式 RC_READY。

最终开发 Build 1113；sourceCommit/开始与结束 HEAD 均为 63f6155718e4ef7cbc182bd6b4debcde0f1faeb1；修复尚未提交。当前仍为 RELEASE_BLOCKED。未提交、合并、推送、升级实际安装或执行真实数据迁移。

最终完整聚合：**146 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**（154 suites，exit 0），其中 Rust **199 PASS / 0 FAIL**；13 个新通信套件全部执行。UI/Core/Host/DEV 发行构建通过；DEV 安装版复用原 RC 全断言通过，正式 clean-source RC 不可用。源输入 316 项在构建后复核 Hash 一致。详见 COMMUNICATION_REPAIR_REPORT.md 第 6 节及 comm-evidence/all-tests-final.log。
