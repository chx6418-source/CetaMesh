# CetaMesh Desktop — Capability Coverage（v2 hardening, 2026-10-05）

唯一裁决点：`src/capability/broker.js`（policy fail-closed：未知 capability →
`UNKNOWN_CAPABILITY`；未知 permission → `UNKNOWN_PERMISSION`；external/device
caller → `PERMISSION_DENIED`；agent 需显式 task grant + workspace 匹配）。
本表逐模块核对"调用路径是否经过 Broker"，并列出本轮（v2 hardening）迁移结果。

状态词表：**Brokered**（注册进 Registry 且经 policy.authorize）· **Adapter（bounded）**
（有限 Adapter 已建，完整目录待后续）· **Direct（by design）**（按安全设计不走
Broker，走自身更严格的边界）· **Deferred**（本轮明确不做）。

## 覆盖矩阵

| 模块 | 能力 / 路径 | 当前调用路径 | Brokered? | Risk | 迁移判定 |
| --- | --- | --- | --- | --- | --- |
| Workspace | workspace.read / write / file.search | Desktop IPC → capabilityService.executeWorkspace → Broker | Brokered | low/medium | 已完成（会话 3） |
| Workspace | workspace.git.status / git.diff / git.commit | 同上（commit 走审批策略；非 owner diff 抑制敏感路径） | Brokered | high(commit) | 已完成 |
| Workspace | workspace.test.run | Owner 路径 → Broker `test.run`；**Agent 路径 → DENY**（见下"Agent"行） | Owner: Brokered / Agent: DENY→Runner | medium | 本轮引入 Isolated Runner（见 Phase E） |
| Workspace | workspace.create | Broker `workspace.create`（幂等恢复 + root 形状校验） | Brokered | high | 已完成 |
| Agent | agent.run（Managed/DSH 会话分配） | Broker `agent.run`（owner-only，task/workspace 绑定，grant 持久化） | Brokered | medium | 已完成 |
| Agent | test.run（Managed Agent 请求） | capability validate 拒绝（TEST_SANDBOX_UNAVAILABLE） | DENY → Brokered Runner | high | **本轮落地**：`test.run` 对 agent 经 Isolated Test Runner（allowlist/env/timeout/output 边界）放行；runner 不可用时仍 DENY |
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
| Desktop | clock.now | Broker `clock.now` | Brokered | low | 已完成 |
| Device | 设备本地能力（进程内桌面本体） | 无独立 device capability 面 | N/A | — | 本机本体不是远端设备；Mesh 对端能力走 mesh/trust.js 授权 |

## 本轮变更（v2 hardening）

1. **新增 `src/capability/adapters.js`**：Channel/Mesh 只读能力（`channel.status`、
   `channel.declarations`、`mesh.status`、`mesh.capabilities`）与 `channel.send`
   校验面进入 Registry。`channel.send` = permission `message.send`、risk high
   （high-risk 审批语义）、target 必须命中注入的 allowlist（与 `config.allow` 同源，
   未配置一律 fail-closed）、text 有界；`sendImpl` 为注入点，本轮不绑定真实传输。
2. **`test.run` 拆分**：Owner 路径保持原 `workspace.test.run`（owner 配置的命令 +
   审批策略）；Managed Agent 的 `test.run` 从"无条件 DENY"升级为"经 Isolated Test
   Runner 的受控执行"（见 `src/workspace/isolated-runner.js`），runner 拒绝的一切
   形态仍然 DENY。
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
