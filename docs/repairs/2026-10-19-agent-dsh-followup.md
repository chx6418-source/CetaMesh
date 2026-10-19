# CetaMesh Agent / DSH 修复交付（2026-10-19）

工作分支：`fix/handoff-context-working-memory-20261019`。
远端基础：`5c1f1312c31bbe58e59423f5417ad4f32d87dbd1`（原已领先 main 27 提交）。
本轮保留已有修复，不合并 main，不发布安装包，不修改真实 Task/Memory/DSH 配置。

## 交付内容

- MCA-01/02：DeepSeek 专属 profile 保留完整原生续接字段，贯通非流式/流式、工具、Managed、普通 Chat、审批恢复和空最终回复；off/low/high/max 映射到实际请求。普通兼容 Provider 不携带专属字段。
- MCA-03：区分 HTTP 校验、认证、余额、模型/端点、限流、服务错误；保留受控诊断，原生推理文本和外部响应正文不进入公开错误、事件或历史。
- MCA-04/05：内置 Agent 的 Workspace 前置提示、打开关联任务和另开普通聊天入口；保留阻塞/核验恢复，不盲目重放副作用。
- MCA-06：工具预算末轮保留工具定义并禁止新调用，返回 partial。缺失续接/历史超预算会受控停止，不伪造字段或静默裁断。
- SWM 增量：保留部分检查点更新中未提供的字段；以 Provider/Session 限定事件去重；Core run/phase 区分内部恢复与用户工作；提前锁定异步配置变更。
- 工作记忆：记录 Task revision 与来源；交接读取实际、授权、显式链接的记录并验证 scope/type/revision；不导出无关记录，不复活已删除记录；单条 4000 字符、最多4条、总序列化12000字符，超过时在停止源 Agent 前拒绝。
- 上下文：受限 Owner 消息引用保留来源；出现省略/截断时要求核验，避免静默丢失约束。尚未实现自动语义约束提取和专用核验界面。
- DSH-SETUP-01–06：新增版本化配置事实源，coding/social 分离、预检和原子保存；当前连接代际固定，保存显示待重启生效。结构化 YAML 校验替代正则，限制文件/深度/别名/路径；list/health 统一 DTO，未知值保留 null，加载失败与确实未加载分开。
- Harbor 提供 DSH 设置、原因文案、当前/待生效版本；健康刷新直接消费 Core 投影；typed IPC 和 Rust allowlist 接入。
- 验证中发现并修复危险清理：缺失 stagingRoot 被解析为 cwd，可误删工作目录。现在删除前要求绝对路径、严格子目录、规范路径及符号链接边界；原错误测试夹具改为真实临时 staging。

## 最新验证

Linux / Node 24.19.0；全部合成数据，不使用真实 Provider Key 或 DSH 会话。

- 恢复后的相关回归：12 suites PASS / 0 FAIL。
- 邻接回归及清理边界：10 suites PASS / 0 FAIL。
- `npm run build:ui` PASS（现有 >500 kB bundle 提示）。
- `git diff --check` PASS。
- 各新增缺陷有失败后通过的回归记录；边界删除回归只使用可丢弃的合成 cwd。
- 自动审批曾拒绝一个较宽测试轮询，理由是潜在外部 DeepSeek 请求；后续相关验证使用禁止外网 fetch/socket 的预加载器。模型请求 fixture 使用注入的 HTTP/SSE 替身。

相关命令全部使用统一 `npm test -- --suite ...` 入口。新增三个 suite 已登记：
`test-model-continuation`、`test-dsh-setup`、`test-harbor-agent-setup`。
既有 handoff、broker、staging 和 audit suite 补充正式回归。

## 未通过/未运行边界

本轮全量测试不能宣布通过：第一次全量暴露旧清理缺陷并删除临时检出；并行启动的第二次调用随后因 cwd 不存在连锁失败（1 PASS /120 FAIL /17 NOT_RUN_ENVIRONMENT，不代表120个独立产品缺陷）。已从固定远端源码和独立补丁恢复，并完成上述22套新鲜回归及 UI 构建。未在恢复后再次宣称全量绿色。

首次全量还记录 Agent expansion 300秒超时、Core channel 120秒超时、Core worker退出断言失败；本轮未将这些环境/生命周期问题标为修复。原始大尺寸图标未由连接器取回，图标源 Hash 验证不成立；本次没有提交图标改动。

`build:core` 在 Linux 被项目 Windows-only 预检拒绝；`desktop:check` / `desktop:test` 因无 cargo 未运行。Windows 原生 UI/安装包、真实 DSH 三轮生命周期、真实模型工具回合、跨原生 Agent 模型映射和联合 E2E 均为 NOT_RUN_ENVIRONMENT。代码与合成回归完成不等于用户安装版现场故障已经实测消除；发布门禁保持未通过。

## 使用提醒

更新后在 Agents → DSH 设置选择本地存在且兼容的编码/社交预设，保存后按界面提示重启 Core；活动连接不会被静默迁移。旧损坏续接历史需要新推理会话或人工核验，已有工具结果和 Task 证据不会被清空。超预算上下文或 Memory 应先精简并核验后再交接。

