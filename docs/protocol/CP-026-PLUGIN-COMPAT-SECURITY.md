# CP-026 — 复合插件的安全、版本、依赖锁与迁移治理

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED；与 CP-020/021、CP-022/023/024/025 组成一个协议族。**

## 1. 五种独立版本

- **Product Version**：CetaMesh 主程序 SemVer/Build，不决定某插件自动获得权限。
- **Extension Manifest Version**：当前仅 `manifestVersion:1`，新增语法必须经正式 v2 ADR。
- **Plugin Package Version**：每个插件 SemVer，父包/子包分别有自己的版本，不能仅以父版本替代子版本。
- **Composition Protocol Version**：新的 `compositionVersion:1` 侧车；只有启用未来 Resolver 的 Core 能解析；旧产品看到侧车不得自行安装。
- **Capability Contract Version**：某能力的输入/输出/效果契约版本，必须与包版本分离；权限及副作用改变视为破坏性变更。

## 2. 必须生成的锁定摘要（方案）

组合在批准和安装成功后由 Core 写可信 `composition.lock`，至少列出：根和子插件 ID、版本、SHA-256、Publisher（若可验证）、来源、平台、HostMode、依赖边、合约版本、Grant 指纹、审阅时刻、回滚引用。锁只能由 Core 生成/签署或本地可信存储，不接收插件自己附带的伪造 Grant 指纹。

旧版 SHA-256 能证明内容未在传输中变化，**不能证明发布者身份**；正式供应链签名方案需单独实现，不得写“已完成签名验证”。

## 3. 发布、安装、升级、回滚的矩阵

| 场景 | 允许行为 | 禁止 |
|---|---|---|
| 老 v1 单插件安装 | 按现有流程运行，不因新 sidecar 拒绝旧包 | 悄悄解析新增特权字段 |
| 新组合包首装 | 只读展示根与所有子包、版本锁和权限差异，分级审批后 stage | 自动递归下载安装或自动启用 |
| 新增嵌套子插件 | 重建依赖图、风险摘要和契约测试；需新批准 | 子插件继承父插件 Grant |
| 升级子插件 | 验证其 Manifest/合约、反向依赖消费者，影子 staging 后切换 | 用新代码接管旧在途效果 |
| 更新父插件 | 比对树/依赖/Grant/数据出口全量差异 | 静默扩大子树的权限 |
| 禁用/卸载 | 撤销路由，保护已完成工作与私有数据；共享依赖引用计数 | 删除别的根使用的共享组件 |
| 回滚 | 使用已验证旧包和旧版兼容数据读法；迁移可逆时恢复 | 用新版本数据覆盖旧备份 |

## 4. 威胁模型与必须的否定测试

- **Confused deputy**：父拥有读取权限、子拥有网络权限，不等于允许父让子代发受限文件；必须做双方交集及数据接收方审批。
- **Dependency confusion / typosquatting**：本地/市场/内嵌包同名时不能盲目覆盖，按来源+内容 Hash+锁精确验证。
- **Privilege laundering**：A→B→C 不能在 C 处获得 A/B 都没有的权限；拒绝 Actor、Approval、Scope 来自插件输入。
- **Supply-chain swap**：子包/依赖包 Hash 与安装审阅不一致直接拒绝；符号链接、目录穿越、软/硬链接逃逸拒绝。
- **Update takeover**：禁用或升级后陈旧 Host、旧 Event Subscription 和旧授权指纹全部失效。
- **Event recursion**：A 订阅 B，B 又订阅 A 时限制回环、TTL、trace lineage 和消息预算；不能产生自激活死循环。
- **Resource amplification**：递归包和 8-hop 调用预算要分别检查，防止层层扇出绕过根预算。
- **Unknown effect retry**：跨插件外部写操作失败后必须对账，不以失败响应证明未执行。
- **Data leakage**：日志、错误码、Trace、Memory/Artifact 引用、插件更新诊断都必须去敏且有限量。
- **Host boundary**：普通 Process Extension Host 不视为 OS 沙箱，App/OS 的独立高权限边界需要单独评审与真实环境测试。

## 5. Core/API 事实源与责任映射

| 领域事实源 | 现存代码 | 新提案工作 |
|---|---|---|
| 插件 Manifest v1 | `src/extension/manifest.js`, `types.js` | 不修改旧 schema，增加独立 sidecar/未来 v2 |
| 插件互调 | `src/extension/runtime.js`、`src/capability/broker.js` | 强化 DAG、loop guard、上下文/效果对账 |
| 子进程 Worker v1 | `src/extension/process-host.js`, `process-transport.js` | 不改 wire，组合身份和健康投影适配 |
| Memory Pack | `src/extension/memory-pack.js` | 保持纯数据，权限细则不弱化 |
| Core Memory | `src/memory/policy.js`、`types.js` | 新增 plugin owner/namespace 需独立迁移版本 |
| Agent/Task | `src/agent/broker.js`、`src/task/` | 任务/身份关系与调用链追踪，不另造调度服务 |
| 系统 Host | 尚未完整实现 | 后续独立 App/System Host ADR 与 Threat Model |
| 配对/Mobile | `docs/protocol/UNIFIED_PAIRING_V1_1.md` | 不改已有签名握手；新能力单独明确 Grant |

## 6. 发布门禁与风险回退

协议提案先 READ_ONLY + 合同测试；仅通过安全负例并取得用户批准后，才受控启用实际组合安装。无签名信任、环境不具备、OS Host 未隔离、数据迁移不可逆等情况必须标 `NOT_IMPLEMENTED / BLOCKED_ENV`，不能写 PASS。保留 Windows Defender RELEASE HOLD，未经明确批准不执行 Push/Merge/Release。
