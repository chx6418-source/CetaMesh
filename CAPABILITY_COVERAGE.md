# CetaMesh Desktop — Capability Coverage（v2 hardening, 2026-10-07）

**Capability Broker (`src/capability/broker.js`) 是 CetaMesh generic Capability Plane 的权威裁决点。**
新增长期通用 Capability 必须注册并经 Broker policy 授权；未知 capability / permission fail closed，
agent 请求还需 task grant 与 workspace 匹配。Broker 不宣称覆盖所有系统操作路径。

明确的 Direct Exceptions（各自保留更窄的适配器/控制面边界）：
- QQ MCP adapter-specific boundary：白名单、只读子集、风险卡逐次审批，见 `src/mcp-snowluma-safe.js` 与 `RULES.md`。
- Mesh trust/pairing control plane：Owner 明确操作与配对授权，见 `src/mesh/trust.js` 与 `src/mesh/service.js`。

这两项例外不为新增 generic capability 提供先例；任何新通用能力仍必须经 Broker。
本表逐模块核对调用路径，并记录已明确的 Direct / Adapter / Deferred 边界。

状态词表：**Brokered**（注册进 Registry 且经 policy.authorize）· **Adapter（bounded）**
（有限 Adapter 已建，完整目录待后续）· **Direct（by design）**（按安全设计不走
Broker，走自身更窄的适配器或控制面边界）· **Deferred**（本轮明确不做）。

## 覆盖矩阵

| 模块 | 能力 / 路径 | 当前调用路径 | Brokered? | Risk | 迁移判定 |
| --- | --- | --- | --- | --- | --- |
| Workspace | workspace.read / write / file.search | Desktop IPC → capabilityService.executeWorkspace → Broker | Brokered | low/medium | 已完成（会话 3） |
| Workspace | workspace.git.status / git.diff / git.commit | 同上（commit 走审批策略；非 owner diff 抑制敏感路径） | Brokered | high(commit) | 已完成 |
| Workspace | workspace.test.run | Owner 路径 → Broker `test.run`（Owner 点击即显式决定，approved:true）；Agent 路径见下"Agent"行 | Owner: Brokered 直执行 | **high** | final security：risk 升为 high；Owner 直接操作语义保持 |
| Workspace | workspace.create | Broker `workspace.create`（幂等恢复 + root 形状校验） | Brokered | high | 已完成 |
| Agent | agent.run（Managed/DSH 会话分配） | Broker `agent.run`（owner-only，task/workspace 绑定，grant 持久化） | Brokered | medium | 已完成 |
| Agent | test.run（Managed Agent 请求） | 三层同时满足：Grant（= 可请求）+ Permission + **Owner Approve Once**（risk=high → 每次执行必经审批）→ Controlled Test Runner | Brokered + Approve Once | **high** | **final security 收口**：默认 grant 不含 test.run；grant 绝不被解释为"无需审批"；执行的是 Agent 可经 filesystem.write 修改的项目代码——allowlist 只防命令注入，防不了项目代码本身（**This is not an OS sandbox**）；replay / 篡改 / 过期 / 跨工作区全部拒绝 |
| Memory | memory.read / write / link + desktop 管理 | Broker `memory.*`（owner 管理 / agent 作用域写） | Brokered | low/medium | 已完成 |
| Extension | filesystem.* / memory.* / network | 扩展运行时 → Capability Policy（hosts/paths 白名单在 policy 层强制） | Brokered | medium/high | 已完成 |
| Extension | shell / native / download / process | FORBIDDEN_PERMISSIONS 一律拒绝 | DENY（by design） | forbidden | 不迁移（红线） |
| Channel | channel.status / declarations | IPC channel.* 直读（清单声明，无副作用）→ **本轮补齐 Broker 只读 Adapter** | Brokered（新增） | low | 本轮完成（`src/capability/adapters.js`） |
| Channel | message.send（QQ 发送） | QQ/DSH 侧 MCP 工具 + bridge 白名单（`config.allow.groups/private`）+ 工具执行期限制 | Adapter（校验面） | high | 本轮建 `channel.send` 能力（actor/channel/target/allowlist 校验 + risk=high + owner 审批语义）；真实传输**未**绑入（sendImpl 缺省 → PROVIDER_UNAVAILABLE 如实报告），QQ 实际发送仍走原边界（RULES.md）。绑定真实传输属后续 |
| Mesh | mesh.status / capabilities（manifest） | IPC mesh.* 直读 → 本轮补齐 Broker 只读 Adapter | Brokered（新增） | low | 本轮完成 |
| Mesh | pair / trust / grant / disconnect | IPC mesh.*（Owner 桌面操作面；trust.js 授权模型 + approvals） | Deferred | high | 本轮不迁移（Owner 显式操作面已有独立审批 UI 语义） |
| Mesh | remote capability execution | 不存在 | Deferred | high | 等用户批准后再设计 |
| MCP | web.search | Broker `web.search`（provider: mcp-adapter） | Brokered | medium | 已完成 |
| MCP | network fetch（受 SSRF 加固） | Broker `network`（safe-fetch + GET-only + extension hosts 白名单） | Brokered | high | 已完成 |
| MCP | QQ 工具（snowluma-safe）/ host server / bilibili / kugou / qq-file-send | DSH 侧 MCP server（QQ 适配器安全边界，RULES.md 硬边界：白名单、只读子集、审批） | Direct（by design） | high | **不迁移**：这些 server 是 QQ/DSH 适配器的一部分，其安全边界（发送白名单、风险卡审批）比 Broker 更细；迁移会降低边界强度 |
| Plugins / Tools / MCP | integration.tool.read / write / admin、integration.mcp.manage、integration.plugin.manage | IPC `plugins.` / `tools.` / `mcp.` / `integrations.` → `integrationService` → **Capability Broker** → MCP Runtime（stdio MCP Server）/ Agent Provider | Brokered（新增） | low/medium/high | 产品化任务 B：工具恢复不绕过 Broker；legacy-unsupported 工具不入表、不可开启；未知 MCP 工具一律 UNKNOWN_TOOL / UNKNOWN_MCP_TOOL |
| Desktop | clock.now | Broker `clock.now` | Brokered | low | 已完成 |
| Device | 设备本地能力（进程内桌面本体） | 无独立 device capability 面 | N/A | — | 本机本体不是远端设备；Mesh 对端能力走 mesh/trust.js 授权 |

## 本轮变更（final security，2026-10-06）

1. **Agent test.run 权限模型修正**（核心）：
   - 默认 Agent Task Grant **不含 `test.run`**（收敛为
     filesystem.read/write/search + git.status/diff + memory.read）——
     Agent 可以默认修改 Workspace ≠ Agent 可以默认执行 Workspace 代码；
   - `test.run` risk **medium → high**：Agent 请求无论 grant 是否包含，
     一律进入 Owner 审批队列（grant = 可以请求；approval = 这次可以执行）；
   - Approve Once：批准只消费一次（指纹绑定），replay / 载荷篡改 / 过期 /
     跨工作区全部拒绝；拒绝则不执行；
   - Owner 在 Workspace UI 直接点击"运行测试"保持既有直接执行语义
     （Owner 的点击本身就是显式决定）；
   - Smart Project Task 显式携带 request-only 的 test.run grant：
     Agent 请求 → pending → Owner 决定 → 执行一次 → 结果回到 Agent，
     绝不静默自动执行；
   - Workshop 勾选 `test.run` 同样只代表"可请求"。
2. **Continuity 兼容**：Managed Agent 等待审批期间 rollover 被
   ROLLOVER_NOT_SAFE 守卫拒绝（既有安全点）；rollover 的 Checkpoint 记录
   待审批请求的**引用**（approvalId/capability/expiresAt），审批绝不作为
   可继承权限随 Session 交接——新 Session 必须同指纹且未过期才可继续，
   否则重新请求审批。
3. **Runner 定位修正**：`src/workspace/isolated-runner.js` 文件名保持兼容，
   语义明确为 **Controlled Test Runner（受控测试执行器）**，不是 OS 沙箱
   （This is not an OS sandbox）——它执行的是 Agent 可经 filesystem.write
   修改的项目代码，allowlist 只防命令注入；runner 是审批之后的纵深防御层。
4. **测试**：`scripts/test-agent-test-run-security.mjs`（10 组，含"Agent 改写
   package.json 后 test.run 仍需审批"的写后执行攻击 fixture）；
   `test-isolated-runner` 负面扩至 bash/powershell/cmd/python/node/
   npm install|exec/npx/cargo run|build|publish；`test-security-negatives`
   组 6 更新为"危险命令进待审批、Owner 拒绝生效"。

## 上轮变更（v2 hardening，2026-10-05）

1. **新增 `src/capability/adapters.js`**：Channel/Mesh 只读能力（`channel.status`、
   `channel.declarations`、`mesh.status`、`mesh.capabilities`）与 `channel.send`
   校验面进入 Registry。`channel.send` = permission `message.send`、risk high
   （high-risk 审批语义）、target 必须命中注入的 allowlist（与 `config.allow` 同源，
   未配置一律 fail-closed）、text 有界；`sendImpl` 为注入点，本轮不绑定真实传输。
2. **`test.run` 首次拆分**（已被 final security 进一步收口）：当时 Owner 路径保持
   `workspace.test.run`，Managed Agent 从"无条件 DENY"升级为经 Runner 受控执行——
   final security 在此之上补齐"risk=high + 默认 grant 移除 + Approve Once"。
3. **测试**：`scripts/test-capability-coverage.mjs`（6 组）覆盖注册面、只读完成、
   send 正面、五类负面（白名单外/未配置/未知通道/非法 kind/超长 text）、sendImpl
   未绑定如实报告、external actor 拒绝。

## 仍 Direct / Deferred 的理由（记录，不静默）

- **QQ MCP 工具链**：其边界是 RULES.md 定义的适配器硬边界（发送白名单、只读子集、
  风险卡逐次审批）。把这些搬进 Broker 会把"细粒度审批"换成"粗粒度授权"，是边界
  弱化，不是收口。
- **Mesh pair/trust/grant**：已经是 Owner 显式操作 + approvals 队列；经 Broker 再包
  一层不增加安全，只增加路径。远端能力执行出现时（用户批准后）再统一。
- **Mesh remote capability execution**：不存在；本轮不实现。
