# Windows 云端候选构建

Desktop 的常规候选生成优先使用 GitHub Actions；普通开发可运行源码、UI 与受影响测试，无需本地完整 Release 编译。

1. 经 Owner 批准将已审查提交推到开发分支。在 GitHub 的 Actions → ci → Run workflow 选择该分支，填写完整的 expected_commit，勾选 build_candidate，并选择 dev 或 rc。实际 HEAD/tree 和干净工作区均被核对；expected_commit 必须与远程分支的 GITHUB_SHA 一致，本地未推送修改不会进入候选。
2. 测试、Rust 检查通过后构建 UI、Core SEA、Desktop Shell，并组装安装器。版本和 build number 使用 release/version.json 的 canonical 值，Artifact 名包含渠道、版本和 commit；GitHub Run Number 另作本次工作流标识，不改产品版本计数。
3. 下载 `cetamesh-desktop-windows-x64-<channel>-<version>-<commit>`，检查 release-manifest.json 的 sourceCommit/channel/buildNumber，并使用 SHA256SUMS.txt 校验。下载包包含 CetaMesh-Setup-...exe、清单、SBOM 与许可证。
4. 此候选只供内部安全审查。完整性检查通过不代表安装、Native WebView2、Guest 或恶意软件定性通过。Defender RELEASE HOLD 未解除前，不恢复隔离文件、不关闭防护、不运行被标记的候选、不发布正式版本。

失败的测试仍以非零退出；工作流保留最小测试日志。远程凭据、用户数据、真实账号测试不注入公共 Runner。真实 Hyper-V Guest 验收要求独立授权宿主、镜像和资源。

对外 Artifact、安装器文件及安装显示名称使用 CetaMesh；内部 WhaleBridge.exe/WhaleBridgeCore.exe、IPC、WHALEBRIDGE_*、存储路径与 Cargo/npm 包名保留兼容，避免破坏已有安装和更新入口。候选上传仅选择外层 CetaMesh 安装器与必要清单，不上传内部 Shell/Core 作为面向用户的独立文件。不自动创建 GitHub/GitCode Release。

[GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

为遵守未安全放行产物不向公众分发的门槛，RELEASE HOLD 期间 candidate job 仅在私人仓库运行；公开仓库照常测试源码。手动构建应在同步后的私人构建仓库选择开发分支。公开仓库勾选 build_candidate 仍不上传候选二进制。
