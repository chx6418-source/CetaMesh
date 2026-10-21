# CetaMesh M6-C 最终发布门禁（Owner 中止验收并要求关机）

## 唯一结论

**RELEASE_BLOCKED**。本轮定向修复已本地提交；Owner 最新指令“就算没完成验收也关机”使本次工作停止在 Build1091 最终打包与全量回归之前。不能宣称 M6-C 完整验收完成，也不能用旧安装包证明新源码通过。后续合并推送仅按 Owner 新授权进行，不等于公开发布或 Stable 批准。

生产源码：`9b25f3b200009c6f295452444af94b98dda09ac8`，Version1.0.0-rc.2 / Build1091。Build1091 **尚无安装包**；INSTALLER_SHA256=NOT_BUILT。最近可追溯的旧候选为 Build1090/source `24ae42290f07a73eef9db836f929b8222a19c360`，其 installer 43360256 bytes，SHA256 `bd382002139eae4c30f99667733288f7593fc7b4a59eca88084bab59bbc48b1e`；该旧包不代表最终1091。

## 修复与真实证据

| 问题 | 根因及修改 | 复现、回归与边界 |
| --- | --- | --- |
| P1-CONTROL | Harbor 将可选 DSH 目录错误当整个 Desktop 不可用；只修改实际目录状态组件，保留既有 DSH available=false 契约 | 真实 createCetaMeshServices + React 组件回归；Build1090 安装后 WebView2 显示 CetaMesh Desktop，实际文件工具正常。目录可读不冒充推理 Ready |
| P1-TOOL-CANCEL | 无正文的取消工具消息漏提交、UI 未识别 cancelled；保留正式工具消息和取消卡。远程 cancel ACK 与 stopped 不等，映射只放本地 coordinator 分支 | SEA business test:真实工作区读写/批准/拒绝/取消/迟到批准拒绝；远程反例 cancelled vs waiting-approval 已红绿回归；没有放宽审批 |
| P1-MANIFEST-REDIRECT | fetch 自动跳转先于每跳来源检查 | 改手动有界跳转，HTTPS/来源/Location/循环拒绝；原验签、大小/SHA、版本测试保留。不是已证明可执行未签名程序的漏洞；正式可信链仍未通 |
| P1-APPROVAL-STOP | Build1090 真实 WebView2 等待审批时 Composer 没有停止入口 | 新增可取消状态含 waiting-approval，仅用于 Composer busy/send guard，streaming/timeline 保持；实际 React Composer 回归2 suites PASS，独立只读复核通过。Build1091 GUI尚未重测 |

提交：44109a1（目录诊断、工具终态、Manifest跳转、自动门禁和5个已登记suite），24ae422（远程未确认取消隔离，Build1090），9b25f3b（原生等待审批停止入口，Build1091）。全部保留旧测试与安全断言。修改点为 HarborApp、Chat/UI service、update checker、新 release gate calculator、5个注册测试、既有 Chat product suite、run-all-tests、version 和方案文档；无 Core/Task/Memory/Broker 重建。

## 实际验证

- Build1089:5个新增suite定向全部PASS；Core/UI/Rust/Release构建成功，Rust199/0。
- Build1090:clean source24ae422，全套 Core/UI/desktop:check/desktop:test/desktop:build/desktop:build:debug/build:release 成功；Rust199/0。安装包 hash 上述已实际复算。
- Build1090启动的中间 npm 全量：**128 PASS / 1 FAIL / 5 NOT_RUN_ENVIRONMENT**。唯一FAIL为 test-release-candidate：运行期间原生发现问题并递增版本1091，suite按当前版本查找尚未生成的1091发行目录。保留原日志，不算最终0FAIL，不修改断言隐藏此失败。下轮必须在1091干净源码打包后完整重跑。
- 最后 UI 修复定向：`npm test -- --suite test-harbor-tool-terminal --suite test-desktop-chat-product --verbose`，2PASS/0FAIL；不是全量或RC通过。
- **最终1091 Core/UI/Rust/Desktop/Release 构建、完整npm test、RC分类均未执行**，因Owner要求即使未完成验收也关机。
- 中间日志包含原 VirtualList suite 的 Vite dep-scan 在关闭时输出 outdated 诊断；该suite通过，不能将诊断涂掉，也不把它当真实UI崩溃。
- 本轮真实 Windows WebView2：从正式1090 payload 安装到 D盘中文空格测试目录，实际Host→SEA→Owner IPC；PATH仅System32。真实Harbor输入READ/ERROR/CANCEL三种指令；受控SSE返回结构化调用，工作区实际读取，失败FILE_NOT_FOUND，最终消息超过10秒仍可见。等待审批无停止按钮被实际发现，未自动点击安全审批控件。截图在会话工具输出，持久证据保存UIA摘要、时间和服务请求；不虚构本地截图PNG。
- 真正外部模型、Codex、DSH Coding、QQ收发本轮没有新增真实验收；本地合成模型和假网关不改填 VERIFIED_REAL_E2E。
- 新 SEA business suite 已进入现有聚合器：实际批准前不写、Owner API批准后写、拒绝/取消不写；Task关联Artifact解析与foreignID拒绝；插件开发模式默认拒绝、Review门禁、SEA Worker调用、禁用/重启后拒绝、卸载。仅测试资料显式启用开发模式，不是正式发布者签名或OS沙箱证明。Artifact为Owner关联受控结果，不冒充Model自动生成完整闭环。

## 更新可信链与安装边界

已配置 GitCode stable.json 实测404；默认Node TLS访问 GitHub fallback 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。独立 --use-system-ca 诊断保持证书校验，曾返回HTTP502，不更改产品信任、不忽略证书。官网及实际发现/download、/releases页面200，但只发现仓库链接，GitHub/CetaMesh与客户端whalebridge地址不同；没有猜测或部署新Release URL。正式 pinnedPublicKey 仍空、没有正式签名材料；缺公钥fail-closed。Authenticode与Manifest签名互不替代。所有远端发行下载、更新回滚与正式签名仍待验。

缺WebView2已有正式错误提示和Microsoft官方手动安装入口；不自动下载安装。当前真实GUI是本机测试会话，不是独立普通用户/干净VM；完整安装向导、托盘退出、升级/卸载重装、普通用户HKCU、无开发目录和全路径矩阵仍按Owner清单执行。程序存活不当Harbor通过。

## 数据与阶段状态

只读复核8项Social原Hash全部不变，两候选根stopConfirmed=false，PID不存在不当安全停止。没有真实迁移、备份、Epoch切换、归属猜测、Preset覆盖或未知锁释放。M5-B仍REAL_DATA_NOT_AUTHORIZED/MIGRATION_BLOCKED；迁移本身不是默认发布前提，未证明的旧数据访问/保留/写入者兼容另属P0-DATA门禁。

M0/M1完成；M2_PARTIAL、M3_PARTIAL、M4_CODE_COMPLETE/M4_E2E_PENDING保持。旧Legacy-exclusive、真实DSH与QQ验收缺口未自行改COMPLETE。原六阶段成果继承；本轮不替代269项总册或全仓四遍审计，未找到的原册不伪造完成。

## 最终发布结论（自动计算）

- FINAL_STATUS: RELEASE_BLOCKED
- OPEN_P0_COUNT: 6
- OPEN_P1_COUNT: 11
- MANDATORY_REAL_E2E_PENDING: 最终候选64项未完成关闭；逐项见 CETAMESH_M6_C_FINAL_ACCEPTANCE_MATRIX.csv。保留原场景范围，本轮没有Owner批准延期；不能将局部Fixture升为完整场景PASS。
- ENVIRONMENT_BLOCKERS: 独立普通用户Windows/VM、授权真实Provider/Codex/DSH/QQ、正式签名/有效发行源；另有Owner要求停止导致的最终构建/回归未运行。
- OWNER_ACTION_REQUIRED / OWNER_APPROVAL_PENDING: 见 CETAMESH_OWNER_FINAL_ACCEPTANCE.md；READY_FOR_APPROVAL不等于AUTHORIZED。
- AUTHENTICODE_STATUS: SIGNING_PENDING（最近正式候选Setup/Host/Core未签名；最终1091未构建）
- UPDATE_SIGNING_STATUS: SIGNING_PENDING，可信生产公钥/签名清单未提供
- FINAL_HEAD: 文档提交后由 artifacts/verification/m6-c-build1090/delivery-receipt.json 的 finalHead 实测记录；禁止自引用手填伪造
- VERSION: 1.0.0-rc.2
- BUILD: 1091
- SOURCE_COMMIT: 9b25f3b200009c6f295452444af94b98dda09ac8
- INSTALLER_SHA256: NOT_BUILT（1090旧包Hash仅在上文单独记录）
- WORKTREE_CLEAN: 交付提交后实测，以delivery-receipt记录；构建时1090 dirtySourceTree=false
- RELEASE_ARTIFACT_VERIFIED: false（1091尚无候选）

唯一台账 CETAMESH_M6_C_BLOCKER_LEDGER.csv；自动输入/结果 CETAMESH_M6_C_GATE_EVIDENCE.json；完整64行最终矩阵没有把未运行改PASS。计算器只计算所收集证据，不签发证书或替Owner审批。当前保守范围没有批准的非核心延期；正式签名为Stable强制条件，本次签名P1未关闭，也没有RC延期批准。

## 下一步最小操作

1. Owner重新启动后，先从9b25f3b或其仅文档后继干净源码构建1091，并完整npm/Core/UI/Rust/Desktop/Release/RC回归；不复用1090结果。再验证原生等待审批停止、取消消息10秒可见。
2. 按最终Owner清单补独立普通用户与真实业务；每一项真实结果绑定相同Build/source。
3. Owner确认正式更新源/公钥与签名材料、兼容范围和外部测试账号；不得自动迁移。
4. 没有全部关闭门禁之前保持RELEASE_BLOCKED。Codex仍可继续修复有反例的代码缺陷；真实环境/签名/数据组批准由Owner完成。

本轮按最新Owner指令合并推送后关机，不创建Tag、发布Stable或部署。
