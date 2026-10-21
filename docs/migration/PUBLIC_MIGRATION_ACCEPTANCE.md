# CetaMesh 统一公开仓库迁移验收报告

日期：2026-10-21。状态：公开审查分支已推送、草稿PR已创建；main 未合并，Release 未发布。

## 仓库与来源

- 正式仓库：https://github.com/chx6418-source/CetaMesh
- 迁移分支：feature/desktop-mobile-monorepo
- 公开基线：ec6b07d8abcdea0c66ed8362d36d3c4984462cdf
- 私有来源：chx6418-source/cetamesh-mobile，codex/desktop-primary-monorepo，4acbb3d1dca1abf0acf53a5b5384f9ee71c6842b。
- 采用独立公开克隆与源码快照，没有重做历史整合，不 fetch/merge 私有 Git 历史。源码整合提交：85a5a68b0668a9a6fa440ccfb451615886ba0b20；草稿 PR：https://github.com/chx6418-source/CetaMesh/pull/3。后续提交修正CI测试预设并补充证据，不重新导入私有历史。

## 历史、文档与工程

公开原有16个可达提交完整保留，原 LICENSE、贡献说明、行为准则、安全政策、开源说明和检查表保留。原中文 Mobile 介绍迁到 apps/mobile/README.zh-CN.md。私有两个源仓库、完整历史及已校验 Git bundles 保留作为恢复来源，未删除或改写。

Desktop 位于根目录（src、desktop-shell、desktop-ui）；Mobile 完整位于 apps/mobile，依赖与运行入口独立；packages 保留共享协议入口；根 workflows 分别管理 Windows/Android；docs/MONOREPO.md 提供统一开发构建说明。

对比公开旧 Mobile 与最新私有 Mobile：405项相同、25项更新，8项公开独有工作流/治理文件保留，没有旧业务代码覆盖新成果。初始导入895项运行/平台/构建文件与私有快照一致。后续有意差异为 SDK 排除、独立通信实现、公开说明及 APK 校验脚本修复。

## 开源安全审查

- 不公开私有历史。初始对象库627个 packed/reachable 对象，无 alternates，私有源提交不可解析。公开基线 Gitleaks 零候选（14个有diff提交，不能混同16个总提交）。
- 私有1289文件快照扫描41项：40项为测试/fixture/生成器固定材料，1项为 Kugou 外部协议固定签名常量。私有历史467个有diff提交扫描43项；完整私有历史不获公开放行。
- 测试配对密钥明确为固定测试用途；未用全目录忽略掩盖运行时内容。未发现应上传的真实用户配置、密钥库、聊天/记忆/任务数据库、日志或缓存；这些运行数据不进入候选。
- 44个隐私启发式候选逐项分类：Administrator安装/构建路径和历史工作树记录，测试或文档私网地址，example域名测试邮箱，依赖公开维护者地址，图标文件名误匹配；不把它们当作真实用户聊天数据。
- SnowLuma SDK/MCP 及其补丁已从依赖与打包中排除。独立 OneBot v11 通信使用现有 ws；构建审计拒绝任何层级 node_modules/@snowluma 输入。外部网关不分发。
- Mineradio/Kugou 按 Owner 明确要求保留推送，保留来源声明；上游许可仍未独立核实，Owner决定不等同于第三方许可证明。详见 THIRD_PARTY_NOTICES.md。
- 来源未明确的演示视频、人物插画和协议 ZIP 不导入公开候选，私有来源保留。可选形象图片功能需用户自行提供有权使用的图片；不宣称默认素材保持不变。
- 扫描器不能证明绝对安全；原始报告留在私有忽略目录，不公开疑似秘密值。最终待推提交与可达历史继续扫描。

## 已实际验证

- Mobile：TypeScript、ESLint、5项架构检查通过；71 Jest suites / 288 tests通过；11项产物卫生测试通过。
- Windows：UI TypeScript/Vite、Core SEA、release/debug Rust壳实际构建通过。此前全量141 PASS /0 FAIL /14环境跳过；SDK替换后全量146 PASS /0 FAIL /10环境跳过；另轮132项核心/架构/安全/运行/集成全部通过。
- 替代通信回归：鉴权、消息/通知、失败响应、超时、有界队列、断线拒绝且写不重放、自动重连重验、变更账号拒绝就绪通过；现有 QQ runtime/connector process 回归通过。
- SDK排除后的 Core 打包通过，39个第三方包，无 SnowLuma SDK/MCP。
- Android：Gradle assembleRelease实际成功，480 actionable tasks，15分17秒。APK签名及Standalone包校验通过：包名com.cetameshmobile、compile37/min24/target36、非debuggable、权限白名单、3384084字节内置Bundle、四种ABI、无秘钥文件。DEX包含七个CetaMesh原生模块和IdentityPackage；各ABI包含NitroModules及RNNitroSQLite。
- APK：apps/mobile/android/app/build/outputs/apk/release/app-release.apk，75874874字节，SHA256 84f739f76578bdb2cd22069b2d5fbdc94b9ff1150486acd674c041ef471b2e02。
- APK使用本地生成的测试签名，非正式发布签名。没有连接的adb设备，真机启动、真实跨端配对与业务验收为 NOT_RUN_ENVIRONMENT。iOS原生需要macOS/Xcode。

## 环境问题、CI 与更新

Gradle PKIX定位为Java默认信任库不包含当前网络证书链。仅构建进程使用Windows-ROOT信任库，保持TLS验证，不修改全局JDK。Google官方SDK工具校验后装入隔离目录，platform-tools/adb、API37、build-tools37、NDK27.1及构建依赖已安装。原“缺SDK/adb”已解决；缺实际设备仍未解决。APK脚本原先因pipefail下grep提前退出触发unzip SIGPIPE误报，已以一次完整目录清单修复，实际包内容再次通过。

公开基线历史Android CI run37213101690成功。私有整合CI run39612725122/39612725088因账单/额度限制在零步骤失败，不能据此断言公开仓库当前相同。公开分支远程双端CI需要实际推送后记录；配置检查不等于远程成功。没有修改账单或提高额度。

Windows与Android独立构建发布；GitCode现有正式更新源及GitHub回退地址保留，未发布新manifest/Release。旧客户端真实公网更新下载/验签未完成，不能用URL保持不变冒充端到端通过。

## 尚待收尾

公开提交、历史复扫、分支推送和草稿PR均完成；远程CI完成情况以链接和最终交付记录为准。第三方完整二进制notices、正式签名、真机配对和旧客户端更新验收在发布前补齐。未经Owner确认不合并main、不发布Release、不删除私有源仓库。

## SDK 排除后 Windows 产物

Build1115 DEV安装包实际构建与安全审计通过：42999808字节，SHA256 397f9a8d36d9a95305c6a9b0ffe5f3238fccc02898e7509164baeb902a27a828。路径 artifacts/dev/1.0.0-rc.2/build-1115/CetaMesh-Setup-1.0.0-rc.2-build1115-x64.exe。39个Core npm包，无SnowLuma SDK/MCP；UI重新构建。DEV标记为ec6b07d+dirty工作树，非干净源码正式RC，不发布。

原test-mcp-safe隐式访问实际网关/数据面，单轮等待约90秒且旧断言未严格检查失败；已替换为隔离本地HTTP和IPC服务，真实MCP状态/工具schema/数据面委托及拒绝传播通过。实际发送授权仍由test-qq-runtime等套件验证。

## 本轮自动化结果更新

SDK排除后完整 npm test：156 suites，146 PASS /0 FAIL /10 NOT_RUN_ENVIRONMENT。Cargo check/test在另轮均PASS。产物后分类复验曾14 PASS /2 FAIL /2环境跳过：Core因删除全部未授权素材后资源assets目录未生成失败，已添加公开素材说明并重建；托盘日志等待失败，另一个完整测试轮的同项42.9秒PASS，保留其并发环境不稳定记录。最终产物复验另补，不能抹去先前失败。

最终DEV资源目录修复后Build1116实际构建完成，包含assets说明且无未授权图片：42999808字节（以manifest最终记录为准），SHA256 03706f39cd98473350a20204088a9bf7f17b1e088b0242ff0a8b431163acb247。此前Build1115为过渡证据，不是最终交付安装包。

## 干净源码RC与最终分类复验

本地正式构建模式（不等于发布Release）由干净85a5a68源码生成 Build1116，dirty=false，RC目录 artifacts/rc/1.0.0-rc.2/build-1116。安装包42999808字节，SHA256 1eb029b805db3a49e166bc186fba0f0c74a671e939f781346c5c7f59e6fea5fc。Desktop/Release共18 PASS /0 FAIL /0环境跳过，含真实安装升级卸载、IPC、SEA、依赖和Cargo。未签名；Windows10和真实QQ/DSH端到端未验收。

原私有备份再次git bundle verify有效：desktop-all.bundle 152509237字节，SHA256 8153a5684f12c352d46ff9feb63f6eeeb8bf034ac1e40a3c437ca3ad5a3aa69d；mobile-all.bundle 22474374字节，SHA256 7f6bfa971f9916e571225327a2c5defb9fb8a071096fe061c692d8f9e82c8a79。均位于私有工作树output/migration-baseline，仅本地恢复，不上传公开仓库。私有整合工作树仍为4acbb3d且干净。

## 远程首轮CI暴露问题与修正

公开Windows run39624202649真实执行后135 PASS /2 FAIL /19环境跳过；不是账单限制。test-service-container假定Codex原生沙箱已安装，实际应在不支持环境先返回AGENT_NATIVE_SANDBOX_UNSUPPORTED；现在按能力声明精确检查拒绝码，额外断言拒绝时不创建Session，不改变产品安全逻辑。test-workspace-staging-boundary故障注入使用原始临时路径表示，生产使用规范化路径；现在对两者使用native realpath，避免Windows路径表示不同导致未注入故障，仍断言实际导入必须拒绝。5项相关本地回归全部通过。

首轮公开Android run39624202486已完成JS检查，进入原生编译；公开CI当前可以实际运行。源提交两个平台的首次链接：
- Windows：https://github.com/chx6418-source/CetaMesh/actions/runs/39624202649
- Android：https://github.com/chx6418-source/CetaMesh/actions/runs/39624202486

远程最终状态需等待完成；不得将执行中记为PASS。后续仅测试/说明修正不改变已构建的产品源码与依赖。许可证完整文本仍需在二进制发布前补齐，当前生成包的Node运行时notice尚有缺口，不能把SBOM生成当成完整再分发合规通过。
