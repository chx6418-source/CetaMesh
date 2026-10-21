# 本轮模块通信矩阵

范围：COMM-01～13；此表是当前实现与本地验证边界，不能推导所有外部环境已联通。

构建验证时源码：codex/comm-01-13-repair，HEAD 63f6155718e4ef7cbc182bd6b4debcde0f1faeb1 + 当时未提交修复；1.0.0-rc.2 / DEV Build1113。源码指纹及最终测试结果见 COMMUNICATION_REPAIR_REPORT.md；后续 Owner 已授权 Git 集成，不改变上述 DEV 包历史来源。

|入口 / 调用方|接收方 / 返回与事件|请求、回合身份|权限 / 审批|取消|重启 / 关闭|
|---|---|---|---|---|---|
|Harbor → Rust WebView|Owner IPC → UI service|200 字符以内 request id，来源/方法白名单|Owner token 仅 Host/Core 持有|断线只中止观察；显式停止单独调用|新请求在 stopping 时拒绝；自有连接关闭后释放所有权|
|Chat → Model Runtime|Provider stream → Chat 持久化 → bus|sessionId/requestId/turnId/messageId/historyRevision|平台身份不来自模型输入|Chat Stop/operation signal；不宣称撤销已完成工具|事件 gap/Core 重启刷新权威快照|
|Task → Managed Agent|Broker → Session send/follow → Task reports|Task/Workspace/Provider/Session/runId/phase|实时 grants、授权代次、原请求指纹|Task 暂停/取消同时取消本任务审批操作|waiting 不计终态；已投影回合身份在有界游标缓存中去重|
|模型工具调用|Coordinator → Capability Broker → 实际 adapter|稳定 tool requestId；本回合 manifest|递归拒绝 authority keys；目标 Schema；派发前重新授权|校验期间取消不派发；结果未知禁止重放|现有 dispatch journal；未知副作用待核验|
|Owner 审批|UI decide → capability operations → Broker → 恢复目标|approvalId 派生唯一 operationId；批准决定固定|v2 approval binding；授权代次/分配/Workspace/grants/输入/descriptor version|接受前取消无执行；已派发只报告已确认取消或 unknown|持久化操作状态；运行中重启转 unknown，不自动重发|
|平台 test.run|Capability → Controlled Test Runner → 自有进程树|Task/Workspace/requestId|每次 Owner 审批；原 allowlist 与最小环境保留|预取消无 spawn；Windows PID 树/POSIX 独立进程组；等待 close|无法确认树终止则 unknown；其他任务不受影响|
|Integration/MCP 工具|包装 capability → 实际注册工具 → MCP transport|目标 toolId/inputHash/schemaHash|外层严格；仅嵌套 input 有界开放；风险 capability 必须匹配目标|signal 仍归既有 Broker/执行器；未知结果不伪报成功|执行前复核开关/当前 Schema；fixture 只替换末端 transport|
|插件中心 → Extension|审核安装 → descriptor → Worker|review token/package/manifest/grants/version|安装审核不变；能力按当前受管包重新验证|版本切换先关旧 Worker；在途旧绑定不能执行新版本|启用插件重启恢复目录、Worker 懒启动；删除能力同步移除；回滚恢复契约|
|Harbor 集成本地动作|Integration 管理 capability → 固定 QQ/Bionic action|固定 localService/action；参数不能改 actor/method/路径|现有高风险管理审批；不暴露 Legacy 控制面|stop 对应自有 Connector/Bionic；不停止独立网关|默认 createCetaMeshServices 已接线；构造只查 health，不自动登录/启动|
|QQ Connector → Core Channel|身份/账号规范化 → delivery journal → 独立消费者|channel/account/external user/session/message/event 分离|外部 QQ 身份不成为 Owner；白名单/消费者授权保留|继承既有账号租约、发送账本与 unknown 机制|账号锁与 Legacy 互斥不重写；异常接管保持既有 fail-closed|
|Core → QQ Connector|统一发送执行器 → OneBot → 回执/事件|requestId/accountId/message kind/target|能力/审批/白名单/附件检查均保留|超时 unknown；不会自动认为 failed 或盲目重发|沿用持久发送账本；真实 OneBot 未运行|
|Channel → Harbor|最小 channel.message/channel.delivery DTO → UI bus|accountId/channelId/eventId/messageId/requestId|白名单字段，无原始对象或 token；界面按当前账号过滤|只展示状态，不触发外发|账号变化清空局部活动视图；不混入另一会话正文|
|Core ↔ QQ/Bionic 子进程|有界 JSONL process link|version/id/method|继承管道，不是新的 Owner IPC|close 幂等，一次收敛所有 pending|单帧（含换行）/尾部/读写队列分别限额；UTF-8 严格解析|
|UI event bus → IPC → typed-client|UTF-8 字节预算分页 / gap reset|实际最后一条事件 cursor|仅显式事件和字段；最大 id 转义开销纳入预算|断线后重订阅，不取消已接受操作|超大合法流分片；历史双向分页；Harbor 跟随 forward continuation 并逐页检查 epoch；恶意单项受控拒绝|
|已配对 Mesh → HTTPS|恢复已存 TLS/稳定端口 → signed envelope|node identity/trust/TLS pin/endpoint|仅已启用且有既存可信配对；业务执行器未注入仍拒绝|临时 suspend 撤销邀请并关闭监听，终态 close 禁止再次开启|重启/重新启用无需新邀请；邀请过期/取消不切断可信通信；端口冲突可诊断；关闭后 MESH_CLOSED|
|Core/Legacy 退出|统一 bounded lifecycle → 子系统清理 → owner 最后释放|单一稳定 shutdown Promise|不扫描杀用户独立程序；不强制释放未知锁|等待自有资源结束；超时/失败明确报告|未知清理保留真实活跃 owner，阻止 stale-PID 错误接管|

## 验证分层

- `VERIFIED_FIXTURE`：真实生产模块/装配，合成模型、隔离文件与账号标识。
- 本地进程/协议实测：实际 Windows 子孙进程、Node SEA、原生 Host、JSONL/IPC、TLS socket。
- `VERIFIED_RELEASE_INTEGRATION`：仅指显式 DEV 包的隔离安装版集成，不等于干净源码正式 RC 验收。
- `NOT_RUN_ENVIRONMENT`：真实 Codex↔DSH↔Managed 交接、真实 QQ、手机—桌面、Owner 实际 Harbor 账号操作。
