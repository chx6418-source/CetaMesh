# TOOLS / MCP / PLUGIN RESTORATION REPORT — CetaMesh 1.0 产品化任务 B

> 分支：`feature/tools-mcp-plugin-restoration-v1`（基线 `main` @ `ce83264`，工作分支在本会话开始时创建）
> 目标：让"以前能用、现在大量不可用"的 MCP 工具重新可控可用；给 Tools / MCP / Plugin / Integration 一个统一产品入口；
> SnowLuma、DSH 以 Integration Plugin 形式出现在插件管理，但**底层架构不变**。
> 历史审计产物：[`LEGACY_TOOL_INVENTORY.md`](LEGACY_TOOL_INVENTORY.md)（90 条历史条目，逐条带 commit / 路径取证）。

---

## 0. 结论摘要

1. **"工具消失"是误判，不是源码删能力。** 全历史（170 commits / 全部 refs）审计结论：QQ MCP 工具**只增不减**——`906f919` 36 个 → `9c00595` +2（卡片读取）→ `756925f` +2（卡片按钮/审批），当前 `src/mcp-snowluma-safe.js` 仍是 **39** 个，没有任何 `qq_*` 被删除或改名。
   真正的问题是：**没有统一的挂载/发现/开关入口**，加上若干工具被**服务端安全开关**默认关闭（`qq_click_card_button`、`qq_set_sticker_remark`）、以及 preset 白名单放行了**并不存在的视觉 provider**。
2. 本轮交付：统一 **Plugins（Installed / Tools / MCP / Integrations）** 产品层 + **Tools Registry** + **MCP Registry/Runtime**，并建立 `integrationService`，把全部工具调用与全部管理动作**接入 Capability Broker**（不绕过、不短路、不伪造成功）。
3. SnowLuma / DSH 以 **Integration Plugin** 卡片呈现：SnowLuma 底层仍是 **Channel Provider**，DSH 底层仍是 **Agent Provider**；插件页只是 安装/配置/启动/状态/说明 的统一入口，**没有**把 DSH Agent Provider 塞进 VM Extension。
4. 恢复口径（不为了"工具数量"降安全）：**46 个默认恢复可用**、**5 个 partial（默认关闭、Owner 需逐项显式开启）**、**2 个明确 Disabled / Legacy Unsupported（进程控制）**、**8 条历史下线条目（不进 Registry，只做对账）**。
5. 本会话**未**改动任何 MCP Server 实现、**未**改 DSH preset、**未**绑定 `channel.send` 真实传输、**未**新造 plugin runtime（复用既有 Extension/ProcessExtensionHost/Review/Capability/Update/Rollback/CrashRecovery），**未**设计最终 UI（只提供稳定的 IPC/service 契约）。

---

## 1. 历史工具总数 / 已恢复数 / 废弃数 / 安全原因不能恢复数

### 1.1 审计口径（详见 LEGACY_TOOL_INVENTORY.md）

| 指标 | 数量 |
| --- | --- |
| 历史工具 / 能力条目总数 | **90**（64 个工具条目 + 26 个 Capability / 扩展能力条目） |
| 当前仍有实现 | **83**（HEAD 51 MCP + HEAD 23 Capability；侧分支 Task MCP 6；扩展能力 3） |
| 当前可调用（默认配置，HEAD，DSH 已挂载 5 个 MCP） | **50**（MCP 47 + 扩展能力 3） |
| 建议恢复（审计） | **0 无条件**；**8 有条件 partial**（侧分支 Task MCP 6 + snowluma-host 进程控制 2） |
| 建议废弃（审计） | **2**（`query_action`、`invoke_action`） |
| 因安全原因不能恢复（审计） | **3**（`invoke_action`、`cetamesh_task_process_run`、`channel.send` 真实发送传输） |

### 1.2 本分支实际落地口径（Tools Registry 事实）

| 指标 | 数量 | 说明 |
| --- | --- | --- |
| 纳入统一 Tools Registry 的工具 | **53** | 51 个 MCP 工具（5 个 server）+ 2 个 Agent Provider 侧视觉工具 |
| 已恢复（`restored`，默认开启） | **46** | 安全默认即可用（仍受来源可用性/白名单/审批约束） |
| 有条件恢复（`partial`，默认关闭） | **5** | `qq_click_card_button`、`qq_set_sticker_remark`（服务端安全红线默认 false）、`qq_send_file`（读本地任意路径 + 外发）、`read_image`、`describe_image`（白名单放行但仓库内无实现） |
| 明确 Disabled / Legacy Unsupported（`legacy-unsupported`） | **2** | `start_snowluma`、`stop_snowluma`（`process` 属 FORBIDDEN_PERMISSIONS；进程控制保留在控制台本地服务入口） |
| 历史下线条目（不进 Registry） | **8** | `query_action`、`invoke_action`（外部包 `@snowluma/mcp`）+ `cetamesh_task_*` 6 个（未合并侧分支 `9391bb8`） |
| 其中：废弃（`deprecated`） | 6 | `query_action` + 5 个 Task 工具（未合并，需要评审后重新接线） |
| 其中：安全原因不可恢复（`legacy-unsupported`） | 2 | `invoke_action`（任意 OneBot 写动作）、`cetamesh_task_process_run`（任意进程执行） |

> 对账说明：审计的"90 条"包含 Capability 与扩展能力，不等于工具数；本分支的"53"只统计**当前 HEAD 真实存在、可被调用**的工具。
> 二者通过 `src/integrations/catalog.js` 的 `LEGACY_RETIRED_TOOLS`（8 条带取证的历史下线条目）显式对齐，且测试断言它们**不得**混入活动 Registry——不为凑数凭空创造工具。

---

## 2. 概念分离（Tool / MCP Server / Plugin / Integration）

底层四概念严格分离，产品层统一收进 **Plugins**：

| 概念 | 定义 | 代码位置 |
| --- | --- | --- |
| **Tool** | 一次可调用的原子动作：`id / name / description / source / schema / risk / enabled / available / lastError` | `src/integrations/catalog.js` + `registry.js` |
| **MCP Server** | 提供若干 Tool 的独立 stdio 进程：`id / name / transport / status / tools / permissions / source / lastError` | `mcp-runtime.js` + `MCP_SERVER_CATALOG` |
| **Plugin** | 安装/配置/状态/开关的统一挂载单位（parent toggle） | `allPluginDescriptors()` |
| **Integration** | 把**既有底层 Provider** 以插件卡片暴露：SnowLuma=Channel Provider、DSH=Agent Provider | `pluginDescriptors()` 的 `cetamesh-snowluma` / `cetamesh-dsh` |

产品层顶层分类（普通用户只面对这一层）：`Installed` / `Tools` / `MCP` / `Integrations`。
Tool Source 取值：`builtin` / `mcp` / `extension` / `agent` / `channel`（`origin` 另记"随产品内置 / 外部安装"）。

---

## 3. SnowLuma / DSH：Integration Plugin，但不破坏底层架构

| 集成 | 插件 id | 形态 | 底层（未改变） | 插件页职责 |
| --- | --- | --- | --- | --- |
| SnowLuma | `cetamesh-snowluma` | `channel-integration` | **Channel Provider**（`src/channel/**`，`channel.registry`） | 安装/配置/启动/停止/状态/说明的统一入口 |
| DSH | `cetamesh-dsh` | `agent-integration` | **Agent Provider**（`src/agent/dsh-agent-provider.js` / `managed-agent-provider.js`） | 安装/配置/启动/停止/状态/说明的统一入口 |

- 描述符携带 `provider: { kind, id }`、`bottomLayer: 'channel-provider' | 'agent-provider'`、`localService`（`snowluma` / `dsh`）与 `advanced.providerKind`，并在测试中断言 **kind ≠ extension**。
- Provider 未接入时如实 `available=false + lastError`（fail-closed），不伪造"已就绪"。
- 本地服务动作（启动/停止/检测/安装/连接）经 `integrations.action` → `integration.mcp.manage`（**high**，需 Owner 显式确认）→ 复用的 `local-services` 本地服务入口；未绑定时 `UNSUPPORTED_ACTION`。
- **没有**把 DSH Agent Provider 塞进 VM Extension，也没有把 QQ SDK 引入 Core composition（`test-composition-boundary` 通过）。

---

## 4. CetaMesh 仿生聊天工具包（Integration Plugin）

- 插件 id：`cetamesh-bionic-chat`（`kind: 'tool-pack'`，`category: 'tools'`），版本 1.0.0。
- 内容 = 历史仿生聊天实际用过的、且**当前仍然存在**的 MCP/内置工具：snowluma 39 + qq-file-send 5 + web-search-safe 2 + bilibili 2 + snowluma-host 3 + DSH 视觉 2 = **53**。
- 二级设置页契约（`plugins.settings`）：
  - **总开关**（parent toggle）；
  - 每个工具一行：**名称 / 用途 / 权限 / 风险 / 状态（enabled·available·restore）/ 单独开关**；
  - **Advanced 默认折叠**：transport / entry / managedBy / namespace / 持久化覆盖项 / 失败细节。
- 开关语义（测试锁定）：
  - 总开关关闭 → 级联全部工具 `enabled=false`；
  - 逐工具开关独立生效并**持久化**（经 `src/storage/json-file.js`）；
  - **一键全开只恢复 `restored`（安全默认）**；`partial` 必须逐项显式开启；`legacy-unsupported` 永远 Disabled；
  - MCP Server 卡片上的工具列表是**只读视图**（避免两套开关打架）。
- `plugins.allowlist` 输出当前允许调用的工具全名（46 个），供 DSH preset / agent 侧白名单后续消费（本轮不改 preset）。

---

## 5. MCP Runtime 与 Registry

- **接上既有 runtime，不重写**：MCP Server 仍是仓库既有 `src/mcp-*.js`（stdio），Runtime 复用官方 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`，只新增统一监督层。
- Registry 字段：`server id / name / transport / status / tools / permissions / source / lastError / enabled / pid / startedAt / restarts / crashes / config`。
- 能力：`list` / `get` / `tools（发现）` / `enable` / `disable` / `start` / `stop` / `restart` / `config.get` / `config.update` / `invoke`。
- 状态机：`stopped → starting → running → stopping → stopped`；异常关闭 → `crashed`（`lastError` + `crashes+1`，工具立即 `available=false`）；禁用 → `disabled`，且 `start/restart` 被 `MCP_DISABLED` 拒绝。
- **工具发现**：运行中返回真实 `listTools()`（`discovered=true`）；未运行时回退目录声明（`discovered=false`），不以目录冒充运行时事实。
- **未知 MCP 工具拒绝**：`mcp.invoke` 对不在目录中的工具直接 `UNKNOWN_MCP_TOOL`；未知 server → `UNKNOWN_MCP_SERVER`；不猜测、不转发。
- **配置更新**只接受白名单键（`args/env/cwd/timeoutMs/note`）与类型校验；**不允许**改 `entry`（防止把 runtime 变成任意脚本执行面）。
- **失败如实上报**：启动失败 → `MCP_START_FAILED` + `status=crashed`；调用失败 → `MCP_CALL_FAILED`；未绑定传输 → `PROVIDER_UNAVAILABLE`。

---

## 6. Tools Registry 统一输出

`tools.list` / `tools.get` 每行固定包含：

`id`、`name`（label）、`description`、`source`（builtin/mcp/extension/agent/channel）、`origin`、`serverId`、`group`、`schema`、`risk`、`capability`、`permissions`、`restore`、`reason`、`enabled`、`available`、`pluginId`、`sourceStatus`、`lastError`（共 20 字段）。

---

## 7. IPC / service 契约（本会话不做最终 UI）

经 `src/app/ipc-runtime.js` 注册四个前缀，全部落到 `integrationService.execute`：`plugins.` / `tools.` / `mcp.` / `integrations.`，共 **26** 个方法：

- `plugins.overview | list | get | settings | enable | disable | tool.toggle | tool.toggleAll | allowlist`
- `tools.list | get | invoke`
- `mcp.list | get | tools | enable | disable | start | stop | restart | config.get | config.update | invoke`
- `integrations.list | get | action`

未知方法仍回落既有控制面（`controlService`），老方法族行为不变（`test-ipc-runtime` 通过）。

---

## 8. 插件生命周期：复用，不重造

| 既有能力 | 本轮如何复用 |
| --- | --- |
| ProcessExtensionHost / Extension Runtime | 扩展型插件仍走 `ext.*`（`ext.install/update/rollback/enable/disable/restart/invoke/logs`）；本轮**没有**新建 plugin runtime |
| Review（安装前审查） | `ext.review` / `ext.rollback.review` 不变；MCP Server 侧只新增"进程监督 + 状态"，不做安装/审查替代 |
| Capability Broker | 所有工具调用与管理动作经 `integration.tool.*` / `integration.mcp.manage` / `integration.plugin.manage` 五个能力 |
| Update / Rollback | 仍由 Extension installer 负责（`ext.update` / `ext.rollback`） |
| Crash Recovery | MCP Server 崩溃按 `crashed + lastError + crashes` 记录并可 `restart`；扩展宿主的心跳/自动重启策略未被改动 |

---

## 9. 安全设计（不为了工具数量降安全）

1. **能力分档**：`integration.tool.read`(low) / `write`(medium) / `admin`(high) + `integration.mcp.manage`(high) + `integration.plugin.manage`(medium)；由风险自动分档（`capabilityForRisk`）。
2. **不绕过 Broker**：`tools.invoke` → 能力 → 适配器；适配器内部**再次**校验开关与来源（防审批期间开关变化）。
3. **审批不可省**：high 风险工具与服务/进程类管理动作在未显式确认时返回 `pending`（Owner Approve Once），确认后才真正执行。
4. **未知即拒绝**：未知工具 / 未知 MCP 工具 / 未知 server / 未绑定传输，全部 fail-closed。
5. **Legacy Unsupported 硬禁用**：`setToolEnabled` 对不可恢复工具直接 `LEGACY_UNSUPPORTED`；批量开关也会跳过并保留 Disabled。
6. **不新增裸 catch**：`test-error-hygiene` 通过（基线只减不增）。
7. **旧工具若触 fs/network/process**：`qq_send_file`、`qq_read_local_audio`、`qq_search_local_audio` 等以 `partial`（默认关）或 `admin` 审批承接；`process` 类（start/stop_snowluma）直接 Disabled。

---

## 10. 测试

新增 4 个 suite（已登记进 `scripts/run-all-tests.mjs`）：

| suite | 分类 | 覆盖 |
| --- | --- | --- |
| `test-integration-tool-registry.mjs` | core | inventory 目录完整性、统一输出字段、未知工具拒绝、legacy/partial 语义、总开关与逐工具开关、持久化、agent 白名单、历史下线条目不混入 Registry |
| `test-mcp-registry.mjs` | runtime | MCP registry 字段、配置读取/更新、start/stop/restart、enable/disable、工具发现、crashed 状态、未知 MCP 工具拒绝、启动失败如实上报 |
| `test-bionic-chat-plugin.mjs` | security | 插件卡片与二级设置页、总开关/逐工具开关/一键全开、Capability 强制（关闭/不可用/未知/agent 未授权/external）、高风险审批链、持久化 |
| `test-integration-descriptors.mjs` | architecture | SnowLuma/DSH 集成描述符（≠ VM Extension）、底层未接入 fail-closed、本地服务动作绑定、四族 IPC 路由、容器装配与 5 个能力注册 |

结果（本分支最终状态）：
- 分类运行 `core + architecture + security + runtime`：**PASS 61 · FAIL 0 · NOT_RUN_ENVIRONMENT 0**（含全部既有套件，无回归）。
- 全量运行（80 suites）：**PASS 76 · FAIL 0 · NOT_RUN_ENVIRONMENT 4**（4 项均为既有的真实环境依赖：`test-console` legacy-bridge、`test-mcp-exec`/`test-onebot-connection` gateway、`test-mcp-web-search` network；按仓库口径如实记 NOT_RUN_ENVIRONMENT，不计失败）。

> 说明：本机 `npm.ps1` 被执行策略禁止，故用等价的 `node scripts/run-all-tests.mjs` 运行统一入口（同一脚本、同一分类/汇总逻辑）。

---

## 11. 文件变更清单

新增：
- `src/integrations/types.js`（概念/常量/错误）
- `src/integrations/catalog.js`（MCP server + 53 工具 + 插件描述符 + 8 条历史下线条目）
- `src/integrations/store.js`（唯一经 `src/storage/json-file.js` 的持久化）
- `src/integrations/registry.js`（Plugins/Tools/MCP 三表推导与开关语义）
- `src/integrations/mcp-runtime.js`（MCP 生命周期 + 发现 + 调用，复用官方 SDK）
- `src/integrations/service.js`（IPC 契约 + 能力注册 + 管理动作 + 工具执行适配）
- `src/integrations/index.js`
- `scripts/test-integration-tool-registry.mjs`、`scripts/test-mcp-registry.mjs`、`scripts/test-bionic-chat-plugin.mjs`、`scripts/test-integration-descriptors.mjs`
- `LEGACY_TOOL_INVENTORY.md`、`TOOLS_MCP_PLUGIN_RESTORATION_REPORT.md`

修改：
- `src/app/service-container.js`（装配 `integrationService`）
- `src/app/ipc-runtime.js`（四个路由前缀）
- `src/app/bootstrap.js`（退出时先停止 MCP 子进程）
- `scripts/run-all-tests.mjs`（登记 4 个 suite）
- `CAPABILITY_COVERAGE.md`（新增 Plugins/Tools/MCP 能力覆盖行）

未改动（有意）：`src/mcp-*.js`、`dsh/agent-presets/**`、`src/capability/service.js`、`src/extension/**`、`src/channel/**`、`src/agent/**`。
工作树中原有的一处与本任务无关的未暂存删除 `assets/project-intro.mp4`（非本会话产生）保持原样、未提交。

---

## 12. 最终验证

- 分类运行（core/architecture/security/runtime）：**PASS 61 · FAIL 0 · NOT_RUN_ENVIRONMENT 0**。
- **最终全量**（`node scripts/run-all-tests.mjs`，80 suites，退出码 0）：**PASS 76 · FAIL 0 · NOT_RUN_ENVIRONMENT 4**
  （`test-console`[legacy-bridge]、`test-mcp-exec`[gateway]、`test-onebot-connection`[gateway]、`test-mcp-web-search`[network] —— 均为仓库既有的真实环境依赖项）。
- 新增 4 个 suite 全绿；`test-composition-boundary` / `test-service-container` / `test-ipc-runtime` / `test-error-hygiene` / `test-capability-coverage` / `cargo:check` / `cargo:test` 均无回归。
- 未 push、未合并 `main`（等 Owner 确认）。

## 13. 已知边界与下一步（不静默）

1. **UI 未做**：本会话只提供 IPC/service；插件页/二级页的最终视觉与交互留待产品 UI 会话。
2. **DSH preset 未改**：`plugins.allowlist` 已产出 46 个允许工具，但 `qq-tool-restrict.mjs` 仍按原前缀白名单工作；把逐工具开关真正传导到 agent 侧需要在 preset/网关侧读取该 allowlist（下一会话）。
3. **Agent 侧 MCP 调用路径**：QQ agent 仍经 DSH MCP 客户端直连 MCP Server（`CAPABILITY_COVERAGE.md` 的 "Direct by design"）。本轮的 Broker 强制覆盖桌面 Owner 路径与未来的服务面调用；若要覆盖 agent 直连路径，需要在 MCP Server 内部或 DSH 工具守卫处接入同一注册表。
4. **侧分支 Task 工具**（`cetamesh_task_*`，6 个）与 `process_run`：本轮登记为历史下线条目，未恢复；恢复需评审并遵守 `FORBIDDEN_PERMISSIONS`。
5. **视觉工具**（`read_image` / `describe_image` / `vision_*`）：preset 白名单放行但仓库内无实现，标记 `partial` 默认关闭；需确认 DSH 侧视觉 provider 是否真实挂载。
6. **真实环境未跑**：本轮的 MCP 生命周期用注入的传输工厂验收；真实启停 5 个 MCP Server 需在带 SnowLuma/DSH 的机器上按 `NOT_RUN_ENVIRONMENT` 口径单独验收。
7. 分支策略：按 AGENTS.md，完成 → Owner 确认 → 合并 `main` → 删除工作分支（本分支尚未合并、未 push）。
