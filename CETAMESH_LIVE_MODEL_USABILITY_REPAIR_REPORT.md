# CetaMesh 真实模型、项目分析与工具调用可用性修复

## 交付结论

Build1101在正式SEA --worker、独立Owner IPC、隔离Task/Workspace中，通过已配置的真实DeepSeek完成Managed Agent连续三轮项目分析。另在保留blocked旧写入者的独立Fixture中，Agent none普通Chat也连续三轮读取文件并回答，未创建Agent Task。它们是使用合成项目的真实模型端到端验证，不是用户NexBox项目已分析，也不是Codex/DSH真实任务成功。

最终状态仍RELEASE_BLOCKED；可用于上述已验证的本机聊天/只读分析路径，未发布Stable。Owner随后明确批准正常退出旧CetaMesh、正常退出DSH并原路径覆盖1101。已完成安装并启动真实Harbor/Core，未迁移数据、释放未知锁或改写DSH预设。

## 截图问题及根因

| 问题 | 实际证据 | 修复 / 状态 |
| --- | --- | --- |
| Codex model provider mismatch | Chat默认deepseek-official/deepseek-flash被作为Codex Task模型配置发送；后台依原契约拒绝与Codex本机模型provider不匹配 | Harbor选Codex时清除跨Provider模型，模型栏明确提供“Codex 本机模型配置”；现有错误会话可手动选择此项；后台MODEL_PROVIDER_UNSUPPORTED测试保留，未静默替换已授权模型 / FIXED_CODE、VERIFIED_FIXTURE |
| DeepSeek DSML正文泄漏 | 本机已保存响应包含双全角竖线<｜｜DSML｜｜ calls>；旧guard仅单竖线 | 有界标记识别及流式hold，只有独立结构化tool_calls存在才丢弃内部正文；无结构化调用则明确拒绝，不解析执行DSML文本 / FIXED_CODE、VERIFIED_FIXTURE、VERIFIED_REAL_E2E |
| 工具预算后明明有最终回答仍显示失败 | 预算末轮仅因进入最后一次请求就置limitReached，合法最终答案也被partial | 末轮不再提供tools，要求按已核验结果总结；仅实际超限/拒绝调用才保留partial；副作用轮次、总数和batch额度未扩大 / FIXED_CODE、VERIFIED_FIXTURE、VERIFIED_REAL_E2E |
| DeepSeek thinking总结的续接边界 | 审查反例：tools=[]的有效答案若无reasoning_content，下一轮工具请求缺续接 | 校验覆盖历史tool_calls上下文，当前轮就拒绝缺失原生续接；新增反例先红后绿 / FIXED_CODE、VERIFIED_FIXTURE |
| Workspace阻塞与错误卡片 | 前轮已确认blocked+currentAgent保留写入权；新建Task不能接管 | 继承91905d1/245dcde终态徽标、占用任务定位和历史只读投影；不清锁、不取消真实任务。正式SEA在blocked写入者存在时验证Agent none仍可只读分析 / VERIFIED_RELEASE_INTEGRATION、VERIFIED_REAL_E2E |
| DSH需要设置 | 未选coding preset；只读检查whale-chat及whale-chat-v2均persona-prefix-required；liangshen仅本地Schema兼容 | 未自动选择或覆盖Preset；Schema兼容不代表Coding Task真实通过 / OWNER_ACTION_REQUIRED、NOT_RUN_ENVIRONMENT |
| 非Git旧任务继续失败 | 既有Workspace恢复要求Owner核对先前操作 | 安全门禁保留；未强制恢复、释放锁或重放旧操作 / OWNER_ACTION_REQUIRED |

## 最小立即使用步骤

1. 已按Owner批准正常退出旧CetaMesh和DSH，原路径覆盖安装Build1101并打开Harbor。真实安装路径C:/Users/Administrator/AppData/Local/Programs/CetaMesh，数据路径保持原WhaleBridge目录；54个已有用户JSON在覆盖前后Hash不变，新增4个安装器资源备份JSON。DSH保持已退出。
2. 新建普通聊天，选目标Workspace、Agent=不使用Agent、Model=deepseek-flash。发送明确只读分析请求。这条路径已在存在blocked写入者的正式SEA中验证，不会争用Task写入权。
3. 若工作区没有其他执行权占用，可另开会话选CetaMesh Managed Agent进行受控项目任务。写操作与执行仍遵守Broker/审批；有旧占用时先核验旧任务。
4. 若选择Codex，使用“Codex 本机模型配置”；当前原生Windows沙箱仍拒绝测试Task，不能承诺Codex立即可执行，不以关闭Sandbox换通过。

## 实际修改及提交

- d00c5bfd73dc4c7b7670b79163fc9ab6fd9d223e：src/model/providers/openai-compatible.js、src/model/tool-execution.js、desktop-ui/src/app/HarborApp.tsx及三个既有聚合测试；Build1099为过程产物，非最终交付。
- 00ce30e5a3de208f7e70f9568c00565d801ec731：DeepSeek最终总结续接校验及反例；续接修复过程候选Build1100。
- b2891b0ad87c67e43f541ff2f328018ae003d243：默认协调器保持工具Schema和partial旧契约，仅正式Core显式启用finalSynthesisAtLimit=true；最终产品Build1101。
- 新增回归均扩展已有聚合器套件，没有孤立scripts/test脚本、删除断言、改基线或绕过权限。
- requesting-code-review独立只读审查发现续接问题，补充反例并修复后复审关闭；审查本身没有运行测试。

## 先复现再修复证据

- red.log：DSML双竖线泄漏、预算最终回答误报、Codex模型选择三套反例FAIL。
- continuation-red.log：最终总结缺续接数据被错误接受的反例FAIL。
- 1101-focused.log：test-new-audit-critical / test-model-tool-calling / test-harbor-agent-setup / test-agent-provider-expansion / test-desktop-chat-product / test-model-continuation / test-service-container / test-error-hygiene，8 PASS /0 FAIL。
- real-before.log：真实DeepSeek的最小只读调用返回结构化filesystem.read；不是推断所有响应都含DSML。用户现场双竖线证据与分片Fixture单独记录。
- real-managed-results.json：生产createCetaMeshServices真实模型三轮完成，临时项目文件未改变。
- 1101-real-sea-results.json：最终正式SEA三轮Managed分析、版本查询、函数风险分析通过，Agent状态completed。
- 1101-real-chat-none-results.json：最终正式SEA保留blocked旧写入者，Agent none三轮完成、taskId保持null、Agent活动为空，临时项目文件未改变。
- 过程候选Build1100全量133 PASS /1 FAIL /5 NOT_RUN_ENVIRONMENT：test-model-continuation原断言要求默认预算末轮保留Schema且partial。本次没有更改原断言；通过默认保持旧契约、正式Core显式启用总结策略修复。最终1101重新运行，不能用旧包或旧测试证明通过。
- 两项最终SEA E2E都清除CLI路径覆盖和PATH大小写别名，PATH只保留System32；最终Core直接执行，不依赖系统Node或开发目录运行。测试启动器在开发机运行不作为Core依赖。
- 真实Provider只接收合成项目文件；测试凭据副本位于隔离根，结束后删除/清理；报告不含凭据、用户聊天正文、原生reasoning或私有源文件。

## 最终测试与发行产物

- 全量：WHALEBRIDGE_TEST_CARGO=1 npm test -- --verbose：134 PASS /0 FAIL /5 NOT_RUN_ENVIRONMENT。
- Rust：199 PASS /0 FAIL；RC/release分类12 PASS /0 FAIL（来自同一全量聚合器）。
- build:core、build:ui、desktop:check、desktop:test、desktop:build、desktop:build:debug、build:release -- --use-current-build-number：最终1101均退出0。
- 真实Codex opt-in（1100；1101未改Codex实现）：0 PASS /0 FAIL /1 NOT_RUN_ENVIRONMENT，Windows原生Sandbox拒绝隔离Task。
- 全量5项环境缺失为legacy bridge、gateway MCP、network web search、OneBot gateway、real-codex opt-in；另行opt-in后的沙箱拒绝如上，未计PASS。
- Version 1.0.0-rc.2 / Build1101 / sourceCommit b2891b0ad87c67e43f541ff2f328018ae003d243 / dirtySourceTree=false。报告提交仅文档与脱敏证据，产品来源以sourceCommit为准。
- 安装包CetaMesh-Setup-1.0.0-rc.2-build1101-x64.exe，43446272 bytes；SHA256 077c750905c75c844ea65631be406f8504c816ce6e89fcb56e17104ae0a367ba。
- Manifest 30个文件Hash、3项产物大小/Hash、31条SHA256SUMS均核对；Authenticode NotSigned / SIGNING_PENDING。
- 可直接使用安装包：D:\GIT- CetaMesh\live-model-repair/CetaMesh-Setup-1.0.0-rc.2-build1101-x64.exe；所有本轮日志和实际E2E结果保存在D:\GIT- CetaMesh\live-model-repair。
- 已通过Computer Use操作真实Windows WebView2：隔离正式安装、真实DeepSeek三轮、filesystem.read、流式停止、Task创建/暂停/恢复/取消及Checkpoint、Memory保存/搜索、正常退出重启后Chat恢复。MCP启动真实停在Core审批，未代点权限；插件目录service_not_configured。详见CETAMESH_1101_NATIVE_FUNCTIONAL_ACCEPTANCE.md，不能宣称所有功能正常。
- 原路径第一次覆盖因5个独立DSH MCP占用而安全拒绝（1098保留、36个state JSON未变）。Owner单独批准正常退出DSH后，核验专用控制台成员并仅发送一次Ctrl+C，观察DSH/5个MCP自行退出，再次安装exit0。校验脚本因发现4个新增备份JSON返回1，属于其过严的零新增检查；原始记录保留，没有修改测试断言或掩盖产品失败。

## 剩余状态与停止边界

可用：真实DeepSeek普通Chat工具分析、Managed Agent受控隔离项目分析及连续多轮；正式1101已安装启动，当前新会话设NexBox-main、不使用Agent、deepseek-flash，未自动发送私有项目给模型。未验证：用户NexBox完整分析结果、DSH真实Coding、QQ真实E2E、插件商店完整安装及批准后的MCP GUI调用、干净普通Windows用户全套安装验收。Codex真实Task仍受原生Sandbox阻塞。

本轮无真实用户数据迁移、无Preset或凭据覆盖、无强制停止用户进程、无未知锁释放、无安全权限扩大。没有push、merge main、Release Tag或Stable发布。完成后停止。
