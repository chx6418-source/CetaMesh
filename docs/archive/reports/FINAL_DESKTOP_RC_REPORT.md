# CetaMesh Desktop — Final Desktop RC Report

Date: 2026-10-06 · Round: Final Security Hardening + Release Candidate Revalidation

## Source HEAD / Branch

| 项 | 值 |
| --- | --- |
| Branch | `fix/agent-test-run-security`（base `4f6e3e8` = main 含主题/品牌提交） |
| Final Code HEAD | `f0696f1`（fix + test 两个提交） |
| Docs HEAD（RC 构建时） | `d4c9395`（PROJECT_STATE / HARDENING_REPORT 文档收口；RC 即构建于此提交） |
| dirty | **false**（干净 worktree 构建） |
| 本报告提交 | 紧随 `d4c9395` 的 docs 提交（非代码改动，不影响已构建产物） |
| origin/main | `9861976`（v2 hardening 已合并推送；本轮分支待 Owner 确认后合并） |
| Build ID | `1.0.0-rc.1+d4c9395` |

提交序列：`ed2916c` fix(security) → `f0696f1` test(security) → `d4c9395` docs(state) → 本报告。

## Security Fix Summary

核心命题落地：**Agent 可以修改 Workspace ≠ Agent 可以执行 Workspace 代码。**

| 项 | 修正内容 |
| --- | --- |
| test.run Default Grant | 移除。默认 Agent Task Grant 收敛为 filesystem.read/write/search + git.status/diff + memory.read |
| test.run Risk | medium → **high**（Agent 请求一律进审批队列，无论 grant 是否包含） |
| Approval Behavior | **Approve Once**：Grant = 可请求；Approval = 这次可执行。三层（Grant + Permission + Approval）同时满足才执行；grant 绝不被解释为"免审批" |
| Owner 语义 | Owner 在 Workspace UI 直接点击"运行测试"保持直接执行（Owner 的点击即显式决定） |
| Approval Replay | 已消费 approvalId 重放 → APPROVAL_NOT_APPROVED |
| Approval Expiry | pending 过期决定与已批准过期消费 → APPROVAL_EXPIRED（TTL 10 分钟） |
| Payload Mutation | 批准 `npm test` 后换 `npm run dangerous` → APPROVAL_MISMATCH（指纹绑定） |
| Workspace Binding | Task grant 绑定原工作区；跨工作区请求 → WORKSPACE_NOT_AUTHORIZED |
| Workshop test.run policy | 勾选只代表"可请求"；UI 默认不勾选保持不变 |
| Smart Project test.run policy | 显式 request-only grant：请求 → pending → Owner 决定 → 执行一次 → 结果回到 Agent；绝不静默自动执行 |
| Continuity pending approval | Managed Agent 等待审批期间 rollover 被既有 ROLLOVER_NOT_SAFE 守卫拒绝；rollover 的 Checkpoint 记录待审批请求**引用**（approvalId/capability/expiresAt），审批不作为可继承权限随 Session 交接——新 Session 必须同指纹且未过期才可继续，否则重新请求 |
| Runner 定位 | `isolated-runner.js` 文件名保持兼容，语义明确为 **Controlled Test Runner**，**This is not an OS sandbox**——它执行的是 Agent 可经 filesystem.write 修改的项目代码；runner 是审批之后的纵深防御层（allowlist / 最小 env / 固定 cwd / 超时杀树 / output 有界 / stdin 关闭），allowlist 不扩大 |

附带给予 UI 的修复：Capability 审批行解析修正（approval 行的
capability/risk/taskId/workspaceId/reason/actor 实际存于 `request` 内层——此前
字段恒空），并新增 test.run 的高风险文案（"高风险：将执行当前 Workspace 中的
项目代码……本次批准仅执行一次"）与 Command Type / Requested 执行 参数展示。

## Tests（本机实跑）

| 测试 | 结果 |
| --- | --- |
| `test-agent-test-run-security`（新增，10 组，真实受控执行；含"Agent 改写 package.json 后 test.run 仍需审批"的写后执行攻击 fixture） | **PASS** |
| `test-isolated-runner`（负面扩至 powershell/cmd/python/node/npm install\|exec/npx/cargo run\|build\|publish） | PASS（6 组） |
| `test-security-negatives`（组 6 更新：bash/npm install 进待审批、Owner 拒绝生效） | PASS（8 组） |
| `test-capability` / `test-capability-coverage` / `test-agent-broker` / `test-agent` / `test-managed-agent` | PASS |
| `test-workshop` / `test-task` / `test-workspace` / `test-memory` / `test-memory-link` / `test-mesh` | PASS |
| `test-continuity-rollover` / `test-continuity-auto-rollover` / `test-workspace-reconciliation` | PASS |
| `test-architecture`（8 组红线） / `test-ipc-protocol` / `test-control-service` / `test-desktop-chat-product`（17 组） / `test-platform` / `test-owner-agent-mode` | PASS |
| `test-core-entry` / `test-privilege`（24）/ `test-dsh-integration` / `test-system`（108） | PASS |
| `desktop:check` / `desktop:test` | PASS（cargo **109/109**，含审批解析修复 + test.run 文案测试） |
| `test-standalone-model` / `test-process-extension-host` / `test-app-icon` / `test-md` / `test-wait` / `test-card` / `test-local-services` / `test-slang` / `test-stickers` / `test-app-paths` / `test-forward` | PASS |
| `test-vision` live 探针 | PASS + NOT_RUN_ENVIRONMENT（端口被本机已安装实例占用，403 → 如实分类） |
| 真实 Provider Key 回合 / 真实 QQ（SnowLuma）/ 跨设备 Mesh / 代码签名 / 干净 VM | **NOT_RUN_ENVIRONMENT** |

## Release Build

| 步骤 | 结果 |
| --- | --- |
| `npm run build:core`（干净 worktree @ `d4c9395`） | PASS |
| `npm run desktop:build` | PASS |
| `npm run build:release` | PASS（`1.0.0-rc.1+d4c9395`，dirty=false） |
| `npm run test-release-candidate` | PASS（中文+空格路径 / 无系统 Node / 只读安装目录 / 崩溃恢复 / 单实例 / 孤儿守卫 / 卸载保留数据） |

## Artifacts（dist/app，gitignored，仅本地交付）

| 产物 | 大小 | SHA256 |
| --- | --- | --- |
| `WhaleBridge-Setup-x64.exe` | 42,074,112 字节 | `6396B7E228797A66B856A7E18603C23982BC387EE7338AEDD2B8B7F4A01DECC6` |
| `WhaleBridge.exe`（桌面壳） | — | `367EA0F2304258AB5B849F18AC7CE7600BCB0C3B89A46332281D19A02D120BB2` |
| `payload/WhaleBridgeCore.exe`（Node SEA） | — | `6B4B50B1B55D3882D959AE9D03E701F4A72FEEFFC4F346A0CB4DE37C82E83122` |

上一版候选保留：`dist/app-previous-9861976`。

## 安全验收表

| 项 | 状态 |
| --- | --- |
| Default Agent test.run grant | **PASS**（默认 grant 无 test.run，测试断言） |
| Agent test.run approval | **PASS**（risk=high → 一律 pending） |
| Approve once | **PASS**（批准恰好执行一次，marker 计数断言） |
| Approval replay | **PASS**（APPROVAL_NOT_APPROVED） |
| Approval expiry | **PASS**（pending 与已批准两态均 APPROVAL_EXPIRED） |
| Payload mutation | **PASS**（APPROVAL_MISMATCH） |
| Workspace mutation（跨工作区） | **PASS**（WORKSPACE_NOT_AUTHORIZED） |
| Task mutation（无 grant agent） | **PASS**（PERMISSION_DENIED） |
| filesystem.write + test.run separation | **PASS**（写后执行攻击 fixture：写 package.json 后 test.run 仍 pending） |
| Runner allowlist | **PASS**（npm test / npm run <script> / cargo test [name] 之外全拒） |
| Minimal env | **PASS**（宿主变量不透传） |
| Timeout | **PASS**（超时杀进程树） |
| Output limit | **PASS**（maxBuffer + 截断标记） |
| Workshop test.run policy | **PASS**（勾选 = 可请求；执行仍需审批） |
| Smart Project test.run policy | **PASS**（request-only grant + approve-once，不静默执行） |
| Continuity pending approval behavior | **PASS**（等待审批不 rollover；Checkpoint 只记引用，不继承权限） |
| Extension Process Host | **PARTIAL**（契约 + 帧协议完成；真实进程沙箱按计划不在本轮） |
| Capability Broker | **PASS**（fail-closed + 本轮三层模型） |
| Workspace Boundary | **PASS**（traversal/junction/敏感路径既有覆盖不回归） |
| Memory Cross Scope | **PASS**（显式授权既有覆盖不回归） |

## NOT_RUN_ENVIRONMENT

- 真实 Provider（DeepSeek/OpenAI 官方端点 + 真实 Key）回合
- 真实 QQ（SnowLuma）全模式链路
- 跨设备 Device Mesh 真链路
- 代码签名 / 干净 Windows VM 人工走查

## Conclusion

- `test.run` 权限模型已完成"三层同时满足"收口：默认不可执行、grant 只能请求、
  每次执行需 Owner Approve Once、replay/篡改/过期/跨工作区全部拒绝、
  写后执行攻击被审批边界拦住、等待审批期间不 rollover、审批不随 Session 继承。
- RC 在最终代码状态上干净重建（`1.0.0-rc.1+d4c9395`，dirty=false）并全项验收通过。
- 建议下一步：Owner 确认后合并 `fix/agent-test-run-security` 到 main 并推送；
  真实用户测试阶段可直接使用本 RC（未签名会有 SmartScreen 提示）。
