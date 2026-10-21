# CetaMesh 统一设备配对协议 v1.1（Desktop ↔ Mobile）

> **事实源声明**：本文件是 Desktop 与 Mobile 两个仓库共同遵循的配对协议事实源。
> 两个仓库各存一份完全相同的副本；任何协议改动必须同时修改两处的副本、两端的测试与 fixture。
> Mobile 的 `docs/protocol/M3_PAIRING_V1.md` 是 v1 的历史基线；本文件在其之上定义 v1.1
> （**增量、向后兼容**：信封 `version` 仍为 `1`，新字段全部可选）。
>
> 本文件只描述"线缆上"的协议与安全语义；两端各自的实现细节（模块划分、UI）不在本文件范围。

## 0. 三种东西必须彻底分开

| 概念 | 用途 | 绝不能混用 |
| --- | --- | --- |
| **Model API Key**（DeepSeek / OpenAI…） | 调用模型服务 | 与设备配对完全无关；配对流程任何一步都不得要求、读取或传输 |
| **Device Identity Private Key** | 设备身份签名（P-256 等） | 只在本机硬件/系统密钥库内使用，**永不**出机、永不过线 |
| **Pairing Invitation（配对邀请）** | 一次性配对凭据（含一次性 token） | 只是"这次配对"的短期凭据；不是第二把永久密钥，不得当身份或长期凭据使用 |

配对邀请的文本表示（"无法扫码？复制/粘贴配对邀请"）= 同一个 Invitation 的 JSON 文本，
与二维码内容**逐字节相同**；扫码与粘贴必须进入同一个解析函数、同一个配对运行时。

## 1. 通用信封（cetamesh envelope）

所有配对与 Mesh 报文使用同一信封（沿用 Mobile v1 定义）：

```json
{"protocol":"cetamesh","version":1,"id":"...","type":"...","timestamp":"2026-10-08T12:00:00.000Z","payload":{}}
```

- `protocol` 必须为 `"cetamesh"`；`version` 必须为 `1`（v1.1 不改变版本号）。
- `id`：`^[A-Za-z0-9_-]{1,100}$`。
- `timestamp`：ISO-8601 UTC 毫秒精度（`YYYY-MM-DDTHH:MM:SS.sssZ`）。
  接收方拒绝 `timestamp > now + 30s`（同 Mobile v1）；配对完成后重放窗口见 §6。
- 未知 `type` 一律 fail-closed（拒绝）。
- 配对报文上限：请求体 ≤ 16384 字符、响应体 ≤ 32768 字符（沿用 Mobile v1 常量）。

## 2. 邀请（pairing.invitation）

二维码 / 可粘贴文本 = 以下信封的 JSON 文本（无 URI scheme、无 base64 包装）：

```json
{
  "protocol": "cetamesh", "version": 1,
  "id": "pairing-invite-<hex>", "type": "pairing.invitation",
  "timestamp": "2026-10-08T12:00:00.000Z",
  "payload": {
    "invitationId": "inv_<hex>",
    "endpoint": "https://192.168.1.23:47821",
    "token": "<base64, 32 bytes>",
    "expiresAt": "2026-10-08T12:04:30.000Z",
    "peer": {
      "deviceId": "node_<hex32>",
      "deviceName": "CetaMesh Desktop",
      "publicKey": "<X9.63 未压缩 P-256, 65 字节, base64>",
      "keyAlgorithm": "p256"
    },
    "tlsPin": "<sha256(cert DER) 小写 hex, 64 字符>"
  }
}
```

规则（在 Mobile v1 之上新增的以 **v1.1** 标注）：

- `endpoint`：v1 文法（仅 `https://`，小写 DNS 标签或完整十进制 IPv4，禁止 `localhost`/`127.*`/`0.*`，
  端口 1–65535 且不得为 443）。Desktop 填入**当前局域网 IPv4 + pairing 端口**。
- `token`：32 字节安全随机数的 base64（44 字符，v1 文法）。**一次性，5 分钟内有效**。
  原始 token 只允许存在于内存或必要的短期安全状态；**不得写入普通日志**；
  已消费记录只存 SHA-256 指纹（`sha256(token 的 base64 文本的 UTF-8 字节)` 小写 hex）。
- `expiresAt`：ISO；接收方要求 `now < expiresAt ≤ timestamp + 300000`（v1 规则）。
  Desktop 生成时使用 **270 秒 TTL**（吸收 ±30s 时钟偏差）。
- `peer.publicKey`：P-256 未压缩 X9.63（`0x04||X||Y`，65 字节）base64 —— 与 Mobile 身份一致。
- **v1.1** `peer.keyAlgorithm`：`"p256"` | `"ed25519"`；缺省视为 `"p256"`。
  Desktop 迁移到 P-256 身份后填 `"p256"`；带 `ed25519` 的邀请只可能来自旧版 Desktop。
- **v1.1** `tlsPin`：Desktop 本次配对 TLS 证书的 SHA-256(DER) 小写 hex。
  缺省 = 无 pin = 完全走操作系统 TLS 校验（v1 行为）。

## 3. 签名与 transcript

- 签名算法：P-256 为 **ECDSA-SHA256，DER 编码，base64**（与 Mobile v1 一致）。
  `ed25519` 仅用于 v1 旧 Desktop 对端。
- **v1 transcript**（无 `tlsPin` 时，逐字节与 Mobile v1 相同）：

```
JSON.stringify(['cetamesh-pairing-v1', phase,
  i.invitationId, i.endpoint, i.peer.deviceId, i.peer.publicKey,
  d.deviceId, d.publicKey, nonce, i.expiresAt])
```

- **v1.1 transcript**（邀请含 `tlsPin` 时，末尾追加该 pin）：

```
JSON.stringify(['cetamesh-pairing-v1.1', phase,
  i.invitationId, i.endpoint, i.peer.deviceId, i.peer.publicKey,
  d.deviceId, d.publicKey, nonce, i.expiresAt, i.tlsPin])
```

  `phase ∈ exchange | challenge | confirm | accepted`；`i` = 邀请方（Desktop）的邀请/pin，
  `d` = 扫描方（Mobile）的设备身份，`nonce` = Mobile 生成的 32 字节随机数 base64。
  规则：**邀请含 `tlsPin` ⇔ 双方全程使用 v1.1 transcript**；不含 ⇔ 使用 v1 transcript。
  这样 pin 被签名绑定，篡改 QR 中的 pin 会导致签名校验失败。

## 4. 握手（两段 HTTP，沿用 v1 路径）

- `POST {endpoint}/cetamesh/v1/pairing/exchange`

```json
{"invitationId":"...","token":"...","nonce":"...",
 "device":{"deviceId":"...","deviceName":"...","publicKey":"<X9.63 b64>","platform":"android|ios","createdAt":"<ISO>"},
 "signature":"<base64 DER ECDSA-SHA256 over transcript(exchange)>",
 "endpoint":"https://192.168.1.30:PORT", "tlsPin":"<hex64>"}
```

  最后两个字段为 **v1.1 可选**：Mobile 若愿意暴露自己的 M6 端点，可带上；
  旧版 Mobile 不带 ⇒ Desktop 无法反向直连该手机（只能等手机主动连 Desktop），如实记录为能力缺失。

- `POST {endpoint}/cetamesh/v1/pairing/confirm`

```json
{"invitationId":"...","nonce":"...","deviceId":"...","signature":"<over transcript(confirm)>"}
```

- 响应（两条路径同构）：

```json
{"protocol":"cetamesh","version":1,"id":"desktop-<hex>","type":"pairing.challenge|pairing.accepted",
 "timestamp":"<ISO>",
 "payload":{"invitationId":"...","nonce":"...",
   "peer":{"deviceId":"node_...","deviceName":"...","publicKey":"<X9.63 b64>","keyAlgorithm":"p256"},
   "expiresAt":"<与邀请相同>","signature":"<Desktop 身份的签名>"}}
```

  响应签名 = Desktop 用**自己的身份私钥**对同一 transcript 相应 phase 的签名；
  Mobile 必须校验 `peer` 与邀请中的逐字段相同（v1 规则）。

- 消费与提交（两端都强制）：
  - 收到合法 `exchange` 时，Desktop 必须**原子消费 token**（一次性；已用 → 拒绝，
    过期 → 拒绝；两者独立于 Mobile 的本地消费）。失败响应为 4xx JSON `{"error":{"code","message"}}`。
  - `confirm` 通过后 Desktop 提交信任记录，再返回 `pairing.accepted`；
    在同一个 session 未过期前重复 `confirm` 是幂等的（不重复提交，仅重发 `accepted`）。
  - 安全错误码（失败响应 `error.code`）：`REFUSED_NOT_FOUND`、`REFUSED_EXPIRED`、
    `REFUSED_CONSUMED`、`REFUSED_SIGNATURE`、`REFUSED_REQUEST`、`REFUSED_REPLAY`。
    Mobile 把非 2xx 一律折叠为 `unauthorized`/`invalid_protocol`（v1 行为），不得据此重试。

## 5. TLS 与证书 pinning（v1.1 核心）

- Desktop 首次需要时生成 **每安装实例唯一** 的自签 P-256 证书 + 私钥，落在 `state/mesh/`
  （受限权限；不同安装/不同机器绝不复用同一把私钥）。证书指纹进入邀请 `tlsPin`。
- **Mobile 的接受规则（仅此一条例外）**：当且仅当
  1. 处于配对流程（pairing transport 固定路径），且
  2. 目标是本次 Invitation 指定的 endpoint（同一 origin），且
  3. 服务端叶子证书的 SHA-256(DER) **完全等于** QR 中的 `tlsPin`
  时，接受该自签证书。
  pin 匹配即完成了端点身份认证；此时不再额外要求主机名校验。
- **禁止**：`trustAllCertificates`、全局 `hostnameVerifier=true`、`NSURLSession` 全局忽略证书、
  为普通 HTTPS / Model Provider 打开任何例外。pin 只在上述单一流程内、按请求生效。
- Desktop 作为客户端（反向连手机的 M6 端点，若交换时带了 `endpoint`+`tlsPin`）：
  只允许与 pin 指纹完全一致的证书建立并**写入任何请求字节之前**完成校验，否则立即断开。
  Node 没有原生 pinning API，Desktop 用"先握手取证书 → 指纹严格相等才发送"的受限实现，
  并以测试锁定"pin 不符时一个字节都不能发出"。

## 6. 配对完成后的 Mesh 通道（v1.1 新增）

配对完成（双方均持久化信任）后，任一方可向对方的配对 endpoint 发送 Mesh 报文：

- `POST {endpoint}/cetamesh/v1/mesh/envelope`

```json
{"protocol":"cetamesh","version":1,"id":"...","type":"mesh.presence.ping",
 "timestamp":"<ISO>","from":"<发送方 deviceId>","to":"<接收方 deviceId>",
 "nonce":"<32B b64>","payload":{},"ph":"<hex64>","signature":"<b64 DER ECDSA-SHA256>"}
```

- `ph = sha256hex(JSON.stringify(payload))`（发送方以自己的序列化计算；
  接收方对"自己解析后再序列化"的 payload 计算同样哈希 —— 因此 payload 禁止数字键名）。
- 签名内容：`JSON.stringify(['cetamesh-mesh-v1', type, id, from, to, timestamp, nonce, ph])`，
  签名算法 = 发送方身份的 `keyAlgorithm`。
- 接收方校验：`to` = 自己的 deviceId；`from` 为**已信任**对端；签名有效；`ph` 匹配；
  `timestamp` 偏移 ≤ 300s；`id` + `nonce` 重放缓存（重复 → `REFUSED_REPLAY`）。
- 类型与语义：
  - `mesh.presence.ping` → `mesh.presence.pong`：payload `{presence:"online", role, nodeId, at}`。
    接收方更新该对端 `lastSeenAt`（这就是"网络恢复自动 presence refresh"）。
  - `mesh.manifest.request` → `mesh.manifest.response`：payload 为该节点的能力清单
    （`{protocolVersion, nodeId, name, role, generatedAt, capabilities:[{id,available,requiresApproval,summary}]}`）。
  - `mesh.capability.request`（payload `{capability, input, requestId}`）
    → `mesh.capability.response`（payload `{requestId, decision:"allow"|"deny"|"pending_approval", code, result?}`）。
    接收方按 **Trusted != Authorized** 授权链处理：
    trust → 能力已声明 → **已显式授予**（grants）→ 需要审批的能力必须有本地批准。
- 配对完成后的默认授权（两端一致）：`grants = ["mesh.presence", "mesh.manifest"]`。
  其余能力（`chat.session`、`memory.query`、`task.manage`、`workspace.files`、`extension.invoke`、
  以及任何未来能力如 `notification.send`）**一律需要显式 grant + 本地逐次审批**。
  扫码成功 **不得** 自动授予 filesystem / camera / microphone / memory.write / task.manage。
- **重放保护**：`duplicate id / nonce` 拒绝；`timestamp` 偏移超限拒绝。
- **撤销**：任一端"撤销信任"后，另一端的下一次请求必须被拒绝（Desktop 侧 =
  trust 置 `blocked` + grants 清空；Mobile 侧 = 删除 trust 行 + 取消进行中的授权租约）。

## 7. 身份算法与迁移

- 两端设备身份统一为 **P-256**（Mobile 已是；Desktop v1 为 Ed25519，本轮迁移）。
- Desktop `Mesh Identity schema v2`：`{schemaVersion:2, keyAlgorithm:"p256", nodeId, legacyNodeId?, ...}`。
  迁移规则（受控 pre-1.0）：
  1. 发现 v1（Ed25519）身份时，**先备份**旧 `identity.json` 与 `identity.key`（`*.v1-ed25519.*`），
     绝不静默丢失 trust store；
  2. 生成 v2（P-256）身份，`nodeId` 由新公钥派生（因此会变化），记录 `legacyNodeId`；
  3. 已在旧的 `legacyNodeId` 上建立的旧对端**必须重新确认/重新配对**（其侧看到的是新身份）；
     trust.json 保留，但状态信息中明确暴露 `identityMigration` 供 UI 提示。
- Desktop 验证对端签名按对端 `keyAlgorithm` 选择算法；`ed25519` 仅用于兼容旧对端。

## 8. 共享 Golden Fixtures

两端仓库各存一份 `fixtures/pairing/`（Mobile 位于 `src/test/fixtures/pairing/`），内容逐字节相同：

| 文件 | 用途 |
| --- | --- |
| `test-keys.json` | 固定测试密钥（**仅测试**；含 P-256 双端与一把 legacy Ed25519） |
| `invitation-v1.json` / `invitation-v1.1.json` | 合法邀请（含/不含 tlsPin） |
| `transcripts-v1.1.json` | 四个 phase 的 transcript 精确字符串 |
| `exchange-v1.1.json` / `challenge-v1.1.json` / `accepted-v1.1.json` | 固定签名的交换/响应向量 |
| `bad-signature.json` | 篡改签名的 exchange（必须被拒） |
| `expired.json` | 过期邀请（固定 now 必须被拒） |
| `replay.json` | token 指纹与第二次使用向量（必须被拒） |
| `mesh-presence-ping-v1.1.json` | 配对后 Mesh 通道签名向量 |

签名类 fixture 是**冻结向量**（ECDSA 签名本身随机，不可重放生成）；
`fixtures/pairing/README.md` 说明其生成方式与两端一致的使用方式。

## 9. 明确不做（本轮范围外）

Cloud relay、账户系统、互联网穿透/NAT traversal、Bluetooth、NFC、Marketplace；
真机 Android/iOS 执行与编译在无设备环境下如实记 `NOT_RUN_ENVIRONMENT`，不得伪造。
