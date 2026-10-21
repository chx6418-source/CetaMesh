# WhaleBridge M5-A.2 — 缺失游标的 Epoch 接续设计

## 授权和实现边界

基线 `c04ad381916147eca10eddac2edf5f8f23d0060e`，Build 1081。此文是待审设计；测试原型仅在 `scripts/test-whalebridge-m5-epoch.mjs` 的独立临时根运行。正式 Core/Connector 没有启用新 Epoch，没有新建事件总线、发送账本或迁移引擎。真实执行始终 **REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED**。

两个旧根 `3402041dd63077f1`、`c12a489fa781c9d2` 在已检查来源内仍 CURSOR_UNRECOVERABLE。保留历史原字节、Hash、ID、Scope、Session 关联；不生成旧 cursor，不把缺失解释成零历史或全部处理完毕。

## 1. 新 Epoch 的身份与水位

| 身份/水位 | 定义与隔离要求 |
| --- | --- |
| accountId | 经真实网关认证核验的机器人账号；ownerQQ/群号/目录均不替代它 |
| connector instance / connection generation | 由 Core 管理的连接实例与重连代际；来自受限进程链接，不能接受消息载荷自报身份 |
| epochId | Owner 批准的账号接续版本；不是 Task/Session/native messageId。重启继续同一持久 Epoch，不自动生成新 Epoch |
| 外部消息身份 | 现有 account + target(kind:externalTarget) + native messageId；**不得加 epochId 来重置去重**。若协议存在 ID 重用而无法证明不同消息，隔离冲突，不按内容猜测 |
| Core sequence | 现有 Channel Journal 的追加顺序；是本地持久接收水位，不冒充 OneBot 全历史水位 |
| consumer cursor | Bionic / Task / 其他授权消费者各自的已有 cursor/交付状态；append accepted 不等于处理或外发 completed |
| 旧历史范围 | 起止 UNKNOWN；旧 Social 有界消息缓冲、lastUnreadSeq、Session/卡片缓存都不能证明完整历史 ACK |

Epoch 不使 QQ 外部身份获得 Owner 权限；入站来源校验、白名单、Capability/Approval 和现有发送执行器均保留。自动回复继续以既有稳定 requestId 去重，未核验的旧请求不得生成一个新 requestId 重发。

## 2. 激活门禁与状态机

```text
PROPOSED -> OWNER_REVIEW -> PRECHECKED -> ARMED -> LIVE -> SEALED
                  任一缺证据 -> BLOCKED / QUARANTINED
```

进入 ARMED/LIVE 必须同时具备：绑定具体计划/账号/风险的 Owner 批准；旧消费者与 Social writer 的停止 ACK 和运行身份核验；StateDir/账号/网关租约有效；未知历史发送与未完成审批/导入已核验或明确隔离；真实连接认证、账号和协议能力可核验；既有 Journal/发送账本可读且无损坏；Owner 接受可能遗漏历史的取舍。PID 不存在或 Ready UI 文字不能满足这些条件。

**真实启用前还需实施：** 在现有 Channel Journal 内保存 Epoch 元数据与 admission 绑定，激活记录/首个准入事件需单次原子持久化或可恢复 journal 步骤；新旧 reader 的版本兼容必须先审阅。保留旧数据只读门禁及生产 Bionic resolver 仍是 M5-B 的批准前置项。当前测试的独立 manifest 只是设计夹具，不是生产激活指针，不能复制到真实根使用。

## 3. 如何确定“新实时输入”

不能仅凭接收时间、消息 timestamp、连接刚建立或某个 messageId 大小声称消息在 Epoch 之后产生。OneBot 断线重投/历史回送的边界必须依据真实版本及已验证 Schema。

- 能证明来自当前认证连接且位于真实协议确认边界之后的输入，才可进入 LIVE 准入。
- 无法证明历史/实时归属的消息进入隔离，不触发 Bionic、Agent、Task、工具、回复或外发。旧 unread/旧 Follow/bootstrap 默认全隔离。
- 如真实协议无法区分历史和实时，本方案保持 BLOCKED。Owner 可以另批受控观察/人工逐项确认的边界方案；Owner 批准本身不能变造协议事实。
- Owner 必须获知：无法恢复的历史范围可能有遗漏；新实时接续不补处理这些历史；旧记录仍保留，可供之后独立核验，不能以新 Epoch 宣称历史副作用清零。

测试中的 `verifiedNew` 和连接代际是**夹具签发的合成事实**，不是产品接受的消息字段，也未证明真实 OneBot 提供这种能力。

## 4. 重复、断线及恢复

| 持久证据/异常 | 决定 |
| --- | --- |
| 未保存激活批准或边界证据 | 不接收授权业务事件，不创建假游标 |
| ARMED 后崩溃，无法确认激活/连接代际 | 重新预检，保持隔离；不得自动创建新 Epoch 绕过旧状态 |
| 已 append、尚未发起副作用 | 按原事件身份和各 consumer 状态恢复；不能以连接重建新建消息 |
| consumer in-flight 后消失 | 复用现有 Journal 恢复为 outcome-unknown，不自动重试；其他 consumer 的确认不受影响 |
| 同消息同载荷在同/跨 Epoch 重投 | 原 external key 命中 existing，保持原 eventId/sequence；不再触发新副作用 |
| 相同 external key 但载荷变化 | CHANNEL_MESSAGE_CONFLICT，隔离；不以新 Epoch 绕过 |
| 旧连接代际仍投递、Epoch 已 SEALED、manifest 损坏 | 拒绝/隔离；保持已存事件，不自动修复元数据 |
| 发送超时/回执缺失 | 沿用持久发送账本 outcome-unknown；可靠核验前禁止重发，不伪造 exactly-once |
| Journal/去重容量耗尽 | 按现有上限停止，等待 Owner 归档决策；新 Epoch 不清空历史去重记录 |

Epoch 回退不是外发撤销。新 writer 已改变目标、或任何不可逆副作用未确定时，自动回滚停止；历史数据、Journal、发送账本及证据均保留。

## 5. 隔离证据与待批准项

新增 Epoch suite 验证：四项激活门禁缺一拒绝；未知历史/错误账号/旧连接隔离；3 个消费者独立 cursor；重启后同消息去重；跨 Epoch 去重保持；冲突拒绝；in-flight 恢复 outcome-unknown；SEALED/损坏元数据不准入；旧历史原字节不变。它调用真实 `createChannelDeliveryJournal()`，未接真实账号或发送接口。

夹具先复现缺少 LIVE 状态检查会让封存 Epoch 准入，再补齐设计模型门禁。该修改不是一个生产 Epoch 漏洞修复：生产尚未接入本设计。

状态：**FIXTURE_EPOCH_PASS / READY_FOR_APPROVAL（设计）**；真实激活 **REAL_DATA_NOT_AUTHORIZED**；真实协议边界、崩溃时激活与 append 的生产原子性 **未实施/未验收**。Owner 待决：是否接受历史不自动补发、账号映射、真实协议边界验证方式、Epoch 生产设计范围及独立启用窗口。批准设计不批准真实启用。


本轮工具/测试/证据提交：`c10145fff3c3fa7bbf4768a777deba7b6220268f`。脱敏证据文件 SHA-256（当前工作树原字节）：`e00e328c4ce71c6f8939fe3a8baf8232a94875b04d5fbe5372c9059b4d2ec5eb`。最终文档提交由 Git 文件历史及交付答复记录。真实数据、Epoch、写入者未切换，等待 Owner 分组决定。
