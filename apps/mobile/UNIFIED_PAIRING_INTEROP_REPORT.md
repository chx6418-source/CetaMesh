# 统一设备配对互操作报告 — Desktop ↔ Mobile（上线冲刺任务 B）

**生成日期：** 2026-10-08
**范围：** CetaMesh Desktop（`chx6418-source/whalebridge`）× CetaMesh Mobile（`chx6418-source/cetamesh-mobile`）
**协议事实源：** `docs/protocol/UNIFIED_PAIRING_V1_1.md`（两个仓库各一份逐字节相同的副本）

## Git 基线

| 仓库 | 分支 | Base | 实现 HEAD |
| --- | --- | --- | --- |
| Desktop | `feature/unified-device-pairing-v1` | `e8a122a`（= 当时 `main`） | `18a2d5d20055c8b0484c2922633d80e261c15d79` |
| Mobile | `feature/unified-device-pairing-v1` | `0f38a8d`（= 当时 `origin/main`） | `0eb8947af4f5fa7472364368c65782a8560fe188` |

- 上述"实现 HEAD"= 两端各自的实现提交；本报告与 `PROJECT_STATE.md` 的更新是其后的文档提交
  （`git log -- UNIFIED_PAIRING_INTEROP_REPORT.md` 可查）。
- 协议文档与 `fixtures/pairing/` 两端 blob 级逐字节一致（已用 `git show HEAD:<path> | sha256sum` 核对）。

- 两个仓库都**只在各自分支上本地提交**，未 push、未合并 `main`；按约定等待 Owner 确认后再合并并删除工作分支。
- 未把一个仓库的源码复制进另一个仓库；共享物仅限：协议文档副本、`fixtures/pairing/` 测试向量、本报告副本。

## Pairing Protocol（配对协议）

- 基线 = Mobile 已实现的 **M3 Pairing v1**（`pairing.invitation` / `exchange` / `challenge` / `confirm` / `accepted`、
  一次性 token、签名 transcript、两段确认）；本轮**增量升级为 v1.1**，信封 `version` 仍为 `1`，新字段全部可选：
  - `payload.tlsPin`（证书指纹）与 `payload.peer.keyAlgorithm`（`p256` | `ed25519`，缺省 `p256`）；
  - **transcript 选择规则**：邀请含 `tlsPin` ⇔ 双方使用 11 元素 `cetamesh-pairing-v1.1` 字符串（末尾绑定 pin）；
    不含 ⇔ 与 v1 逐字节一致（旧版 Mobile 完全兼容）。篡改 QR 中的 pin 会导致签名校验失败。
- Pairing 路径保持不变：`POST /cetamesh/v1/pairing/exchange`、`.../confirm`；请求 ≤16384 / 响应 ≤32768 字符，
  无重定向、无 Cookie。
- 配对完成后新增 Mesh 通道 `POST /cetamesh/v1/mesh/envelope`（`mesh.presence.ping/pong`、
  `mesh.manifest.request/response`、`mesh.capability.request/response`），签名内容
  `['cetamesh-mesh-v1', type, id, from, to, timestamp, nonce, ph]`，`ph = sha256(JSON(payload))`。

## Identity Algorithm（身份算法）

- Mobile 硬件身份本就是 **P-256**（Keystore / Secure Enclave，X9.63 未压缩 65B 公钥）。
- Desktop 由 Ed25519 受控迁移到 **P-256（schema v2）**：
  发现 v1 身份 → 先备份 `identity.v1-ed25519.json` / `.key` → 生成 P-256 → 记录 `legacyNodeId`
  （旧对端必须重新确认；trust store 不静默清洗）。桌面侧签名/验签按密钥类型分支，**legacy Ed25519 对端仍可验签**。
- 两端签名均为 ECDSA-SHA256、DER、base64；Desktop 额外提供 X9.63 ↔ SPKI PEM 双向转换。

## QR Schema 与 UI

- QR / 可粘贴文本 = `pairing.invitation` 信封的 **原始 JSON**（无 URI scheme、无 base64 包装），
  上限 8192 字符（本机实测 97×97 模块，含 4 模块静默区约 265px 可扫）。
- Desktop（Devices 页）：`连接手机` → 生成会话 → 直接绘制可扫描 QR（白底黑模块，egui painter，无新 crate），
  下方显示设备名称 / 局域网地址 / 有效期 / 证书指纹 / 安全说明；`复制配对邀请` 复制同一文本；`取消` 即时关闭会话；
  QR 显示期间 3 秒轮询配对状态。**界面不展示 token / PEM / 私钥**（有单测锁定）。
- Mobile（DevicesScreen）：扫码入口保留；新增 `无法扫码？粘贴配对邀请` 文本输入，提交走**同一个**
  `pairing.preview()` → `PairingRuntime`（无第二套实现、不读剪贴板）。

## TLS Pinning

- Desktop 首次需要时生成**每安装唯一**自签证书（`state/mesh/pairing-tls.json`，0600，私钥不出机），
  指纹 `sha256(DER)` 写进邀请的 `tlsPin`；端口随安装持久化，保证重启后 endpoint + pin 不变。
- Mobile 只在**配对流程 + 邀请指定的 endpoint + 证书指纹严格相等**时接受该自签证书：
  - Android：每请求独立 OkHttp client + 自定义 `X509TrustManager`（叶子证书 SHA-256(DER) 全等才通过；
    仅在 pin 命中后豁免主机名），默认共享 client 与其他网络路径零影响；
  - iOS：URLSession `didReceive challenge:` 中比对叶子证书指纹，命中才 `useCredential`。
- Desktop 作为客户端外联对端：**先完成握手、比对指纹、严格相等才写出任何请求字节**，否则立即断开
  （Node 无原生 pinning API；测试锁定"pin 不符时对端一个字节都收不到"）。
- 全仓守卫：`src/mesh` 内无 `NODE_TLS_REJECT_UNAUTHORIZED`、无全局 `hostnameVerifier=true`（测试断言）。
- 本机为 **Windows 10/11 x64**，无 Android SDK/adb/模拟器（`android_preflight` 实证），
  Kotlin/Swift 代码**未在本机编译运行**，记为 NOT_RUN_ENVIRONMENT。

## LAN Transport

- Desktop 配对服务器：`https` 绑定 `0.0.0.0:<持久化端口>`，仅三条固定 POST 路由，按需启动（用户点击「连接手机」），
  TLS ≥1.2；`status().supportedTransports = ['loopback','tcp']`（`pipe`/`relay` 仍未实现）。
- 验收为本机**真实 socket**：Desktop 服务器 + Node fixture"手机"（同一 pin 校验传输、真 TLS、真 HTTP、真 P-256 签名），
  不依赖任何 fixture 捷径。

## Presence / Manifest（真实往返）

- Mobile → Desktop：`mesh.presence.ping` → `mesh.presence.pong`，Desktop 更新 `lastSeenAt`（presence=online）。
- Desktop → Mobile：`requestPeerManifest`（pin 外联）真实读取手机能力清单；Mobile → Desktop 的 manifest 请求同样真实。
- 重启 Desktop 后：身份、信任、端口、证书指纹全部保持，**无需重新扫码**即可 presence 直连（验收覆盖）。

## Remote Capability（notification.send）

- Desktop → Mobile：`notification.send` 经 Mesh 通道发起 → 手机本地策略返回 `pending_approval` →
  fixture 模拟手机本地批准 → 再次请求返回 `allow` 并记录"已显示通知"（协议 / Transport / fixture 全 PASS）。
- **真机 Android 通知 = NOT_RUN_ENVIRONMENT**（无设备/模拟器）。
- Desktop 入站同样保持 **Trusted != Authorized**：未声明 → `CAPABILITY_NOT_DECLARED`；未显式授予 → `deny`；
  已授予但需审批 → `pending_approval` → 管理员批准后同一 requestId 才 `allow`（全链路验收）。
- 配对完成默认 grants 仅 `mesh.presence` + `mesh.manifest`；扫码成功不授予 filesystem / camera / microphone /
  memory.write / task.manage 等任何高风险能力。

## Memory Sync / Task Sync（协议 §15）— 本轮未接（如实记录）

- 现状：Mobile 的 M6 同步客户端（TrustedHttpClient / WebSocketClient）在 App 内**尚未接线**
  （其自身文档亦标注 "No M6 socket is implemented"）；Desktop 端本轮把 Mesh 通道与能力面打通，
  Memory/Task/Approval-metadata 同步**未实现**，不伪造 PASS。
- 下一步（明确的前置）：Mobile 先接线 M6 客户端 → 按 v1.1 Mesh 通道扩展 `sync.memory.push` /
  `sync.task.snapshot`（`my-devices` scope、metadata-only）→ 两端补 fixture 与测试。
- 明确禁止项继续成立：不同步整个 SQLite、不上传 local-only Memory、不传 API Key / 私钥。

## Reconnection / Revocation

- 重启（Desktop 与 Mobile 身份持久化）：不要求重新扫码；重扫码只用于 forget / re-pair / 身份轮换。
- 撤销：Desktop `trust.remove` → `blocked` + grants 清空，下一次请求即 401 `PEER_UNTRUSTED`（验收覆盖）；
  Mobile `removeTrust` 取消进行中的授权租约并阻止新授权（其自身测试覆盖）。

## Tests（两端自动测试）

- **Desktop `npm test`（统一入口）**：**PASS 66 · FAIL 0 · NOT_RUN_ENVIRONMENT 8**（74 suites；cargo check/test 计入）；
  新套件 `test-mesh-pairing-interop`（99 项断言：fixtures 向量 / 身份迁移 / 真实局域网互操作 / 重启 / 撤销 /
  服务方法面 / 全局 TLS 守卫）；`test-mesh-runtime` 随 LAN 落地更新传输断言后全绿（86 项）。
- Desktop `cargo test --manifest-path desktop-shell/Cargo.toml`：**113 passed / 0 failed**（新增 4 个配对 UI 单测）；
  `node scripts/test-desktop-architecture.mjs`：PASS；`cargo check`：7 个既有 warning（无新增）。
- **Mobile `npm run check`**：TypeScript / ESLint / 架构边界 / **Jest 70 suites · 279 tests** 全 PASS；
  新增 `pairing-fixtures.test.ts`（共享向量逐字节）、pin 透传与拒绝、粘贴回退 UI 测试。
- 共享 fixtures（`fixtures/pairing/` 与 `src/test/fixtures/pairing/` 逐字节相同）：邀请 v1/v1.1、transcript v1.1、
  exchange / challenge / accepted / confirm 冻结签名向量、坏签名、过期、重放指纹、Mesh presence 向量、测试密钥。

## Native Verification（如实清单）

**本机复现备注（切到 main 后跑测试前先看）：**
- 本分支在独立 worktree 上开发；新检出/切换 Desktop `main` 后需先 `npm install` —— `package.json` 新增了两个
  运行时依赖 `qrcode`（邀请二维码矩阵）与 `selfsigned`（每安装唯一配对证书）。Mobile 侧无新增依赖。
- 本机全新安装得到的 `@snowluma/sdk@1.14.9`（与锁文件 integrity 一致）与 Desktop 主检出内已安装副本**内容不同**：
  registry 版 `dist/index.js` 的 ESM 相对导入缺 `.js` 扩展名，会让 6 个既有套件直接失败；本次以主检出副本覆盖后全绿。
  这是环境差异、与本次改动无关，但 CI `npm ci` 与后续会话值得复核 registry 端 tarball。

**NOT_RUN_ENVIRONMENT（不在本机环境内，未伪造）：**
1. Android 编译与真机运行（本机无 Android SDK / adb / 模拟器 / 设备，`android_preflight` 实证）；
2. iOS 编译与运行（无 macOS/Xcode）；
3. 真实手机 ↔ Desktop 实际配对、真实 Android 通知（notification.send）；
4. 真机 KeyStore/Secure Enclave pin 行为与证书校验路径；
5. 正式发行产物（签名/发行包）回归。

**自定义决策（记录在案，供复审）：**
- Desktop 侧"用户确认"= 打开配对会话（点击「连接手机」）即视为同意本次配对；手机侧保留原有的两次确认。
  原因是 v1 协议中 exchange→challenge 是 15 秒内的同步 HTTP 往返，无法插入桌面人工确认。
- 配对服务器按需启动（不在开机时监听）；配对与已配对设备的 Mesh 通道共用同一端口与证书。

## 本轮明确不做（与任务一致）

Cloud relay、账户系统、互联网穿透 / NAT traversal、Bluetooth、NFC、Marketplace。
