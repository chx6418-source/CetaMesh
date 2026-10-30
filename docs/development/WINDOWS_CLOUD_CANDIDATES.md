# Windows 云端候选构建

Desktop 的常规候选生成使用私有 GitHub Actions 构建仓库。公开 CetaMesh 仓库继续执行源码、UI、统一测试与 Rust 检查；RELEASE HOLD 期间不在公开仓库生成或上传候选安装包。本流程不创建 GitHub/GitCode Release，也不修改现有客户端更新入口。

## Owner 授权与源码边界

当前唯一构建仓库为 `chx6418-source/whalebridge`，固定 repository ID 为 `1383743267`。脚本同时检查名称、ID、User 类型 Owner 和实时 private 可见性，复制到其他仓库不会自动获得候选构建权限。私有构建仓库保留自己的 Git 历史；公开源码快照不等于该私有分支的当前提交。

1. Owner 先审查目标提交和工作流，再单独批准将开发分支推送到私有构建仓库。本地未提交、未推送的修改不会进入候选。本流程的源码修改本身不授权推送、合并或远程运行。
2. 由 `chx6418-source` 本人手动触发 `ci.yml`，选定该分支，填写完整 `expected_commit`，选择 `dev` 或 `rc`，同时确认 `build_candidate=true` 与 `confirm_private_hold=true`。后者明确授权仅生成内部候选并保留 Defender RELEASE HOLD。
3. `expected_commit` 必须同时等于 dispatch 的 `GITHUB_SHA`、工作流的 `GITHUB_WORKFLOW_SHA` 和检出的实际 HEAD；checkout 固定到该 SHA。脚本记录实际 source tree，并拒绝脏工作区。分支移动、错误 SHA 或使用其他提交的工作流均会失败。
4. 原始触发者 `GITHUB_ACTOR` 和本次重跑者 `GITHUB_TRIGGERING_ACTOR` 都必须是 Owner。构建前和上传前通过固定 GitHub API 再核对仓库仍为私有、run/attempt、`workflow_dispatch`、`ci.yml`、源码 SHA、原始触发者和重跑者。协作者触发、其他仓库、无法读取 API 或身份不明一律拒绝。

需要从命令行选择开发分支时，Owner 可在审查并批准推送后手动执行以下模板；替换分支及完整 SHA，不要使用未审查的本地修改：

```powershell
gh workflow run ci.yml --repo chx6418-source/whalebridge --ref '<reviewed-branch>' `
  -f build_candidate=true -f confirm_private_hold=true `
  -f channel=dev -f expected_commit='<full-reviewed-commit-sha>'
```

授权来自经过 GitHub 身份校验的 Owner 手动 dispatch，不依赖可由普通输入自称的“已审批”标记。GitHub 的原始触发者与重跑者语义见 [变量说明](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)，运行详情由 [单次 workflow attempt API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt) 核对。仓库若另行配置受保护 environment，可增加独立审核，但不得删除上述 Owner、私有性或 SHA 校验。GitHub 私有仓库的 required reviewers 受套餐限制，见 [environment 可用性](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)；本工作流没有把未配置的 environment 名称当作审批凭证。

## 构建与下载校验

公共 `test` job 保持原有测试链和只读权限。私有候选 job 依赖其成功，再核对授权，构建 UI、Core SEA、Desktop Shell 并组装安装器。产品版本及 build number 使用 `release/version.json` 的 canonical 值；`rc` 还要求 canonical 渠道为 rc。GitHub Run Number 不代替产品版本计数。

候选 job 仅申请 `contents: read` 和 `actions: read`。API token 只传给两个校验步骤，checkout 不持久化 Git 凭据；安装依赖和构建命令不接收该 token。远程账号凭据、真实配置和用户数据不注入 Runner，工作流不申请内容写权限或调用发布接口。

完整 release 目录先通过文件哈希、清单及来源检查，再生成独立上传目录。Artifact 名为 `cetamesh-desktop-windows-x64-<channel>-<version>-<commit-prefix>`，只包含：

- `CetaMesh-Setup-...exe`，保持对外 CetaMesh 品牌；
- 原始 `release-manifest.json`、`sbom.json` 与许可证文本；
- `candidate-provenance.json`，记录 sourceCommit/sourceTree、仓库 ID 与可见性、Owner 手动授权、run/attempt、渠道、版本、build number 及 `releaseState: HOLD`；
- 下载目录自身的 `SHA256SUMS.txt`，每个条目都对应实际上传文件，包含 provenance。原始完整 release 目录的 checksum 文件哈希另记在 provenance 中。

下载后先逐项校验 `SHA256SUMS.txt`，再核对 provenance 与原始 release manifest 的 commit/channel/version/buildNumber 一致，并与预期私有 GitHub Run 及 source tree 对照。原始 release manifest 仍保留完整组装目录的 `files` 记录，其中内部 Shell/Core/payload 不作为独立下载文件；不要把它的完整文件列表当作下载目录清单。provenance 是可核对的构建记录，不是代码签名、恶意软件放行或独立的加密证明。

内部 `WhaleBridge.exe` / `WhaleBridgeCore.exe`、IPC、`WHALEBRIDGE_*`、存储路径与 Cargo/npm 包名保持兼容。上传采用明确的文件白名单，不上传原始 Shell/Core、完整 payload、开发状态或原始测试日志。候选仅保留在私有仓库 Artifact 中 14 天；保留 HOLD 产物期间，仓库必须持续保持 private。

## 验收与失败状态

测试失败继续以非零退出，公共 CI 保留原有最小测试诊断。源码与合成候选测试通过只说明门禁和文件完整性成立。只有对应私有 Run 实际成功并核对下载文件后，才能记为云端候选构建 PASS；没有批准推送或 dispatch 时记为 `BLOCKED_AUTHORIZATION` / `NOT_RUN`，不能引用旧构建代替当前提交。

此候选只供内部安全审查。完整性通过不代表安装、Native WebView2、Guest、真实 QQ/DSH 或恶意软件定性通过。Defender RELEASE HOLD 未解除前，不恢复隔离文件、不关闭防护、不运行被标记的候选、不发布正式版本。真实 Hyper-V Guest 验收要求独立授权宿主、镜像和资源，发行门禁继续单独判断。

[GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
