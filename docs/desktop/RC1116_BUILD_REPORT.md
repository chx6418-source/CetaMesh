# RC Build1116 构建验收报告

日期：2026-10-22。Owner已授权本地提交并创建RC；不合并、不推送、不发布、不覆盖真实安装。

## 源码与产物

- 分支：`codex/app-icon-refresh`。
- 实际打包源码：`c47253a860a9945e05054d51d06f957f51067f33`，构建时源码干净，`dirty=false`。
- 版本：`1.0.0-rc.2`；channel：`rc`；Build：`1116`。
- Build ID：`1.0.0-rc.2-build1116+c47253a`。
- 安装包：`D:\GIT- CetaMesh\comm-repair\artifacts\rc\1.0.0-rc.2\build-1116\CetaMesh-Setup-1.0.0-rc.2-build1116-x64.exe`。
- 大小：43,253,760字节（41.25 MiB）。
- SHA-256：`A40522EF39249A7F02CE8FFEC3F62F197D83A711E34115761ED3EC2ABA8B3FB4`。
- Authenticode：`NotSigned`。

本报告在产物验证完成后补录；报告文档提交不改变上述实际打包源码。保留产物所在工作树，不修改已校验的正式产物。

## 包含变更

Owner提供的绿色程序图标、纯文字主题标题栏、移除重复品牌和全局顶栏、输入框上方默认折叠的任务卡片、简洁输入区、侧栏底部固定及统一活泼动效。详情见同目录RC1116_RELEASE_NOTES.md及各UI报告。

## 本轮实际验证

| 检查 | 结果 |
| --- | --- |
| `npm test -- --category core --category architecture --category security --category runtime --category integration --category desktop`，启用WHALEBRIDGE_TEST_CARGO | 139 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT；包含Cargo check/test |
| build:core、build:ui、desktop:build、desktop:build:debug | 全部通过 |
| `npm run build:release -- --use-current-build-number` | 正式RC构建通过 |
| `npm test -- --category release --verbose`，图标目标指向最终安装包 | 12 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT |
| 额外`npm test -- --suite test-app-icon --verbose`，目标指向最终Host | 1 PASS / 0 FAIL |
| SHA256SUMS全部31项重新计算 | 31/31通过 |
| build-info / release-manifest及最终renderer标记检查 | rc、Build1116、c47253a、dirty=false；本轮UI标记存在 |
| `git diff --check` | 通过 |

发行类唯一NRE是test-comm-dev-release：该Build没有DEV发行目录，本轮创建的是正式RC。正式RC安装验收已通过，不能把此NRE表述为正式RC安装未验证。

实际发行测试包括中文及空格路径安装、无系统Node运行、私有IPC、无HTTP服务、安装目录只读运行、测试Core崩溃恢复、二次启动与单Core、孤儿进程保护、卸载保留隔离数据、SEA插件退出及Broker授权/拒绝等场景。测试针对隔离安装和临时数据；测试结束无遗留测试进程。没有覆盖真实用户安装。

证据目录：`D:\GIT- CetaMesh\comm-evidence`，日志前缀`rc1116-`，包括source-tests、core-build、ui-build、release-host、debug-host、package-build、release-tests和host-icon；额外产物校验脚本为verify-rc1116.mjs。

## 剩余限制与发布状态

- 安装包未签名，不能声称已满足SmartScreen或Stable发布条件。
- 本轮未验证Windows10 x64；真实WebView2标题栏拖动、双击、缩放、多显示器及真实系统减少动态效果切换仍需Owner验收。最大化按钮悬停的Windows Snap Layout面板尚未实现。
- SEA/Broker集成测试不等于真实Codex、DSH、QQ、手机及全部MCP服务验收；未声称这些链路已在本轮全面通过。
- 凭据泄露扫描中的本机config.json对照项因不存在该文件而跳过；不是PASS。禁止产物及构建机路径审计通过。
- Staging不等于OS沙箱；本轮未放宽Capability Broker、Owner审批或Workspace授权。
- 整体状态继续为`RELEASE_BLOCKED`。未合并、推送、发布或升级真实安装。
