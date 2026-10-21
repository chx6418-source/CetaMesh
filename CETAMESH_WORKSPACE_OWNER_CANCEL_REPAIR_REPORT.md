# Workspace 旧任务取消修复与真实 Codex 验证

## 结论

已按 Owner 明确授权正常退出并原路径升级 Build1102，通过 Windows WebView2 正式取消旧分析任务。NexBox-main 当前持有执行权的任务为0。真实 Codex 验证未通过，仍为 CODEX_SANDBOX_UNAVAILABLE；没有关闭Sandbox或放宽读取边界。RELEASE_BLOCKED。

## 根因与修改

旧任务 task_mvfaoref_dedfb7b442 因 TOOL_CALL_LIMIT 为blocked，仍保留Managed Session。Core重启后该Session仅存在于持久Task引用，Managed Provider内存中已不存在。正式 ui.task.cancel 先调用Broker.cancel；SESSION_NOT_FOUND中断流程，Task无法进入cancelled，持续占用工作区。

修改 src/desktop/ui-service.js：仅Owner明确取消、且provider=cetamesh、且错误精确为SESSION_NOT_FOUND时，允许继续持久取消。暂停流程不采用该例外；Codex等外部Provider会话缺失、超时、交接进行中等仍拒绝释放执行权。未捕获所有错误当作成功。没有直接改用户Task JSON、删锁、重放旧操作或取消其他工作区。

新增现有 scripts/test-desktop-chat-product.mjs 聚合回归：真实Managed Provider缺失Session先失败，再验证正式取消、保留Task、清除currentAgent、解除Workspace占用；外部Codex SESSION_NOT_FOUND与本机ETIMEDOUT继续拒绝。产品提交 7f83854c501366ad6ff2801e589a72ceea5114b8；Version 1.0.0-rc.2 / Build1102。

## 真实执行结果

- 安装器exit0，覆盖前64个已有用户JSON Hash在覆盖后全部不变，新增4个安装器资源备份JSON；--no-dsh-integration，未修改Preset或凭据。重新启动之后的授权Task/Chat操作会正常写业务数据，不声称其Hash仍不变。
- 旧分析任务：blocked→cancelled，rev234→235，currentAgent=null；ID、53条执行证据和2段Agent历史保留。
- Documents任务：仍blocked、rev66、原执行者与7条证据不变；未操作它。原始Task行序列化Hash比较未全匹配，不能声称取消后其他整行字节完全不变；已单独验证上述生命周期、身份、修订和记录计数。
- 实际安装版Chat选Codex本机模型配置发送“只回复CODEX_READ_ONLY_OK，不用工具、不读写文件、不执行命令”。旧任务冲突不再出现；真实CLI拒绝restricted-token沙箱的split filesystem read restrictions，未返回sentinel，未记录工具执行。
- 本次验证复用了用户此前queued的“你好”Task。它因沙箱变blocked后，通过正式取消结束，保留该Task及Codex历史，不让验证留下新的执行权占用。NexBox-main最终活动Owner=0。
- Windows界面截图：1102-owner-task-cancelled.jpg、1102-real-codex-sandbox.jpg、1102-codex-verification-cancelled.jpg，位于 D:\GIT- CetaMesh\live-model-repair。

## 回归与正式发行验证

- 修复前：cancel-restart-red.log，正式ui.task.cancel抛SESSION_NOT_FOUND，聚合器0 PASS/1 FAIL。最初测试调用Provider包装层错误另已纠正，修复前有效反例使用真实managed.provider.cancel。
- 定向：3 PASS/0 FAIL；包含桌面Chat产品、Service Container、错误卫生。
- 最终全量：134 PASS /0 FAIL /5 NOT_RUN_ENVIRONMENT；Rust199 PASS/0 FAIL；Release分类12 PASS/0 FAIL。
- Core/UI/Rust check/test/Desktop release/debug/Release构建最终均exit0。C盘复制后立即SEA注入出现无法写入，单独延迟注入可成功；改用脚本支持的隔离D盘输出，再复制至dist/core完成整套构建与审计，未改第三方依赖或跳过验证。外部驱动含空格参数错误也已纠正，不计产品PASS。
- 正式SEA Owner IPC隔离验收：旧Managed Task取消及Core重启保持cancelled，通过；测试临时目录清理，不触碰真实数据。
- 真实Codex opt-in：0 PASS/0 FAIL/1 NOT_RUN_ENVIRONMENT；实际用户GUI也得到相同沙箱限制。Fixture通过不替代真实Codex Task成功。

## 版本与交付

- 产品来源 7f83854c501366ad6ff2801e589a72ceea5114b8，dirtySourceTree=false。后续报告提交不改变二进制产品来源。
- 安装包 D:\GIT- CetaMesh\live-model-repair/CetaMesh-Setup-1.0.0-rc.2-build1102-x64.exe。
- 大小 43446272 bytes；SHA256 4bf1a4eb8127d5b1b616f7f265e67bad6400bc7964709e2942aad1d7e8f03edb。
- 30个发行文件Hash、3个产物Hash/大小及24个实际安装文件Hash匹配。
- Authenticode NotSigned / SIGNING_PENDING。
- 实际安装 C:/Users/Administrator/AppData/Local/Programs/CetaMesh，Harbor/Core已启动。保留实际沙箱失败记录，不将Codex显示或安装检测当作真实Task通过。

## 剩余限制

旧任务取消缺陷已修复且在真实数据上执行成功；Codex Windows沙箱与工作区读取约束的兼容性仍未解决，不能标记Codex真实可用。下一步应单独核对安全沙箱兼容方案，不通过关闭沙箱、扩大路径或忽略限制换取成功。DSH/QQ/签名/可信更新等此前发布阻塞保持原状态。没有用户数据迁移、未知锁释放、真实QQ外发、push、main合并、Tag或Stable发布。
