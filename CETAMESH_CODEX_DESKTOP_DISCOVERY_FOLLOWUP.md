# Codex Desktop CLI 发现缺口：截图纠正后的复现、修复与回归

## 结论与更正

用户截图对应的已安装版本确为 Build1095。此前报告中的原生界面验收继承了工具宿主提供的 CODEX_CLI_PATH，不能证明 Explorer 普通启动环境中的自动发现已修复。该结论在本次明确更正；Build1095 的历史日志保留，不作为本次通过证据。

本次在去除所有大小写别名的 PATH、CODEX_CLI_PATH、CODEX_INSTALL_DIR 后，仅设置 System32 PATH，先复现 CLI_NOT_FOUND，再验证 Build1096 正式 SEA 和实际安装 Harbor 均发现本机 CLI。当前修复仅解决发现缺口；真实 Task 被 Windows Sandbox 拒绝，仍为 NOT_RUN_ENVIRONMENT，FINAL_STATUS = RELEASE_BLOCKED。

## 根因与实际调用链

- 已有 standalone fallback 为 LOCALAPPDATA/Programs/OpenAI/Codex/bin/codex.exe；本机可执行 CLI 实际位于 LOCALAPPDATA/OpenAI/Codex/bin/<16 hex generation>/codex.exe。这个布局未进入候选，普通 GUI 环境无 PATH/显式覆盖时返回 CLI_NOT_FOUND。
- 其中另一世代仅包含 rg.exe，不能把目录存在或 Desktop App 存在当作 CLI 安装成功。
- Windows 环境键大小写不敏感；旧探测脚本仅清除 PATH 却保留 Path 时会继续找到旧路径，形成假阳性。新增回归覆盖生产最小环境与候选读取的大小写行为。
- 调用链保持：Harbor Agents 检查连接 → 原生 Host IPC → Core ui.agent.health → 既有 Broker/Provider → 受限 CLI discovery → version/help/exec-help/login 检查 → Health DTO → Harbor。没有新增 Agent Broker 或私有 Desktop API。

## 修改与安全边界

| 文件 | 修改 | 状态 |
| --- | --- | --- |
| src/agent/cli-agent-process.js | 仅在 Windows Codex 自动发现中检查已知 app-managed bin 根；最多32个16位十六进制世代，精确原生 codex.exe，拒绝符号链接/Junction越界；保留显式路径优先且失败不降级；installKind=desktop-managed-cli | FIXED_CODE |
| 同上 | Windows最小进程环境键规范化，覆盖值不产生Path/PATH并存；候选值读取采用最新大小写别名 | FIXED_CODE |
| scripts/test-codex-discovery.mjs | 原服务先无CLI、安装后刷新；rg-only无效、越界Junction拒绝、大小写环境回归 | VERIFIED_FIXTURE |
| scripts/test-m6-pure-core-sea.mjs | 清理所有环境别名；正式SEA同一Core新增app-managed可执行文件、检测并拒绝非Codex协议、移除后恢复未安装 | VERIFIED_RELEASE_INTEGRATION |
| release/version.json | Version 1.0.0-rc.2 / Build1096 | FIXED_CODE |

没有扫描受保护 WindowsApps、绕过ACL、shell:true、关闭Sandbox、扩大Capability或审批。Health DTO不公开CLI绝对路径、令牌、PATH或私有正文。实际Codex读取既有登录状态；未修改其配置、Preset、凭据或真实工作区。

## 先红后绿证据

- reproduction-red.log：新增Desktop布局与大小写用例在修复前失败（2组）。
- focused-green.log：npm test -- --suite test-codex-discovery --suite test-agent-provider-expansion --suite test-error-hygiene --verbose，3 PASS /0 FAIL。
- sea-old-build-red.log：新SEA回归对旧1095产物，installed=false，与期望true不符，证明新增测试能捕获实际缺口。
- real-clean-environment-health.json：修复后真实源代码在无覆盖环境识别 desktop-managed-cli，installed/compatible/authenticated=true。
- 1096-real-sea-health.log：最终1096正式SEA相同无覆盖环境，通过真实Owner IPC得到相同结果；版本codex-cli 0.163.0-alpha.10.2。

## 实际安装与原生界面

从最终单文件Setup解出正式payload，用发行Host真实 --install 安装到本轮D盘中文空格隔离目录，独立StateDir、HKCU测试键、实例命名空间。启动环境PATH仅System32，删除显式CLI覆盖，保留真实LOCALAPPDATA以验证自动发现。Core/Harbor不依赖系统Node或源码目录运行。

通过Computer Use实际操作隔离窗口：打开Agents，点击Codex卡片检查连接。最终显示“已检测 / 协议兼容 / 已认证”，版本0.163.0-alpha.10.2；Sandbox显示待首次明确选择的任务验证。截图 docs/repair-evidence/codex-desktop-discovery/1096-native-codex.jpg；UIA文本存verification.json。此项是本机真实CLI健康与原生UI通过，不是完整真实Agent Task通过。

窗口曾隐藏到托盘，依据该隔离实例的专用命名空间重新显示；未操作用户原有应用。完成后停止本轮Host，核对其Host/Core为0，隔离卸载退出0、程序与测试注册表已清理，测试数据保留。PowerShell直接启动GUI卸载首次未等待完成，不算通过；最终以Node spawnSync等待退出的日志为准。

## 最终回归与发行一致性

- 全量命令：WHALEBRIDGE_TEST_CARGO=1 npm test -- --verbose：134 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT。
- npm run build:core / build:ui / desktop:check / desktop:test / desktop:build / desktop:build:debug / build:release -- --use-current-build-number 均退出0；本次最终构建无重试。
- Rust：199 PASS /0 FAIL；RC/release分类：12 PASS /0 FAIL，为全量聚合器中的release分类，逐项见1096-full-test.log。
- WHALEBRIDGE_TEST_REAL_CODEX=1 npm test -- --suite test-phase3-real-codex --verbose：0 PASS /0 FAIL /1 NOT_RUN_ENVIRONMENT，Windows原生Sandbox拒绝隔离Task。未绕过Sandbox。
- 产品源码提交：b18802c7952918e77f35aa752fea2c5ca119cbf5；构建时dirtySourceTree=false。后续报告提交仅文档/证据，与产品源码提交分开记录。
- Version：1.0.0-rc.2；Build1096；安装包CetaMesh-Setup-1.0.0-rc.2-build1096-x64.exe，43446272 bytes。
- 安装包SHA256：ae0797372420a716ab32d8dc8cc6b64a54726ceb2c1e0a77953947b02c567b2c；Authenticode=NotSigned / SIGNING_PENDING。
- release-manifest的30个文件Hash、3项artifact大小/Hash及31条SHA256SUMS全部验证。
- 可直接取用安装包：D:\GIT- CetaMesh\codex-desktop-discovery-followup/CetaMesh-Setup-1.0.0-rc.2-build1096-x64.exe。全部本轮红绿日志、构建、测试、安装、卸载日志位于D:\GIT- CetaMesh\codex-desktop-discovery-followup。

## 剩余门禁与交付

- FIXED_CODE / VERIFIED_FIXTURE：Desktop布局发现及Windows环境大小写问题。
- VERIFIED_RELEASE_INTEGRATION：最终SEA自动发现、安装Host/Harbor真实显示、负向协议验证。
- VERIFIED_REAL_E2E（仅健康探测范围）：本机真实CLI版本/兼容/登录状态；不包含Task完成。
- NOT_RUN_ENVIRONMENT：全量5项为legacy-bridge、gateway（MCP exec / OneBot）、network（Web search）、real-codex opt-in。另行开启real-codex后真实Task仍被Windows Sandbox拒绝；没有将未运行计为通过。
- RELEASE_BLOCKED：不把安装检测通过视作Task成功或正式发布通过；真实DSH/QQ、签名和其他既存发布门禁不在本次解除。
- 本地修复分支codex/codex-cli-detection-repair；没有merge/push/tag/Stable，没有真实数据迁移、停止用户Core或覆盖DSH Preset。
- 用户原安装仍是1095；本轮提供1096安装包待Owner自行升级，不能继续用旧进程的卡片证明新代码失败或成功。
