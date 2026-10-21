# Owner 最终验收与后续最小动作

当前RELEASE_BLOCKED，Version1.0.0-rc.2 / Build1091，source 9b25f3b200009c6f295452444af94b98dda09ac8。本页不代表批准、验收通过或公开发布授权。Owner最新指令允许合并推送，并要求即使验收未完成也关机；不得将此解释为放宽任何发布门禁。

## 重启后先做

1. 核对git branch/HEAD/tree及delivery-receipt；9b25f3b之后仅文档改动时，产品来源仍明确记录，发布脚本应实际记录所用干净提交，不能手改sourceCommit。
2. 从干净源码依次运行现有 npm run build:core、build:ui、desktop:check、desktop:test、desktop:build、desktop:build:debug、build:release -- --use-current-build-number，再npm test（WHALEBRIDGE_TEST_CARGO=1）与npm test -- --category release --verbose。RC使用已验证D盘空格TEMP；全量保持普通系统TEMP。不要修改断言或清空用户StateDir。
3. 新候选生成后重算文件大小/SHA、Manifest全部files、签名、sourceCommit/dirtySourceTree；本次1091尚无包。1090旧包不能补填为1091。

## Windows可执行手工步骤

准备独立标准用户/干净Windows10或11 VM快照；使用专门D盘中文空格安装/数据/Workspace，记录用户是否提升、OS、Build/source及每项截图/日志。没有授权不下载或执行外部依赖安装程序。缺WebView2应显示Microsoft官方地址和明确提示，由Owner决定依赖安装。

- [ ] 双击最终候选完成全向导，安装器关闭且无循环命令窗；HKCU属于实际测试用户。
- [ ] 首次引导保存授权模型、测试连接；Harbor全部页面加载，Core IPC握手/鉴权、单实例正确。不能只看Host PID。
- [ ] 在不含系统Node及无源码目录的环境启动；中文/空格/非C路径，最小化/托盘退出/重开；仅本应用拥有的子进程退出。
- [ ] 同/新版本覆盖升级、失败恢复、卸载保留数据重装；测试Chat/Task/Memory/Workspace/Plugin IDs与Scope不变，不覆盖DSH Preset。

## 真正业务验收（每项填写操作人/时间/环境/Build/源码/预期/实际/证据/PASS或FAIL）

- [ ] 连续三轮真实模型、Streaming、模型切换、Agent none；停止与服务端取消/计费状态，不重复旧回答，最终消息10秒仍可见。
- [ ] 真正Chat Tool Calling→Broker→必要审批→实际执行→模型续答→Harbor；成功/失败/拒绝/取消/多工具部分审批。重点复测本次waiting-approval停止入口及远程cancelRequested不是stopped。
- [ ] Task Start/Pause/Resume/Cancel、Checkpoint、Staging审批导入Artifact、身份关联和安全访问；Core重启不重复副作用，失联必须核验。
- [ ] Memory候选批准/拒绝、新会话检索、修改/删除、Scope隔离及重启恢复。
- [ ] 安装版MCP真实initialize/list/call/shutdown；Plugin权限Review、Worker调用、禁用实际拒绝、卸载/崩溃隔离；不把开发模式Fixture当发布者签名或OS级沙箱。
- [ ] Codex真实Windows版本/认证/沙箱/Task/取消恢复；拒绝时保留阻塞，不关闭Sandbox。
- [ ] DSH API鉴权、Coding/Social目的及Persona/Profile、三轮/Follow/取消；只读校验用户Preset。
- [ ] QQ需要单独批准测试账号/白名单/目标和允许操作，正式SEA start/stop/health/reconnect、Legacy互斥、Bionic独立、账本/outcome-unknown；未经批准不外发。
- [ ] E01–E24与AC001–040逐项填写完整范围，Fixture/Release Integration与真实E2E分开。当前64行最终候选未运行，不可直接全绿。

## Owner需明确决定的事项

| 项目 | 所需动作 | 当前结论 |
| --- | --- | --- |
| 正式签名 | 提供正式发行主体Authenticode流程、时间戳与验证；Manifest独立签名及可信公钥 | SIGNING_PENDING；不用自签冒充 |
| 发行源 | 确认GitCode实际资产、客户端GitHub whalebridge与官网CetaMesh仓库差异，部署后实际TLS/下载/Hash/大小/回滚验证 | 未批准切源/部署；404/TLS/502不通过 |
| 未验证可选功能范围 | 每项明确延期范围、禁用入口、用户可见限制和复验条件 | 无Owner延期批准；不能只改文字放行 |
| M5数据 | 8Social归属、2缺cursor、旧写入者ACK、真实备份分别批准；可选只读兼容需证明安全访问和保留 | REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED；不自动迁移 |
| 兼容/协议/许可证 | M2 Legacy期限、M3真实purpose、AC002/005/014/017缺口、Node许可材料与原审计进度 | 未关闭，不自动COMPLETE |

最小下一步为重启后构建并完整验证最终1091；随后补真实Windows与业务门禁。最后签字应附具体版本/Build/source/安装包Hash、各延期批准编号及剩余P0/P1。当前不能建议RC_READY或STABLE_READY。Git推送不授权Tag/Stable/生产部署。
