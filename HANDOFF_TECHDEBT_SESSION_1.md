# HANDOFF — 技术债收口会话 1：Release HTTP 完整移除 + 测试入口/CI + 仓库卫生 + 静默失败红线

日期：2026-10-07

## Git

- Base HEAD：`9c882de`（main，"build(release): verify final desktop rc"）
- 工作分支：`fix/release-surface-and-ci`
- Final HEAD：本文件所在提交（RC 以其前一提交 `eb9b728`…见下方「Release Candidate」——实际以
  release-manifest.commitShort 为准，最终重建在全部提交完成后执行并回填于「汇总」一节）
- 未 push；Owner 确认后合并 main 并删除工作分支。
- 逻辑提交清单：
  1. `fix(release): remove legacy http from native release`
  2. `test(release): assert no-http runtime surface behavior`
  3. `test(ci): add unified test runner and windows ci`
  4. `test(architecture): forbid unannotated silent failures`
  5. `chore(repo): harden generated-file hygiene`

## D1 final architecture（release HTTP 完整移除）

```
HTTP（旧 Web 控制台）：
  release / native = 服务器根本不存在（不创建、不 bind、3100 不可连接）
  源码开发         = 默认 OFF；显式 WHALEBRIDGE_LEGACY_HTTP=1 才启动（日志标记 LEGACY DEV SURFACE）
                     发行构建（SEA）中该 env 被忽略并告警 —— 发行版无法自动开启
MCP / Agent 数据面：
  mcp-snowluma-safe / mcp-host-server
    → dataCall()（src/control/data-ipc.js，named pipe 客户端）
    → \\.\pipe\WhaleBridge-Data-<fnv1a32(数据目录)>（WHALEBRIDGE_DATA_PIPE 可覆盖）
    → worker 的 startDataIpcServer（methodFilter 只放行 data.call）
    → 虚拟 HTTP req/res 还原 → handleApiRequest（与 legacy HTTP 共用同一路由体）
    → 既有 agent 白名单 / 会话级 agentToken 闸门（零语义漂移）
管理面（Control Plane）：
  原生壳 → \\.\pipe\WhaleBridge-UI-<shell pid> → startUiIpcServer → controlService（不变）
```

### 关键决策

1. **D1-001 运行模式判定收拢**：新模块 `src/runtime-surface.js` 的
   `resolveRuntimeSurfacePolicy()` 返回 `{ surface, nativeControl, localDataIpc, legacyHttp, legacyHttpRequested }`。
   bridge.js 不再散落读取 `WHALEBRIDGE_UI_PIPE` / packaged 标志；surface 取值
   `native-release / native-dev / headless-dev / legacy-web-dev`。
2. **D1-002**：`startConsoleServer` 改名 `startProductSurfaces`；HTTP listener 抽成
   `startLegacyHttpServer()`，仅在 `surfacePolicy.legacyHttp` 时创建。release/native 模式下
   `http.createServer` 根本不执行（不是 403，是 server 不存在）。
3. **D1-003 数据面迁移**（完整，不留半成品）：
   - 依赖 loopback HTTP 的 MCP 只有 2 个：`mcp-snowluma-safe.js`（~35 条 socialV2/send/images/status 路由）
     与 `mcp-host-server.js`（仅 `/api/status` 模式门禁）。其余 3 个 MCP（qq-file-send / web-search-safe / bilibili）
     只访问外部 HTTP，无需迁移。
   - 新模块 `src/control/data-ipc.js`：服务端（`startDataIpcServer` / `executeDataCall`）+ 客户端（`dataCall`）+
     pipe 命名（按数据目录 FNV-1a 派生，worker 与 DSH spawn 的 MCP 进程各自推导出同名 pipe，不依赖 env 传递）。
   - `control/ipc-protocol.js` 新增可选 `methodFilter`：数据 pipe 只接受 `data.call`，`control.execute`
     与产品私有方法族（chat.*/settings.*/…）一律 METHOD_NOT_FOUND —— **Control Plane ≠ Data Plane（D1-004）**。
   - 数据面契约：协议版本 1、4 字节 LE 长度前缀 JSON 帧（与 UI IPC 同族）；帧上限 16 MiB
     （图片 base64 走 JSON）；dispatch 超时 760s（覆盖 qq_wait_for_messages 的 725s 上限）；
     客户端超时 → abort 信号 → shim req 'close' → wait 路由的 activeWaits 正常释放。
   - 传输替换是**逐点等价**的：`agentApi(path, init)` 签名与错误形状不变，~40 个调用点零改动。
4. **D1-005**：legacy HTTP 默认 OFF + 显式 opt-in + 启动/忽略均打日志（LEGACY DEV SURFACE）+
   SEA 产物内 env 无效；`public/console.html` 等开发历史资源保留（本轮不删源码，只不发布不启动）。
5. **单实例语义**：端口占用曾是 dev 模式的第二单实例信号；D1 后 release 不监听端口，
   唯一判据回归锁文件 `state/bridge.lock`（活跃 PID → exit 2）。supervisor 语义不变。

## 测试聚合（D2）

- `scripts/run-all-tests.mjs`：**全量登记 61 个 `scripts/test-*.mjs` + 2 个 cargo 套件（共 63）**。
  - 孤儿检测：新文件不登记 → 聚合器直接 FAIL（"脚本存在但没人跑"不可能再发生）。
  - 分类：core / architecture / security / runtime / integration / desktop / release / environment。
  - 依赖真实环境的 suite（真实网关 / 公网 / 发行产物 / Rust 工具链 / 运行中的 legacy 桥接）
    探测不满足时如实报 `NOT_RUN_ENVIRONMENT`（不计失败也不计通过）。
  - `npm test` 默认串行；`--jobs N` 可并发；`--category` 过滤；`--list` 列清单。
- package.json 新增：`test`、`test:core/architecture/security/runtime/integration/desktop/release/environment`、
  `test:no-web-release`、`test:error-hygiene`。
- 本轮收编的孤儿测试（此前没有任何入口会跑它们）：test-console、test-control-service、
  test-desktop-chat-product、test-extension-capability、test-ipc-protocol、test-mcp-exec、test-mcp-host、
  test-mcp-safe、test-mcp-web-search、test-no-web-release、test-onebot-connection、test-owner-agent-mode、
  test-process-extension-host、test-smart-platform-routing、test-workspace-ipc。

## CI（D2）

- `.github/workflows/ci.yml`：
  - `test` job（windows-latest / Node 22 / Rust stable / rust-cache）：`npm ci → npm test → desktop:check → desktop:test`。
    CI 不依赖真实 QQ/DSH/Key —— 网关类 suite 自动 NOT_RUN_ENVIRONMENT。
  - `release-build` job：仅 main push 或手动触发；`build:core → desktop:build → build:release → test-release-candidate`，
    产物上传 artifact（14 天）。

## 仓库卫生（D10）

- `.gitignore` 补登记：`/output/`、`/desktop-shell/native-spike/`、`/%SystemDrive%/`、
  `/desktop-shell/target-released/`、`/scripts/.test-runner/`（目录当前不存在，防再入库）。
- 未删除任何 tracked 正式文件；未触碰未跟踪的本机文件。
- 遗留本地分支 `codex/d1-unified-config-service`（ahead 12 / behind 58）与
  `codex/theme-visual-rework`（ahead 1 / behind 0）**未删**——需 Owner 决定。

## 静默失败红线（D13）

- 新增 `scripts/test-error-hygiene.mjs` + 基线 `scripts/error-hygiene-baseline.json`：
  - 产品代码（src/**）内**裸 `catch {}`（无注释吞错）逐文件锁基线**（当前 112 处，全部为历史存量）；
    任何文件新增即 FAIL。规则：允许空 catch 的唯一形式是带说明注释（best-effort cleanup /
    expected optional probe / already-gone resource）。
  - `process.exit(` 与 `setInterval(` 同样逐文件锁基线：只属于 entrypoint / lifecycle / legacy runtime，
    业务 Runtime 新增即 FAIL。基线只许收紧（`--update-baseline` 在减少后使用）。
  - 与 `catch {}` 机械加日志相比，基线法保证"存量可审计、增量必留痕"。
- 本轮接触的生命周期：data IPC / legacy HTTP / UI IPC 服务面 start 均为一次性（幂等），
  `process.once('exit')` 尽力关闭；错误路径显式 log + exit（fail fast，不静默降级）；
  新增代码未引入任何裸 catch（基线内 112 处全部为未触及的历史代码）。

## 行为化测试（D1-006/D1-007，新契约）

- `scripts/test-no-web-release.mjs` 扩展为 **行为测试**：
  1. 策略单元断言（surface 矩阵，含 SEA 禁用 legacy opt-in）；
  2. native worker（UI pipe + data pipe）：`/api/status` 经数据面 IPC 真实请求成功（agent-token）；
     **TCP connect consolePort 必须 ECONNREFUSED**；`control.execute` / `settings.*` 在数据 pipe 上
     METHOD_NOT_FOUND；非白名单 API 路径 403；
  3. headless worker：同上（数据面恒可用）；
  4. legacy opt-in worker：HTTP 才存在（401/404/200 鉴权语义保持）。
- `scripts/test-core-dist.mjs`：三段 worker 场景全部改为「数据面 IPC 就绪 + consolePort 连续拒连」；
  保留 agent-token/bridge.lock/只读安装目录/无 node.exe 断言。
- `scripts/test-release-candidate.mjs`：manifest 断言新增 `legacyHttp === false`
  （release-manifest + payload/runtime-manifest）；运行期验收改为「数据面 IPC 健康 + consolePort 拒连」；
  崩溃恢复后复验同样走数据面 IPC。
- `scripts/test-desktop-shell.mjs`：native 模式断言从「HTTP 403」改为「consolePort 拒连」；
  单实例冲突场景从「占端口」改为「锁文件写活跃 PID」（D1 后端口不再是信号）。
- `scripts/test-desktop-supervisor.mjs`：worker 环境加 `WHALEBRIDGE_LEGACY_HTTP=1`
  （该测试本身就是 legacy 面 /api/restart、/api/shutdown 的行为验收）。

## Tests run（本会话）

- 全量 `npm test`（64 suites）：**59 PASS · 1 FAIL · 4 NOT_RUN_ENVIRONMENT**
  - 唯一 FAIL：`test-desktop-shell` 末段「深色主题应用日志」超时 —— **在 base `9c882de` 上
    stash 后复现同样的失败**，属既有问题/环境敏感（Rust 侧主题日志），与 D1 改动无关；
    该套件其余全部段（smoke/重启链路/单实例/GUI 无 HTTP listener/托盘）本轮 PASS。
  - NOT_RUN_ENVIRONMENT（本机无对应真实环境，如实记录）：test-mcp-exec（无 SnowLuma 网关）、
    test-onebot-connection（无网关）、test-mcp-web-search（公网，需 WHALEBRIDGE_TEST_NETWORK=1）、
    test-console（需运行中的 legacy dev 桥接）。
  - 此前修复：test-workspace-ipc（孤儿漂移断言，越界错误码经 Capability Broker 归一化）；
    test-core-entry（worker 就绪改数据面 IPC）。
- 单套验证：test-no-web-release（行为段）PASS；test-desktop-supervisor PASS（legacy opt-in）；
  test-core-dist（重建 dist/core 后）PASS；test-desktop-install PASS；cargo:check / cargo:test PASS。

## Release Candidate

- 在最终代码 HEAD（`eb9b728`，交接文档提交前的最后一个代码提交）重建并验收：
  `npm run build:core` → `npm run desktop:build` → `npm run build:release` → `npm run test-release-candidate` **全 PASS**。
- RC 行为验收（发行包真实安装运行）：数据面 IPC 健康、**consolePort 拒连（无 HTTP server）**、
  只读安装目录逐字节不变、崩溃恢复 5579ms 退避拉起、单实例、孤儿守卫、卸载保留数据。
- release-manifest：`noWebUi=true`、`legacyHttp=false`（runtime-manifest 同）；
  发行审计（禁止项/构建机路径/凭据泄漏）通过。
- dirty 标记说明：`9c882de→eb9b728` 全部为代码/测试/CI/文档提交；交接文档提交后如需
  `dirty=false` 的形式化 RC，可在合并 main 后由 CI 的 release-build job 重建（或本地再跑一次 build:release）。

## 汇总（完成后回填）

- npm test：59 PASS · 1 FAIL（既有主题段超时，base 复现）· 4 NOT_RUN_ENVIRONMENT
- build/RC：build:core PASS · desktop:build PASS · build:release PASS（审计通过）·
  test-release-candidate 全 PASS（consolePort 拒连 + 数据面 IPC 健康为新增验收项）

## Remaining work for Session 2

- D3 Storage Primitive（`loadConfig`/state JSON 存取收口为 Storage 层）
- D12 State Retention（会话/记忆状态保留策略）
- D7 文档瘦身（根目录报告/历史文档归档；AGENT_CONTEXT.md 已自标 SUPERSEDED，
  其「仓库卫生·审计」清单中剩余条目——design-demos 组装链、硬编码本机路径、测试端口隐式依赖——并入该会话）
- 建议：历史裸 catch 存量（112 处）按 config/storage/security/permission/lifecycle 优先级逐类消化并收紧基线。
- 建议：桌面壳 `supervisor.rs` 的 HTTP 探活 fallback（`ipc_pipe: None` 时）已成死代码，
  可在后续会话删除（本轮为最小 diff 未动 Rust）。

## 已知边界（不装完成）

- `test-console.mjs` 需要「运行中的 legacy dev 桥接」才有意义，聚合器按环境探测记 NOT_RUN_ENVIRONMENT。
- 深色主题日志超时（既有问题，base 复现）未在本轮修复。
- 数据面 IPC 的 DACL 沿用默认用户会话 ACL（与读取 state/agent-token 同一信任边界），
  未做显式 ACL 收紧 —— 与既有 UI pipe 一致。
