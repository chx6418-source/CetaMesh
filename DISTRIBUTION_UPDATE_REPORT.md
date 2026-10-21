# DISTRIBUTION_UPDATE_REPORT — CetaMesh Distribution / GitCode Update Runtime

**日期：** 2026-10-08（上线冲刺任务 A）
**分支：** Desktop `release/gitcode-update-source-v1` · Mobile `release/gitcode-update-source-v1`
**范围红线（遵守）：** 未改动 Desktop 的 Device Mesh / 主题（`desktop-shell/src/theme` 属并行会话）/ Extension ProcessHost；未触碰其它并行会话文件；未对任何远端 push。

## 1. Git 基线与最终版本

| 仓库 | Base | Final（本报告生成时的源码 HEAD） | 分支 |
| --- | --- | --- | --- |
| Desktop | `e8a122a`（本地 `main` 集成点） | `b0888e3` | `release/gitcode-update-source-v1`（自 main） |
| Mobile | `0f38a8d`（`origin/main`，含 fix/device-feedback-round4） | `be996bf` | `release/gitcode-update-source-v1`（自 origin/main） |

**GitCode 远端核对（两个仓库均已配置并 fetch，未 push）：**

- `gitcode` remote = `https://gitcode.com/ygdnn/CetaMesh.git`；`gitcode/main` = `5633dd7`「Initial commit」（仅 1 个 `LICENSE` 文件）。
- Ancestry 检查：`gitcode/main` 与 Desktop `main`（e8a122a）/ Mobile `main`（0f38a8d）均**不构成祖先关系** —— 镜像历史不兼容。
- 按任务要求：**停止推送并如实报告**。未做 force push、未覆盖任何 GitCode 内容。
- 现状解读：GitCode 仓库是一个新建的**发布 / 下载仓库**（单初始提交），不是任一主仓库的历史镜像。若后续希望它成为代码镜像，需要一次性人工建立镜像关系（本会话未执行，交由最终集成会话决策）。

## 2. GitCode 仓库能力实测（2026-10-08，匿名访问、无凭据、不猜 API）

| 端点 | 实测结果 |
| --- | --- |
| `GET /api/v5/repos/ygdnn/CetaMesh/releases` | 200 `application/json`（当前为 `[]`，尚无 Release） |
| `GET /api/v5/repos/ygdnn/CetaMesh/releases/latest` | 400 `未找到 release`（结构化错误，而非空 200） |
| `GET /api/v5/repos/ygdnn/CetaMesh/branches` | 200（`main`，1 个初始提交） |
| `GET /api/v5/repos/ygdnn/CetaMesh/raw/<path>` | 200 原始文件字节（官方 raw API；以 LICENSE 实测 35,140 字节） |
| `GET /api/v5/repos/ygdnn/CetaMesh/contents/` | 200 JSON 列表，含 `download_url` |
| `GET https://raw.gitcode.com/ygdnn/CetaMesh/blobs/<blob>/<path>` | 200 原始文件字节（contents API 给出的下载地址） |
| 网页端 `/-/raw/` 与 `/raw/` 路径 | 返回 SPA HTML（**不是**原始文件），不采用 |

- **凭据：** 本机没有 `GITCODE_TOKEN`，也未发现任何 GitCode 凭据 → 发布执行 = `NOT_RUN_ENVIRONMENT`。
- Release 附件（Asset）上传端点在无凭据下无法实测 → **未写入自动上传逻辑**，只输出精确人工步骤（不猜 API）。

## 3. 统一 Release Manifest

- 格式（schemaVersion 1，平台中立，Desktop / Mobile 共用同一份，不建第二套格式）：

```json
{
  "schemaVersion": 1, "product": "CetaMesh", "channel": "stable",
  "version": "1.0.0", "publishedAt": "...", "sourceCommit": "...",
  "notes": ["..."],
  "artifacts": {
    "windows-x64": {"filename": "...", "url": "https://...", "sha256": "...", "bytes": 0},
    "android":     {"filename": "...apk", "url": "https://...", "sha256": "...", "bytes": 0}
  },
  "signature": "<Ed25519(base64)，对原始对象除 signature 外全体字段签名>"
}
```

- **发现入口：** GitCode 仓库内版本化清单 `releases/stable.json`（小文件、可审计、与 Release 解耦），经官方 raw API 拉取：
  `https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main`
- **大文件：** 42MB 安装器 / 30MB APK 一律走 Release Asset 附件；Git 历史只入库 `releases/stable.json`（脚本对 >1 MiB 产物显式提醒禁止 commit）。
- **兼容：** 旧扁平 `downloadUrl` + `sha256` 清单照旧可用（`selectArtifact` 回落，`test-update-source` 有针对回归）；Desktop 仍强制 Ed25519 验签（无 pinned key 即停用，fail-closed）。
- **签名一致性已实测：** 发布侧 `signManifest` 产出的签名清单，被本仓库 `validateManifest` + `verifyManifestSignature` 接受（`SIGNATURE_OK`）。

## 4. Desktop Updater（`src/update/`）

- **UpdateSource 优先级：** `gitcode` → `github`。设置默认值为实测端点：`updates.manifestUrl`（GitCode raw API）+ 新增 `updates.fallbackManifestUrl`（GitHub raw）。
- **单源 deadline 6s（5–8s 档），2 个源合计 ≤ 12s**；下载超时独立处理（默认 5 分钟），互不牵连。
- **语义（结构化区分，绝不静默）：** 合法清单判定即权威 —— 合法「无更新」直接返回且**不访问备用源**；404 / JSON 损坏 / 验签失败 / 缺本平台安装包 / 下载主机被拒 → 记录该源失败并降级；全部失败 → per-source 诊断数组（`sources` / `tried`）。
- **下载管线**（`src/update/download.js`，独立模块；checker 本体仍无 download/execute 入口，阶段 12 红线保持）：
  https 强制 · 主机白名单 · 逐跳重定向校验（≤5 跳；重定向到 http 或白名单外主机即失败）· 体积上限（默认 512 MiB）· 全下载超时 · **SHA256 必填**且流式校验 · 原子落盘（`.part-<random>` → rename）· 任何失败清理部分文件 · 目标已存在拒绝覆盖 · **从不执行**下载物（安装仍由用户确认，handoff 语义不变）。
- **IPC：** `update.check` / `update.download`（绝对 `targetDir` + 纯文件名校验）/ `update.config`（暴露主源与备用源；公钥仍只显示 `[configured]`）。
- **UI：** 桌面壳当前没有更新页（`update.*` 是 IPC 面）；按任务红线本会话未动任何 Rust / 主题 / 壳代码，壳内 UI 集成留给最终集成会话。

## 5. Mobile Updater

- `src/app/bootstrap/updateSource.ts`：**GitCode 主源**（`GitCodeManifestUpdateService`，拉取 `releases/stable.json`，6s timeout）→ **GitHub 备用源**（`GitHubReleaseUpdateService`，既有实现未重写，仍指向公开仓库 `chx6418-source/CetaMesh`）。
- **安全逻辑保留：** 只有 `artifacts.android` 中**真正的 .apk**（https + sha256 64 位十六进制 + bytes）才算 installable update；GitHub 侧沿用「含 `.apk` asset 才算」；缺 APK **不弹「有新版本」**，而是降级。
- **语义：** GitCode 合法「无更新」→ `current`（不访问 GitHub）；GitCode 失败（网络/超时/清单损坏/缺 APK）→ GitHub；两源都失败 → `unavailable`（诚实语义，绝不当作已最新）。
- About 页在发现新版本时显示下载源（「下载源：GitCode」/「下载源：GitHub 备用」）。
- 未改动 Device Mesh / 主题 / Extension ProcessHost。

## 6. 发布脚本 `scripts/sync-gitcode-release.mjs`

- 参数：`--version --channel --source-commit --artifact platform=file（可多个）--notes --signing-key --asset-url（实测 URL 覆盖）--out --publish`。
- 产出：`releases/stable.json`（可签名）、`SHA256SUMS.txt`、`release-assets.json`（Release 附件元数据：filename / bytes / sha256 / 版本 / commit）。
- 凭据：只从环境变量 `GITCODE_TOKEN` 读取，**未写入源码**。本机无凭据 → 输出 `NOT_RUN_ENVIRONMENT` + 6 步精确人工发布命令（含 Release 创建 URL、附件清单与 sha256、清单入库命令、raw API 验证 curl、带凭据核对命令）。
- 已实测：清单生成 + 签名 + 本仓库验签通过（离线路径完全可跑）。
- 未实测（NOT_RUN_ENVIRONMENT）：真实 Release 创建 / 附件上传（无凭据；上传端点未经本机验证，脚本不伪造成功）。

## 7. 测试结果

**Mobile（`npm run check`，全绿）：** typecheck PASS · lint PASS · architecture PASS · jest **70/70 suites、278/278 tests**（含新增 `gitcode-update-source.test.ts` 编排回归 + 更新的 `update-source.test.ts`）。

**Desktop：**

- 新增 `scripts/test-update-source.mjs`：**57 项全部通过**（已登记 `run-all-tests`）。覆盖：GitCode 成功 / 合法无更新不访问备用源 / 超时→降级 / 5xx→降级 / 清单损坏→降级 / 验签失败→降级 / 404→降级且绝不当作无更新 / 缺本平台安装包 / 全源失败 per-source 诊断 / 旧扁平清单兼容 / 版本回退与同版本；下载：SHA 匹配与不匹配、体积上限（流式 + Content-Length 预检）、重定向逐跳校验（http / 白名单外 / 缺 location / 超跳数）、超时、原子落盘、部分文件清理、目标存在拒绝、sha256 必填、路径穿越拒绝。
- 全套件聚合（**修复前**）：`67 PASS · 3 FAIL · 4 NOT_RUN_ENVIRONMENT`；三个 FAIL 归因：
  1. `test-error-hygiene` —— **本任务引入**（`download.js` 3 处 catch 仅含注释，被红线判定为裸 catch）→ **已修复并复跑 PASS**（当前 110 ≤ 基线 111）。
  2. `cargo:test` —— 共享工作区中**并行会话** `feature/native-theme-fidelity-v1` 的未提交主题代码编译错误（`src/theme/spec.rs` / `src/theme/mod.rs`）；本任务无任何 Rust 改动。
  3. `test-desktop-shell` —— 等待「主题已应用：深色」日志超时；使用工作区中 **2026-10-06 的旧 debug 二进制**（早于并行主题会话当日编辑），本任务无任何壳 / 主题改动。
- 修复后复跑：`test-error-hygiene` PASS、`test-update-source` PASS（57/57）。

**NOT_RUN_ENVIRONMENT：** 真实 GitCode Release 发布（无凭据）/ 真实 provider-key 回合 / 真实 QQ / 跨设备 Mesh / 签名 / 真实发行产物（沿用前次会话如实记录）；`test-console`、`test-mcp-exec`、`test-onebot-connection`、`test-mcp-web-search` 如实跳过。

## 8. 中国网络环境与体验

- 每个发现源 6s deadline（5–8s 档），最坏 2 源合计 ≤12s，不会「GitCode 失败后无限等待 GitHub」。
- 下载大文件超时与发现超时解耦（下载默认 5 分钟，可配）。
- `source` 记录：Desktop check 结果带 `source`（gitcode/github）+ 失败时 `sources[]` 逐源诊断；Mobile `UpdateCheck` 带 `source`；UI 不暴露技术细节，仅在发现新版本时显示来源。

## 9. 交付物清单与后续

**Desktop（`release/gitcode-update-source-v1`，b0888e3）：** `src/update/{sources,download,checker,manifest,service,index}.js`、`src/settings/schema.js`、`scripts/{sync-gitcode-release,test-update-source}.mjs`、`scripts/run-all-tests.mjs`。
**Mobile（`release/gitcode-update-source-v1`，be996bf）：** `src/providers/update/{GitCodeManifestUpdateService,FallbackUpdateService}.ts`、`src/app/bootstrap/updateSource.ts`、`src/domain/update/UpdateService.ts`、`src/features/about/AboutAppScreen.tsx`、`src/test/{gitcode-update-source,update-source}.test.ts`。

**交由最终集成会话：**

1. 集成上述两个发布分支（本会话按约定停止，未合并、未 push）。
2. 人工首发：创建 GitCode Release → 上传附件 → 用实测附件 URL 生成签名清单 → 入库 `releases/stable.json` → raw API 验证（脚本已给出精确命令）。
3. 桌面壳更新页（Rust UI）与「检查 → 下载（校验）→ 用户确认安装」的 UI 接线。
4. 若需 GitCode 成为代码镜像：一次性人工建立镜像关系（当前历史不兼容，未推送）。
