# Agent / 外部协议兼容与能力矩阵

核对日期 2026-10-18；源码基线 `1aa5a85`。`installed` 表示发现本机组件，`compatible` 表示**所用方法和 Schema**经目标版本验证，`authenticated` 表示当前凭证可用，`sandbox` 表示目标执行边界实测。任何一项未知均记 `UNVERIFIED`；下列 `readyFor*` 只有相应真实环境与权限测试通过才可置 `VERIFIED`。模板中的 null 版本绝非通配符。

| Profile | 实际版本及证据 | installed | compatible | authenticated | sandbox | readyForChat | readyForReadTask | readyForWriteTask | readyForResumeTask |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex exec JSONL（现用） | 本机 `codex --version` = `0.163.0-alpha.10.2`；`--help`/`exec --help`/`exec resume --help` 显示现用关键 flags；`src/agent/codex-agent-provider.js` 以 `exec --json` 和 staging root 调用；本轮没有真实 turn | VERIFIED | UNVERIFIED（CLI flags 可见，事件 Schema hash/真实响应未锁） | UNVERIFIED | UNVERIFIED（源码有受限配置和 staging；缺本机真实运行验收） | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Codex app-server stdio（候选） | 同一 CLI `0.163.0-alpha.10.2` 可执行 `app-server generate-json-schema`，本轮生成 318 文件/3,629,800 字节的 Schema 包；当前仓库无 app-server Adapter/握手 | CLI VERIFIED，服务能力 UNVERIFIED | UNVERIFIED（只验证 Schema 可生成，未建本机连接） | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| DSH Session API / remote.mux（现用） | `dsh --version` = `0.1.5-rc.1`；`src/dsh-client.js` 调 `session/create,prompt,cancel,list,follow` 等；完整安装 Schema 未导出 | VERIFIED（CLI） | UNVERIFIED（端点存在的历史证据不能替本机合同） | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| ACP | 没有现用 ACP Adapter 或对端版本握手 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| MCP SDK / 工具 | `npm ls` = `@modelcontextprotocol/sdk@1.30.0`；本地 Runtime 调 `Client.connect/listTools/callTool`；未记录本轮协商 protocolVersion | VERIFIED（SDK） | UNVERIFIED（各 Server 单独协商） | UNVERIFIED | N/A（工具由 Core grant 决定） | N/A | N/A | N/A | N/A |
| OneBot / SnowLuma Channel | `npm ls` = `@snowluma/sdk@1.14.9`；`src/channel/registry.js` 标 OneBot v11；实际网关版本和握手未核对 | VERIFIED（SDK），网关 UNVERIFIED | UNVERIFIED | UNVERIFIED | N/A | N/A | N/A | N/A | N/A |
| Extension Runtime | 仓库内 `src/extension/service.js`，本轮不把它当 Agent 协议 | IMPLEMENTED | method-level fixture only | Core 审批/权限入口见台账 | 受限 Runtime，真实宿主逐扩展验证 | N/A | N/A | N/A | N/A |

## 证据分层

本机 app-server Schema 归档：[codex-app-server-0.163.0-alpha.10.2-schemas.zip](protocol-evidence/codex-app-server-0.163.0-alpha.10.2-schemas.zip)，SHA-256 `C74FDE73C403D57DE35804ED2747BBDF76E8E7DC57A82333DCFA6AED45A0E78F`。生成命令只用了当前 CLI 的 `generate-json-schema --out`，未启用实验字段或运行服务；归档哈希是产物证据，不是原生兼容 PASS。

- **现有已实现**：Codex exec JSONL Adapter、DSH HTTP/remote.mux Adapter、MCP 工具客户端、OneBot Channel 和 Extension Runtime。`AgentProvider` 的方法实现与功能可见性由 `src/agent/agent-provider.js` 的 `supported/unsupported` 给出，不等同环境 readiness。
- **测试已验证**：`scripts/test-new-audit-critical.mjs` 与 `scripts/test-agent-provider-expansion.mjs` 覆盖 Codex fake CLI 事件多订阅/重放；`scripts/test-dsh-integration.mjs` 等为 fixture/API 逻辑。测试结果记录于 `AGENT_PROTOCOL_CONFORMANCE_REPORT.md`，不把 fixture 写成真实协议认证。
- **协议缺口**：各原生 profile 缺可复现 schema hash、版本变更失效规则、每方法的正式 DTO/错误码表；Codex app-server/ACP 尚未接入；DSH coding/social preset 的安装版本兼容未证实；MCP 协商版本及 OneBot 实际网关 profile 未记录。
- **建议变更／需 Owner 审批**：新增持久 Core Journal、统一 Run 身份和状态机、旧 `agent.*` 与新内部 RPC 的双版本迁移、默认 profile 切换。任何能力升级都要重新核验 grant、隔离与取消语义。
- **真实环境未验证**：本轮没有登录/启动真实 Codex Agent Turn、DSH Session、MCP 外部 Server 或 SnowLuma 网关；`--version` 与锁定 npm 包只能证明发现/安装，不证明 authenticated 或 readyForTask。
