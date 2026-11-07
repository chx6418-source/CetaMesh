# DSH 连接与预设兼容边界

CetaMesh 通过已有 Core DSH connector 连接独立安装的 DSH，不安装、升级或启动第三方服务。当前适配依据旧版 `0.1.5-rc.1` 的实际接口与官方 [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) 的公开协议；新版源码参考固定为 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。包版本、服务可达、协议兼容与工具授权是独立事实。

## 当前接口

| 接口 | 生产者 → Core 消费者 | 兼容规则 |
| --- | --- | --- |
| `settings/describe`, `session/list` | DSH API Gateway → DSH Provider health/status | 保留 Typert `client-request/server-response` envelope；Session 列表须包含 `items` 及明确的 `sessionId/running`，HTTP 成功但 schema 不明不能标记兼容 |
| `agentPresets/list`, `agentPresets/read` | DSH preset registry → Core catalog/preset policy | 不要求旧版 `trust` 元数据；只读文档必须返回与请求一致的 `agentPreset` 及有界 YAML 内容。新版 `broken?: string` 表示加载失败；非法字段类型不当作健康证据 |
| `session/modelCatalog`, `session/selectModel` | DSH model configuration → Provider model control | 保留现有目录与精确 `selected` 回执；模型与 reasoning 不从预设名猜测 |
| `session/create`, `session/prompt` | Core Provider → DSH Session | 保留命名参数 `request`、显式所选 `agentPreset` 与现有内容块协议；不自动采用 DSH 默认预设 |
| `session/follow` | DSH `/api/remote.mux` → Core follow hub | 保留 open/item/end/error/cancel framing、snapshot 的 durable records/cursor/projections 与 `surfaceOp`；新增只读 API 不替换已验证的 follow 路径 |
| `session/cancel`, `workspace/archiveSession`, resume | Core lifecycle → DSH | 取消请求不证明停止；归档不证明进程停止，亦不保证从列表消失。Resume 查现有 Session，不因不存在而新建 |

HTTP/WebSocket 合成 peer 覆盖两种版本的上述公共接口，不等于已在新版真实模型与原生工具上验收。旧版不提供的 `session/state`、`session/projections` 不是该公共路径的必要条件；不向不存在的接口重放写请求。

Provider 关闭同时拥有尚未完成的创建操作。预设校验与远端创建返回后均重新检查关闭状态；远端创建结果不明时保留 pending 归属及暂存目录。只有取消后读取到唯一同 ID、`running:false` 的 Session，才可报告停止并清理；缺项、重复 ID、仍在运行或单纯 archive/close 回执均不替代停止证明。关闭等待有界，`PROVIDER_CLOSE_UNKNOWN` 保留后续核验所需的记录。

新的创建请求若返回已归属的 Session ID，报 `DSH_SESSION_ID_CONFLICT`。它不会修改旧会话的模型、Task 绑定或暂存目录，也不会把旧会话当作新请求的清理对象。新请求的未知结果继续保留，后续唯一 ID 的合法请求仍走原创建流程。

## 预设发现与明确选择

本机 `.agent-presets/<id>/agent.cordis.yml` 与 authenticated `agentPresets/read` 复用同一有界 persona parser。预设 ID、`trust`、默认标记以及 persona 格式均不授予工具权限。目录读取仅用于发现；Owner 在执行器页面选择任务预设并保存，配置按原有版本化连接文件持久化，当前 Core generation 及其 Session 保持原配置，重启 Core 后采用待生效配置。

`local-persona-only` 仅表示本机 persona 格式；绑定真实 connector 时，同名本机文档还必须与 DSH 实际返回文档的 SHA-256 指纹一致。健康检查及最终 Session 创建均校验该绑定，避免用同名本机文件为不同的系统预设背书。已有本机预设执行与 staging/import 路径保留，仍须接受现有 Task、Workspace、Broker 与审批检查。

Windows 的 home 路径仅大小写不同时，还须核对实际目录的非零设备及文件身份一致。大小写敏感目录中的不同对象、不同目录及其他 junction 别名不能共享原连接的预设或凭据范围；异步保存仍检查配置 revision，不能覆盖并发的新选择。

原生系统预设可被发现、读取、校验格式并由 Owner 显式保存，标记为 `native-persona-only`。这类预设没有本机受控工具边界时，Task Provider 返回 `taskEligible: false` / `native-tool-policy-unverified`，创建 Task Session 以现有 `AGENT_BOUNDARY_UNSUPPORTED` 拒绝。UI 同时说明可使用现有 Core 默认模型或已就绪的其他执行器。

## 原生工具的协议限制

官方 [approval request](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/approval.md) 通过 `callId` 引用已记录的工具调用。原生 `tool/call` 的工具名与完整原始 arguments 在 prepare/审批前提交；PTC 的 `tool/ptc-dispatch-start` 同样先记录 exact normalized arguments。正式 `$events` / `$events/result` waterfall 可传回应答。审批消息没有重复携带参数，不代表整个协议无法取得完整输入。

当前 Agent Provider 尚未把这些记录按 Session/callId 与 Core NativeApproval 的执行生命周期关联。并且 `approval.policy: ask` 只处理已经要求审批的操作，工具 pre-execute 默认允许；该选项不强制每个工具都询问 Core。Gateway 把问题发给所有 owner Client，首个 result 完成决定，当前连接也不能保证 Core 是必经的审批者。因此原生 Task 工具边界仍未验证，保持执行拒绝。接入需验证完整且唯一的调用关联、每工具的必经检查、其他客户端答复无法绕过 Core、取消及未知效果恢复。

新版仍提供 [`tools.restrict` 与 `tools.guard`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/README.md)，也提供 scoped `tools/pre-execute` 扩展点。这些是实现受控适配的可用基础，当前 connector 尚未部署对应的 Task 绑定执行约束，亦没有现成的通用 Task MCP 文件工具桥。仓库已有 QQ 社交工具白名单不能替代 Task 的路径、审批和效果账本。公开的模型服务是 Host 内部 `ctx.llm` 插件 API；当前适配未发现可直接供 Core Managed loop 使用的已发布 raw model HTTP endpoint。未来若补桥，必须另行证明逐 Task 作用域、完整参数、审批、取消与未知效果恢复；不能通过全局 host MCP 或宽 namespace 放行来演示成功。

## 回归入口

使用根测试入口：

```sh
npm test -- --suite test-dsh-setup --suite test-dsh-connector-m3 --suite test-dsh-model-selection --suite test-agent-provider
npm test -- --suite test-agents-page-ui
```

`test-dsh-setup` 导入 owned synthetic HTTP/remote.mux helpers，覆盖旧/新 roster、精确文档绑定正反例、异常与损坏 schema、显式选择保存、本机正例与原生工具拒绝。UI suite 的浏览器执行取决于环境开关与可用浏览器；真实 DSH 模型、收费 API 和新版原生工具验收须单独记录，不能从 fixture PASS 推导。
