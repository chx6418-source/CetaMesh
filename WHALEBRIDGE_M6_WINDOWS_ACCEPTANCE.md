# WhaleBridge M6-A — Windows 安装版验收

## 1. 产物与环境分类

本报告所有最终运行项对应 Version1.0.0-rc.2 / Build1084，生产 sourceCommit **8dc4159a2a2c18ad3248bd4e7f32c2b1e34e3dfa**；最终测试提交 bca4c57dff36b957d4652ac4ca6990f8a15ecc3e（仅测试目录/就绪等待不同，生产输入diff=0）。旧Build1082/1083只列失败追溯，不能作为1084通过证据。

- **HOST_FIXTURE**：宿主当前Windows用户，实际探测未提升权限；用独立StateDir、HOME/LOCALAPPDATA、测试HKCU键、开始菜单/桌面目录和端口。不是独立Windows用户或完整OS隔离。
- **RELEASE_INTEGRATION**：正式Host/SEA/Harbor payload，PATH无系统Node；既有安装器/RC/子进程脚本操作上述隔离资料。含D盘中文空格目录。不是用户正式安装覆盖升级。
- **CLEAN_VM_SUBSET**：实际Windows Sandbox客体Windows11 build22621；禁网络/剪贴板、ProtectedClient启用、包/驱动只读映射、仅专用证据目录可写；临时资料仅在客体。默认WDAG账号实际elevated=True，绝不标普通用户。
- 独立普通用户客体设置尝试未成功，保留normal-user-launcher日志；未进一步改变Sandbox限制。宿主没有创建用户、启用虚拟化特性或改真实凭据。

## 2. Windows逐项验收

所有步骤保持白名单/沙箱/Capability/Approval，不用真实QQ账号。表中PASS限定执行范围；缺环境与未授权不变为PASS。

| 场景 | 前置/执行入口 | 实际操作/期望 | 本轮实际结果与范围 | 日志 |
| --- | --- | --- | --- | --- |
| 全新安装 | Build1084发行Host + payload、隔离根 | --install / --payload-core，创建程序/资源/测试注册表 | PASS RELEASE_INTEGRATION；CLEAN_VM_SUBSET也install exit0；单文件向导完整人工点击未验 | npm-test-final.log；windows-sandbox/output/sandbox.log |
| 普通用户启动 | 当前宿主未提升Token；另试客体普通用户 | 宿主隔离Host/SEA启动；客体创建标准用户 | HOST_FIXTURE通过；客体普通用户设置失败，独立普通用户干净安装NOT_RUN_ENVIRONMENT | 最终证据host.elevated=false；Build1083 normal-user-launcher.log |
| 中文/空格目录 | 测试安装、数据、菜单/桌面均带中文空格 | 新装/运行/退出/卸载；文件字节/版本核验 | PASS RELEASE_INTEGRATION；客体中文目录安装/卸载也成功 | rc-verification.log；sandbox.log |
| 非C盘安装 | TEMP/TMP/TMPDIR指向D盘受控目录 | 整个RC分类、安装目录/数据目录实际落D盘 | 11 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT；只操作本轮临时根 | rc-verification.log |
| WebView2初始化 | 宿主已安装Runtime；干净客体无Runtime | 实际Host启动、观察受控WebView子进程；客体记录错误 | 宿主RC过程PASS；客体明确缺WebView2，NOT_RUN_ENVIRONMENT；进程活着不等于HarborReady | npm-test-final.log / rc-verification.log；ui.stderr.txt |
| SEA Core运行 | --worker / --data-dir、随机Owner管道 | IPC握手/错误Token拒绝/Chat/Task/Memory/Workspace及重启 | PASS RELEASE_INTEGRATION；客体另验证SEA --help exit0，不把help算Core业务完成 | test-m6-pure-core-sea；test-core-dist；sandbox.log |
| Connector独立 | 正式SEA、受控假OneBot | start/stop/health/reconnect；故障后Core仍可用 | PASS RELEASE_INTEGRATION；真实QQ未测试/未外发 | test-channel-sea（npm-test-final.log / rc-verification.log） |
| Bionic独立 | 假网关、空账号分区，不接管Legacy资料 | Social child启停、开关独立、租约及状态 | PASS Fixture/Release Integration；8项真实Social未切换writer | test-bionic-runtime-lifecycle / test-channel-sea |
| 退出与资源 | 测试自建Core/Host/Worker | 优雅退出、受控崩溃、孤儿守卫、独占锁和WebView配置释放 | PASS限定测试PID/路径；没有关闭真实Core | test-release-candidate；test-desktop-shell |
| 覆盖升级/修复 | 受控旧版本和sentinel资料 | 程序更新，config/Task/Memory/Workspace/Secret bytes保持 | PASS隔离生命周期；debug安装器全生命周期与release安装/覆盖子集分别记，不冒充真实用户升级 | test-desktop-install；test-release-candidate |
| 卸载与重装 | 隔离安装及资料 | 卸载保留资料，重装恢复；remove-data只针对夹具 | PASS Fixture生命周期；客体正式卸载exit0；真实用户卸载/重装未执行 | npm-test-final.log；sandbox.log |
| 数据完整性 | 合成ID/Scope/Memory/Tasks及旧SocialHash | 重启/回滚/升级后核验，不改原Social | PASS Fixture/SEA；真实Social八项Hash不变；不代表M5-B完成 | M5 suites；M6 evidence |
| 损坏数据 | 合成Social/Workspace/Journal损坏 | 原件保留、未知状态不空覆盖、错误组件隔离 | Fixture及SEA Social隔离PASS；完整真实安装版损坏恢复仍NOT_RUN_ENVIRONMENT | test-whalebridge-core-isolation；test-m6-pure-core-sea；M5 suites |
| 单文件安装器向导 | IExpress setup文件 | PE/图标/封包/no-web校验，发行Host真实安装 | 封包/资源PASS；自解压向导完整点击与屏幕验收未执行，NOT_RUN_ENVIRONMENT | test-installer-package；test-desktop-runtime-dependencies |

本表日志均在 artifacts/verification/m6-build1084/；旧普通用户设置失败在 artifacts/verification/m6-build1083/windows-sandbox/output/normal-user-launcher.log。没有录制真实用户桌面或聊天截图。没有用UI存活/编译成功替代Harbor首屏、交互或原生Ready验收。

## 3. 干净Windows的实测发现

Build1082：客体Host install exit **-1073741515 (0xC0000135)**，PE表有未分发VC Runtime依赖。修复后Build1084的客体记录：

- elevated=True；普通用户完整验收仍未通过。
- VCRUNTIME140_PRESENT=False、VCRUNTIME140_1_PRESENT=False。
- install_EXIT=0、SANDBOX_INSTALL_PASS。
- core-help_EXIT=0、SANDBOX_SEA_HELP_PASS。
- UI_ALIVE=True，但 stderr明确“缺少Microsoft Edge WebView2 Runtime”。**此项不计Harbor初始化PASS。**
- uninstall_EXIT=0、SANDBOX_UNINSTALL_PASS；随后客体自动关机，所有客体测试进程/资料随临时VM退出。

result.txt中的COMPLETED只表示脚本步骤结束，不是完整产品验收。没有切换 --ui=legacy 绕过Harbor要求，也没有下载/升级第三方Runtime或改客体保护设置来取得PASS。

## 4. 安全与剩余门禁

真实Core PID/启动身份保持（证据记录于M6_VERIFICATION_EVIDENCE）；原Legacy锁未释放；用户独立DSH/网关没有被停止。测试中的强制崩溃仅针对自己创建的Core/Connector/Host/Fixture child；源码测试不使用真实/api/shutdown的全局守护清理。

真实资料迁移、真实备份、写入者停止、QQ Epoch启用分别仍未授权。旧8项Social、两个缺游标根和未知副作用保持原状。测试日志中安装迁移场景只操作工具分配的假state/roles，不是M5-B。

普通用户干净系统、完整Harbor和真实Provider/QQ验收、Windows10、正式签名/更新签名等门禁未关闭。静态CRT修复不解决WebView2冷机依赖；须Owner确认Runtime交付/前置安装策略并在合适环境验收。**RELEASE_BLOCKED**。
