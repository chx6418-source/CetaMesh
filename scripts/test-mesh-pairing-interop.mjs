// CetaMesh Desktop — 统一配对 v1.1 互操作验收（Desktop ↔ Node fixture 模拟 Mobile）。
// 用法：node scripts/test-mesh-pairing-interop.mjs
//
// 覆盖（对应 docs/protocol/UNIFIED_PAIRING_V1_1.md 与上线冲刺任务 B 的 DoD）：
//   A. 共享 golden fixtures：邀请 / transcript / exchange / challenge / accepted / 坏签名 / 过期 / 重放 / Mesh 向量；
//   B. Desktop 身份 v2（P-256）受控迁移：备份、legacyNodeId、Ed25519 兼容、重启稳定；
//   C. 真实局域网 socket 互操作：Desktop 配对服务器 + Node fixture"手机"（自带 pin 校验传输）
//      —— 真 TLS、真 HTTP、真 P-256 签名；覆盖握手、token 一次性、过期、pin 不符不发送任何字节、
//      presence / manifest 实际往返、远程能力（notification.send）审批链、桌面壳服务方法面；
//   D. 重启免扫码 / 撤销生效 / 消费记录跨重启持久化；
//   E. 全局 TLS 未被关闭的静态守卫。
//
// 说明：真机 Android 不在本机环境内（记 NOT_RUN_ENVIRONMENT）；这里用 Node fixture 按同一协议
// 逐字节模拟 Mobile，Desktop 侧全部走真网络路径，不做 fixture 捷径。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PAIRING_LIMITS,
  createInvitationStore,
  createMeshEnvelope,
  createMeshNode,
  createMeshPairingServer,
  createMeshService,
  deriveNodeId,
  httpsPostPinned,
  invitationQr,
  loadOrCreateIdentity,
  loadOrCreatePairingTls,
  parseInvitation,
  pickLanAddress,
  publicKeyPemToX963,
  signPayload,
  transcript,
  validateCetameshEnvelope,
  validateMeshEnvelope,
  verifyPayload,
  x963ToPublicKeyPem
} from '../src/mesh/index.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'pairing');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) { passed += 1; console.log('PASS ' + name + (extra ? ' — ' + extra : '')); }
  else { failed += 1; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
};
const capture = (fn) => {
  try { return { threw: false, value: fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};
const asyncCapture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-pairing-test-'));
const iso = (ms) => new Date(ms).toISOString();
const randomB64 = () => crypto.randomBytes(32).toString('base64');
const sha256hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
let eventSeq = 0;

// ────────────────────────────────────────────────────────────────────────────
// A. 共享 golden fixtures（协议向量，两端逐字节一致）
// ────────────────────────────────────────────────────────────────────────────
function sectionFixtures() {
  const keys = fixture('test-keys.json');
  const v11 = fixture('invitation-v1.1.json');
  const v1 = fixture('invitation-v1.json');
  const transcripts = fixture('transcripts-v1.1.json');
  const exchange = fixture('exchange-v1.1.json');
  const challenge = fixture('challenge-v1.1.json');
  const accepted = fixture('accepted-v1.1.json');
  const badSig = fixture('bad-signature.json');
  const expired = fixture('expired.json');
  const replay = fixture('replay.json');
  const presence = fixture('mesh-presence-ping-v1.1.json');

  check('fixture 邀请 v1.1 通过信封校验', !capture(() => validateCetameshEnvelope(v11.envelope, { nowMs: Date.parse(v11.now), maxChars: PAIRING_LIMITS.invitationChars })).threw);
  const inv11 = parseInvitation(JSON.stringify(v11.envelope), Date.parse(v11.now)).invitation;
  equal('fixture 邀请 v1.1 含 tlsPin 与 keyAlgorithm', [inv11.tlsPin, inv11.peer.keyAlgorithm], [v11.envelope.payload.tlsPin, 'p256']);
  const inv1 = parseInvitation(JSON.stringify(v1.envelope), Date.parse(v1.now)).invitation;
  check('fixture 邀请 v1（无 pin）仍可解析', inv1.tlsPin === undefined, 'endpoint=' + inv1.endpoint);

  const device = { deviceId: transcripts.device.deviceId, publicKey: transcripts.device.publicKey };
  for (const phase of ['exchange', 'challenge', 'confirm', 'accepted']) {
    equal('transcript v1.1 / ' + phase + ' 与 fixture 逐字节一致', transcript(inv11, device, transcripts.nonce, phase), transcripts.phases[phase]);
  }
  const v1Array = JSON.parse(transcript(inv1, device, transcripts.nonce, 'exchange'));
  check('无 pin 邀请回退 v1 transcript（10 元素）', v1Array.length === 10 && v1Array[0] === 'cetamesh-pairing-v1');
  check('有 pin 邀请使用 v1.1 transcript（末尾绑定 pin）', JSON.parse(transcript(inv11, device, transcripts.nonce, 'exchange'))[10] === inv11.tlsPin);

  const mobilePeerPem = x963ToPublicKeyPem(keys.mobile.x963);
  const desktopPeerPem = x963ToPublicKeyPem(keys.desktop.x963);
  equal('fixture 密钥派生 mobile nodeId 一致', deriveNodeId(mobilePeerPem), keys.mobile.nodeId);
  equal('fixture 密钥派生 desktop nodeId 一致', deriveNodeId(desktopPeerPem), keys.desktop.nodeId);
  check('fixture exchange 签名可验证', verifyPayload(mobilePeerPem, transcripts.phases.exchange, exchange.envelope.payload.signature));
  check('fixture challenge 签名可验证', verifyPayload(desktopPeerPem, transcripts.phases.challenge, challenge.envelope.payload.signature));
  check('fixture accepted 签名可验证', verifyPayload(desktopPeerPem, transcripts.phases.accepted, accepted.envelope.payload.signature));
  check('fixture 坏签名必须验签失败', !verifyPayload(mobilePeerPem, transcripts.phases.exchange, badSig.envelope.payload.signature));

  const expiredResult = capture(() => parseInvitation(JSON.stringify(expired.envelope), Date.parse(expired.now)));
  equal('fixture 过期邀请被拒（REFUSED_EXPIRED）', expiredResult.code, 'REFUSED_EXPIRED');

  const meshMsg = validateMeshEnvelope(presence.envelope, { nowMs: Date.parse(presence.now), toDeviceId: keys.desktop.nodeId });
  check('fixture presence 信封通过 Mesh 校验', meshMsg.type === 'mesh.presence.ping');
  check('fixture presence 签名可验证', verifyPayload(mobilePeerPem, meshMsg.signingString, meshMsg.signature));
  equal('fixture presence payload 哈希匹配', meshMsg.ph, sha256hex('{}'));
  check('fixture 篡改 payload 后哈希拒绝', capture(() => validateMeshEnvelope({ ...presence.envelope, payload: { evil: true } }, { nowMs: Date.parse(presence.now), toDeviceId: keys.desktop.nodeId })).threw === true);

  equal('PEM → X9.63 往返一致', publicKeyPemToX963(desktopPeerPem), keys.desktop.x963);
  check('fixture tlsPin 是小写 hex64', /^[0-9a-f]{64}$/.test(inv11.tlsPin));
  equal('回放 fixture 的 token 指纹一致', replay.tokenFingerprint, sha256hex(replay.token));

  const qr = invitationQr(JSON.stringify(v11.envelope));
  check('QR 矩阵行列一致且非空', qr.size > 0 && qr.rows.length === qr.size && qr.rows.every((row) => row.length === qr.size));
  equal('QR 编码确定性（同输入同矩阵）', invitationQr(JSON.stringify(v11.envelope)).rows, qr.rows);
}

// ────────────────────────────────────────────────────────────────────────────
// B. Desktop 身份 v2（P-256）受控迁移
// ────────────────────────────────────────────────────────────────────────────
function sectionIdentityMigration() {
  const keys = fixture('test-keys.json');
  const dir = path.join(root, 'identity-migration');
  const meshDir = path.join(dir, 'mesh');
  fs.mkdirSync(meshDir, { recursive: true });
  const legacyNodeId = deriveNodeId(keys.legacyEd25519.publicPem);
  fs.writeFileSync(path.join(meshDir, 'identity.json'), JSON.stringify({
    schemaVersion: 1,
    nodeId: legacyNodeId,
    name: 'CetaMesh Desktop (legacy)',
    role: 'desktop',
    publicKeyPem: keys.legacyEd25519.publicPem,
    createdAt: 1700000000000
  }, null, 2));
  fs.writeFileSync(path.join(meshDir, 'identity.key'), keys.legacyEd25519.privatePem);

  const migrated = loadOrCreateIdentity({ stateDir: dir });
  equal('v1 → v2：schema 升级', migrated.schemaVersion, 2);
  equal('v1 → v2：算法为 p256', migrated.keyAlgorithm, 'p256');
  equal('v1 → v2：记录 legacyNodeId', migrated.legacyNodeId, legacyNodeId);
  check('v1 → v2：nodeId 变化（旧对端需重新确认）', migrated.nodeId !== legacyNodeId, migrated.nodeId);
  check('v1 → v2：旧 metadata 与私钥均已备份', fs.existsSync(path.join(meshDir, 'identity.v1-ed25519.json')) && fs.existsSync(path.join(meshDir, 'identity.v1-ed25519.key')));
  equal('备份保留旧 nodeId（trust store 未被静默清洗）', JSON.parse(fs.readFileSync(path.join(meshDir, 'identity.v1-ed25519.json'), 'utf8')).nodeId, legacyNodeId);
  equal('迁移后重启身份稳定', loadOrCreateIdentity({ stateDir: dir }).nodeId, migrated.nodeId);
  check('v2（P-256）签名/验签可用', verifyPayload(migrated.publicKeyPem, 'payload-x', signPayload(migrated.privateKeyPem, 'payload-x')) === true);
  check('legacy Ed25519 对端仍可验签（兼容）', verifyPayload(keys.legacyEd25519.publicPem, 'payload-y', signPayload(keys.legacyEd25519.privatePem, 'payload-y')) === true);
}

// ────────────────────────────────────────────────────────────────────────────
// C. 真实局域网 socket 互操作
// ────────────────────────────────────────────────────────────────────────────

/** Node fixture"手机"：按协议 v1.1 模拟 Mobile（含 pin 校验传输）。 */
function createFixtureMobile({ keys, now = () => Date.now() }) {
  const device = {
    deviceId: 'a7f3c1e0-9b2d-4e6a-9f11-7c3d5e8b0a42',
    deviceName: 'Pixel 9 测试机',
    publicKey: keys.mobile.x963,
    platform: 'android',
    createdAt: iso(now())
  };
  let state = null;

  return {
    device,
    /** 扫码 / 粘贴 -> 同一入口：解析邀请并锁定本次配对的 token/nonce。 */
    scan(rawText, { skipValidation = false } = {}) {
      const invitation = skipValidation ? JSON.parse(rawText).payload : parseInvitation(rawText, now()).invitation;
      state = { invitation, nonce: randomB64() };
      return invitation;
    },
    exchangeBody({ extra = {} } = {}) {
      const signature = signPayload(keys.mobile.privatePem, transcript(state.invitation, device, state.nonce, 'exchange'));
      return JSON.stringify({
        protocol: 'cetamesh', version: 1, id: 'mobile-event-' + (++eventSeq),
        type: 'pairing.exchange', timestamp: iso(now()),
        payload: { invitationId: state.invitation.invitationId, token: state.invitation.token, nonce: state.nonce, device, signature, ...extra }
      });
    },
    confirmBody() {
      const signature = signPayload(keys.mobile.privatePem, transcript(state.invitation, device, state.nonce, 'confirm'));
      return JSON.stringify({
        protocol: 'cetamesh', version: 1, id: 'mobile-event-' + (++eventSeq),
        type: 'pairing.confirm', timestamp: iso(now()),
        payload: { invitationId: state.invitation.invitationId, nonce: state.nonce, deviceId: device.deviceId, signature }
      });
    },
    /** 校验 Desktop 响应信封（challenge/accepted）的回显与签名。 */
    verifyProofEnvelope(rawBody, phase) {
      const envelope = JSON.parse(rawBody);
      if (envelope.type !== 'pairing.' + phase) return { ok: false, code: 'BAD_TYPE' };
      const proof = envelope.payload;
      const echoes = proof.invitationId === state.invitation.invitationId
        && proof.nonce === state.nonce
        && proof.peer.deviceId === state.invitation.peer.deviceId
        && proof.peer.publicKey === state.invitation.peer.publicKey
        && proof.peer.deviceName === state.invitation.peer.deviceName
        && proof.peer.keyAlgorithm === state.invitation.peer.keyAlgorithm
        && proof.expiresAt === state.invitation.expiresAt;
      const peerPem = x963ToPublicKeyPem(proof.peer.publicKey);
      return { ok: echoes && verifyPayload(peerPem, transcript(state.invitation, device, state.nonce, phase), proof.signature), code: echoes ? 'SIGNATURE' : 'ECHO_MISMATCH' };
    },
    /** 配对后的 Mesh 通道请求（同一 pin 校验传输）。 */
    async mesh({ endpoint, tlsPin, type, to, payload = {} }) {
      const envelope = createMeshEnvelope({ type, from: device.deviceId, to, payload, privateKeyPem: keys.mobile.privatePem, nowMs: now() });
      const response = await httpsPostPinned({ url: endpoint + '/cetamesh/v1/mesh/envelope', tlsPin, body: JSON.stringify(envelope) });
      return { request: envelope, ...response };
    }
  };
}

async function sectionLiveInterop() {
  const keys = fixture('test-keys.json');
  const stateDir = path.join(root, 'desktop-live');
  const clock = { skew: 0 };
  const executed = [];
  const node = createMeshNode({
    stateDir,
    name: 'CetaMesh Desktop (live)',
    role: 'desktop',
    available: ['task.manage'],
    executeCapability: ({ capability, input }) => { executed.push({ capability, input }); return { ok: true, capability }; },
    now: () => Date.now() + clock.skew
  });
  const desktopId = node.identity().nodeId;

  // C1. 创建配对会话：QR / 邀请 / 证书 pin / 局域网 endpoint
  const session = await node.startPairingSession({});
  const invitationEnvelope = JSON.parse(session.invitation);
  const lan = pickLanAddress();
  check('配对会话生成局域网 endpoint（非环回）', /^https:\/\/\d{1,3}(\.\d{1,3}){3}:\d+$/.test(session.endpoint), session.endpoint);
  check('endpoint 使用检测到的局域网地址', Boolean(lan) && session.endpoint.includes(lan));
  equal('邀请 tlsPin = 实际证书指纹', invitationEnvelope.payload.tlsPin, session.tlsPin);
  check('邀请 peer 为 p256 且 nodeId 一致', invitationEnvelope.payload.peer.keyAlgorithm === 'p256' && invitationEnvelope.payload.peer.deviceId === desktopId);
  const qr = invitationQr(session.invitation);
  check('会话返回可渲染 QR 矩阵', qr.rows.length === qr.size && qr.size > 20, 'size=' + qr.size);
  const active = node.pairingStatus();
  check('pairing status 不含 token', active.active === true && !JSON.stringify(active).includes(invitationEnvelope.payload.token));
  check('审计日志不含原始 token', !JSON.stringify(node.audit()).includes(invitationEnvelope.payload.token));

  const mobile = createFixtureMobile({ keys });
  const scanned = mobile.scan(session.invitation);
  equal('fixture 扫码/粘贴解析出同一邀请', scanned.invitationId, invitationEnvelope.payload.invitationId);

  // C2. pin 不符：必须在发送任何请求字节前断开
  const serverNotesBefore = node.audit().filter((entry) => String(entry.code).startsWith('PAIRING_SERVER')).length;
  const wrongPin = await asyncCapture(() => httpsPostPinned({
    url: session.endpoint + '/cetamesh/v1/pairing/exchange',
    tlsPin: sha256hex('not-the-cert'),
    body: mobile.exchangeBody()
  }));
  check('pin 不符时本地拒绝（PIN_MISMATCH）', wrongPin.threw && wrongPin.code === 'PIN_MISMATCH', String(wrongPin.code));
  equal('pin 不符时服务器未收到任何请求', node.audit().filter((entry) => String(entry.code).startsWith('PAIRING_SERVER')).length, serverNotesBefore);

  // C3. exchange：真 TLS + 真签名
  const exchange = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/pairing/exchange', tlsPin: session.tlsPin, body: mobile.exchangeBody() });
  equal('exchange 返回 200', exchange.status, 200);
  const challengeCheck = mobile.verifyProofEnvelope(exchange.body, 'challenge');
  check('challenge 回显邀请字段且 Desktop 签名有效', challengeCheck.ok, challengeCheck.code);

  // C4. token 一次性：同一邀请重放被拒
  const replayAttempt = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/pairing/exchange', tlsPin: session.tlsPin, body: mobile.exchangeBody() });
  equal('重复使用同一 token 被拒（401/REFUSED_CONSUMED）', [replayAttempt.status, JSON.parse(replayAttempt.body).error.code], [401, 'REFUSED_CONSUMED']);

  // C5. confirm：信任提交 + accepted
  const confirm = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/pairing/confirm', tlsPin: session.tlsPin, body: mobile.confirmBody() });
  equal('confirm 返回 200', confirm.status, 200);
  const acceptedCheck = mobile.verifyProofEnvelope(confirm.body, 'accepted');
  check('accepted 回显且 Desktop 签名有效', acceptedCheck.ok, acceptedCheck.code);
  const peerNodeId = node.pairingStatus().peerNodeId;
  const peer = node.peers().find((item) => item.nodeId === peerNodeId);
  check('配对完成后对端 trusted 且 transport=tcp', Boolean(peer) && peer.trust === 'trusted' && peer.transport === 'tcp');
  equal('默认授权仅 mesh.presence + mesh.manifest（Trusted != Authorized）', peer && peer.grants, ['mesh.presence', 'mesh.manifest']);
  // 会话已消费：session 状态可见
  check('pairing status 记录已消费对端', node.pairingStatus().consumedBy && node.pairingStatus().peerNodeId === peerNodeId);

  // C6. 过期：会话超时后，同 token 的合法签名 exchange 仍被拒
  const fakeClock = { ms: Date.now() };
  const nodeExpire = createMeshNode({ stateDir: path.join(root, 'desktop-expiry'), name: 'Desktop Expiry', role: 'desktop', now: () => fakeClock.ms });
  const sessionExpire = await nodeExpire.startPairingSession({});
  const mobileExpire = createFixtureMobile({ keys, now: () => fakeClock.ms });
  mobileExpire.scan(sessionExpire.invitation, { skipValidation: true });
  fakeClock.ms = Date.now() + PAIRING_LIMITS.maxTtlMs + 10_000; // 会话此刻已过期
  const expiredAttempt = await httpsPostPinned({ url: sessionExpire.endpoint + '/cetamesh/v1/pairing/exchange', tlsPin: sessionExpire.tlsPin, body: mobileExpire.exchangeBody() });
  equal('过期会话的合法签名 exchange 被拒（401/REFUSED_EXPIRED）', [expiredAttempt.status, JSON.parse(expiredAttempt.body).error.code], [401, 'REFUSED_EXPIRED']);
  await nodeExpire.close();

  // C7. Mesh 通道：presence / manifest / capability 授权链
  const presencePing = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.presence.ping', to: desktopId });
  equal('presence.ping 返回 200', presencePing.status, 200);
  const pong = JSON.parse(presencePing.body);
  check('presence.pong 签名有效且 online', pong.type === 'mesh.presence.pong' && pong.payload.presence === 'online'
    && verifyPayload(x963ToPublicKeyPem(invitationEnvelope.payload.peer.publicKey), validateMeshEnvelope(pong, { nowMs: Date.now(), toDeviceId: mobile.device.deviceId }).signingString, pong.signature));
  check('presence 更新 lastSeenAt（online）', node.peers().some((item) => item.presence === 'online'));

  const manifestResponse = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.manifest.request', to: desktopId });
  const manifest = JSON.parse(manifestResponse.body).payload;
  check('manifest 真实往返且含 mesh.presence', Array.isArray(manifest.capabilities) && manifest.capabilities.some((item) => item.id === 'mesh.presence'));
  equal('未接线的 Memory 能力在配对后 Manifest 中不可用', manifest.capabilities.find((item) => item.id === 'memory.query').available, false);

  node.grant({ nodeId: peerNodeId, capabilities: ['memory.query'] });
  const unwired = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.capability.request', to: desktopId,
    payload: { capability: 'memory.query', input: {}, requestId: 'req-unwired' } });
  equal('配对通道已授权但未接线的能力被拒', [JSON.parse(unwired.body).payload.decision, JSON.parse(unwired.body).payload.code],
    ['deny', 'CAPABILITY_UNAVAILABLE']);
  check('未接线能力不会创建待审批请求', !node.approvals().some((item) => item.requestId === 'req-unwired'));

  const denied = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.capability.request', to: desktopId, payload: { capability: 'task.manage', input: {}, requestId: 'req-live-1' } });
  equal('未授予的能力被拒（deny / CAPABILITY_NOT_AUTHORIZED）', [JSON.parse(denied.body).payload.decision, JSON.parse(denied.body).payload.code], ['deny', 'CAPABILITY_NOT_AUTHORIZED']);
  const undeclared = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.capability.request', to: desktopId, payload: { capability: 'notification.send', input: {}, requestId: 'req-live-2' } });
  equal('Desktop 未声明的能力被拒（CAPABILITY_NOT_DECLARED）', JSON.parse(undeclared.body).payload.code, 'CAPABILITY_NOT_DECLARED');

  node.grant({ nodeId: peerNodeId, capabilities: ['task.manage'] });
  const pendingAttempt = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.capability.request', to: desktopId, payload: { capability: 'task.manage', input: { note: 'x' }, requestId: 'req-live-3' } });
  equal('已授权但需审批：pending_approval', JSON.parse(pendingAttempt.body).payload.decision, 'pending_approval');
  check('待审批出现在 Desktop 审批列表', node.approvals().some((item) => item.requestId === 'req-live-3' && item.state === 'pending'));
  check('管理员批准成功', !capture(() => node.decideApproval({ requestId: 'req-live-3', decision: 'approve' })).threw);
  const allowedAttempt = await mobile.mesh({ endpoint: session.endpoint, tlsPin: session.tlsPin, type: 'mesh.capability.request', to: desktopId, payload: { capability: 'task.manage', input: { note: 'x' }, requestId: 'req-live-3' } });
  equal('批准后同一 requestId 放行（allow）', JSON.parse(allowedAttempt.body).payload.decision, 'allow');
  equal('执行器收到真实调用', executed.map((item) => item.capability), ['task.manage']);

  const replayedMesh = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/mesh/envelope', tlsPin: session.tlsPin, body: JSON.stringify(presencePing.request) });
  equal('重复 Mesh 消息被拒（401/REFUSED_REPLAY）', [replayedMesh.status, JSON.parse(replayedMesh.body).error.code], [401, 'REFUSED_REPLAY']);
  const tamperedResult = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/mesh/envelope', tlsPin: session.tlsPin, body: JSON.stringify({ ...presencePing.request, payload: { evil: true } }) });
  equal('篡改 payload 被拒（哈希不匹配）', [tamperedResult.status, JSON.parse(tamperedResult.body).error.code], [400, 'REFUSED_REQUEST']);
  const rogue = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rogueEnvelope = createMeshEnvelope({ type: 'mesh.presence.ping', from: 'rogue-device-1', to: desktopId, payload: {}, privateKeyPem: rogue.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  const rogueResult = await httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/mesh/envelope', tlsPin: session.tlsPin, body: JSON.stringify(rogueEnvelope) });
  equal('未配对设备被拒（401/PEER_UNKNOWN）', [rogueResult.status, JSON.parse(rogueResult.body).error.code], [401, 'PEER_UNKNOWN']);

  // C8. 反向：Desktop → Mobile（fixture 手机暴露 M6 端点，经 exchange 可选字段发布）
  const mobileTls = await loadOrCreatePairingTls({ stateDir: path.join(root, 'fixture-mobile-server'), name: 'Pixel 9 测试机' });
  const mobilePolicy = { approved: false, shown: [] };
  const mobileNotes = [];
  const mobileServer = createMeshPairingServer({
    tls: mobileTls,
    handlers: {
      exchange: () => { throw Object.assign(new Error('fixture 手机不接受入站 exchange'), { code: 'REFUSED_REQUEST' }); },
      confirm: () => { throw Object.assign(new Error('fixture 手机不接受入站 confirm'), { code: 'REFUSED_REQUEST' }); },
      mesh: (bodyText) => {
        const message = validateMeshEnvelope(JSON.parse(bodyText), { nowMs: Date.now(), toDeviceId: mobile.device.deviceId });
        const desktopKeyPem = x963ToPublicKeyPem(invitationEnvelope.payload.peer.publicKey);
        if (!verifyPayload(desktopKeyPem, message.signingString, message.signature)) {
          throw Object.assign(new Error('bad signature'), { code: 'REFUSED_SIGNATURE' });
        }
        let type; let payload;
        if (message.type === 'mesh.manifest.request') {
          type = 'mesh.manifest.response';
          payload = {
            protocolVersion: 1, nodeId: mobile.device.deviceId, name: mobile.device.deviceName, role: 'mobile', generatedAt: iso(Date.now()),
            capabilities: [
              { id: 'mesh.presence', available: true, requiresApproval: false, summary: '手机在线状态' },
              { id: 'notification.send', available: true, requiresApproval: true, summary: '在手机本地显示通知（需本地批准）' }
            ]
          };
        } else if (message.type === 'mesh.presence.ping') {
          type = 'mesh.presence.pong';
          payload = { presence: 'online', role: 'mobile', nodeId: mobile.device.deviceId, at: iso(Date.now()) };
        } else if (message.type === 'mesh.capability.request') {
          const capability = String(message.payload.capability || '');
          if (capability !== 'notification.send') throw Object.assign(new Error('not declared'), { code: 'CAPABILITY_NOT_DECLARED' });
          type = 'mesh.capability.response';
          if (!mobilePolicy.approved) {
            payload = { requestId: message.payload.requestId, decision: 'pending_approval', code: 'APPROVAL_REQUIRED' };
          } else {
            mobilePolicy.shown.push(message.payload.input || null);
            payload = { requestId: message.payload.requestId, decision: 'allow', code: 'ALLOWED', result: { shown: true, title: (message.payload.input || {}).title || null } };
          }
        } else {
          throw Object.assign(new Error('unsupported'), { code: 'REFUSED_REQUEST' });
        }
        return { envelope: createMeshEnvelope({ type, from: mobile.device.deviceId, to: message.from, payload, privateKeyPem: keys.mobile.privatePem, nowMs: Date.now() }) };
      }
    },
    log: (entry) => mobileNotes.push(entry)
  });
  const mobileStarted = await mobileServer.start({ port: mobileTls.port, fallbackPort: 0 });
  const mobileEndpoint = 'https://' + lan + ':' + mobileStarted.port;

  const session2 = await node.startPairingSession({});
  const mobile2 = createFixtureMobile({ keys });
  mobile2.scan(session2.invitation);
  const exchange2 = await httpsPostPinned({
    url: session2.endpoint + '/cetamesh/v1/pairing/exchange',
    tlsPin: session2.tlsPin,
    body: mobile2.exchangeBody({ extra: { endpoint: mobileEndpoint, tlsPin: mobileTls.fingerprint } })
  });
  equal('带 M6 端点的 exchange 成功', exchange2.status, 200);
  const confirm2 = await httpsPostPinned({ url: session2.endpoint + '/cetamesh/v1/pairing/confirm', tlsPin: session2.tlsPin, body: mobile2.confirmBody() });
  equal('带 M6 端点的 confirm 成功', confirm2.status, 200);
  const trustFile = JSON.parse(fs.readFileSync(path.join(stateDir, 'mesh', 'trust.json'), 'utf8'));
  const storedPeer = trustFile.peers.find((item) => item.nodeId === peerNodeId);
  equal('trust 记录保存手机 endpoint', storedPeer && storedPeer.endpoint, mobileEndpoint);
  equal('trust 记录保存手机证书 pin', storedPeer && storedPeer.tlsPin, mobileTls.fingerprint);

  const remoteManifest = await node.requestPeerManifest({ nodeId: peerNodeId });
  check('Desktop → Mobile manifest 真实往返（含 notification.send）', remoteManifest.manifest.capabilities.some((item) => item.id === 'notification.send'));
  const notifyPending = await node.requestPeerCapability({ nodeId: peerNodeId, capability: 'notification.send', input: { title: 'CetaMesh 已配对' } });
  equal('手机本地未批准 → pending_approval', notifyPending.response.decision, 'pending_approval');
  mobilePolicy.approved = true; // 模拟手机本地批准（真机为 Android 本地审批）
  const notifyAllowed = await node.requestPeerCapability({ nodeId: peerNodeId, capability: 'notification.send', input: { title: 'CetaMesh 已配对' } });
  equal('手机本地批准后 → allow', notifyAllowed.response.decision, 'allow');
  equal('手机本地真的"显示"了一次通知（fixture 记录）', mobilePolicy.shown.length, 1);
  // pin 不符：Desktop 客户端在发送任何字节前断开，手机端零请求
  const mobileNotesBefore = mobileNotes.filter((entry) => entry.code === 'OK').length;
  const wrongPinToMobile = await asyncCapture(() => httpsPostPinned({ url: mobileEndpoint + '/cetamesh/v1/mesh/envelope', tlsPin: sha256hex('wrong'), body: JSON.stringify(presencePing.request) }));
  check('Desktop→Mobile pin 不符时本地拒绝（PIN_MISMATCH）', wrongPinToMobile.threw && wrongPinToMobile.code === 'PIN_MISMATCH');
  equal('pin 不符时手机端未收到任何请求', mobileNotes.filter((entry) => entry.code === 'OK').length, mobileNotesBefore);
  await mobileServer.stop();

  await node.close();
}

// ────────────────────────────────────────────────────────────────────────────
// D. 重启免扫码 / 撤销 / 消费记录持久化
// ────────────────────────────────────────────────────────────────────────────
async function sectionRestartAndRevoke() {
  const keys = fixture('test-keys.json');
  const stateDir = path.join(root, 'desktop-restart');
  const nodeA = createMeshNode({ stateDir, name: 'CetaMesh Desktop', role: 'desktop' });
  const sessionA = await nodeA.startPairingSession({});
  const mobileA = createFixtureMobile({ keys });
  mobileA.scan(sessionA.invitation);
  await httpsPostPinned({ url: sessionA.endpoint + '/cetamesh/v1/pairing/exchange', tlsPin: sessionA.tlsPin, body: mobileA.exchangeBody() });
  await httpsPostPinned({ url: sessionA.endpoint + '/cetamesh/v1/pairing/confirm', tlsPin: sessionA.tlsPin, body: mobileA.confirmBody() });
  const nodeIdA = nodeA.identity().nodeId;
  const peerId = nodeA.pairingStatus().peerNodeId;
  const pinA = sessionA.tlsPin;
  const endpointA = sessionA.endpoint;
  await nodeA.close();

  const nodeB = createMeshNode({ stateDir, name: 'CetaMesh Desktop', role: 'desktop' });
  equal('重启后身份不变', nodeB.identity().nodeId, nodeIdA);
  check('重启后信任仍在', nodeB.peers().some((item) => item.nodeId === peerId && item.trust === 'trusted'));
  const sessionB = await nodeB.startPairingSession({});
  equal('重启后 endpoint（IP:端口）稳定', sessionB.endpoint, endpointA);
  equal('重启后证书指纹稳定（pin 不变）', sessionB.tlsPin, pinA);
  const presence = await mobileA.mesh({ endpoint: sessionB.endpoint, tlsPin: sessionB.tlsPin, type: 'mesh.presence.ping', to: nodeIdA });
  equal('重启后免扫码 presence 直连成功', presence.status, 200);
  equal('presence 状态 online', JSON.parse(presence.body).payload.presence, 'online');

  nodeB.removeTrust({ nodeId: peerId });
  const revoked = await mobileA.mesh({ endpoint: sessionB.endpoint, tlsPin: sessionB.tlsPin, type: 'mesh.presence.ping', to: nodeIdA });
  equal('撤销后请求被拒（401/PEER_UNTRUSTED）', [revoked.status, JSON.parse(revoked.body).error.code], [401, 'PEER_UNTRUSTED']);
  const blocked = nodeB.peers().find((item) => item.nodeId === peerId);
  equal('撤销后 blocked 且 grants 清空', [blocked.trust, blocked.grants], ['blocked', []]);
  await nodeB.close();

  // 消费记录：跨实例持久化 + 不含原始 token
  const store = createInvitationStore({ stateDir });
  const session = store.createSession({ endpoint: 'https://192.168.1.5:47999', peer: { deviceId: 'node_' + 'a'.repeat(32), deviceName: 'x', publicKey: keys.desktop.x963 }, tlsPin: 'ab'.repeat(32) });
  store.consume({ invitationId: session.invitationId, token: session.token, peerDeviceId: 'dev-1' });
  const store2 = createInvitationStore({ stateDir });
  check('消费指纹跨实例持久化', store2.usedFingerprints().includes(sha256hex(session.token)));
  check('重启后原会话不可再次消费', capture(() => store2.consume({ invitationId: session.invitationId, token: session.token })).threw === true);
  check('消费记录文件不含原始 token', !fs.readFileSync(path.join(stateDir, 'mesh', 'pairing-used.json'), 'utf8').includes(session.token));
  check('身份文件含 keyAlgorithm=p256', fs.readFileSync(path.join(stateDir, 'mesh', 'identity.json'), 'utf8').includes('"keyAlgorithm": "p256"'));
  const tlsFile = JSON.parse(fs.readFileSync(path.join(stateDir, 'mesh', 'pairing-tls.json'), 'utf8'));
  check('配对 TLS 私钥单独落盘且指纹自洽', typeof tlsFile.keyPem === 'string' && tlsFile.fingerprint.length === 64);
}

// ────────────────────────────────────────────────────────────────────────────
// E. 服务层 + 全局 TLS 守卫
// ────────────────────────────────────────────────────────────────────────────
async function sectionServiceAndGuards() {
  const serviceStateDir = path.join(root, 'service');
  const pairingTls = await loadOrCreatePairingTls({ stateDir: serviceStateDir, name: 'CetaMesh Desktop (svc)' });
  const pairingTlsRecord = readJsonFile(pairingTls.file);
  writeJsonAtomic(pairingTls.file, { ...pairingTlsRecord, port: 0 });
  const service = createMeshService({ stateDir: serviceStateDir, name: 'CetaMesh Desktop (svc)', role: 'desktop' });
  const snapshot = await service.execute({ method: 'mesh.snapshot', params: {} });
  check('mesh.snapshot 包含 pairing 状态', snapshot.pairing && snapshot.pairing.active === false);
  const start = await service.execute({ method: 'mesh.pairing.start', params: {} });
  check('mesh.pairing.start 返回 QR + 邀请 + 安全说明', Boolean(start.qr) && start.qr.rows.length === start.qr.size && typeof start.invitation === 'string' && start.securityNote.includes('一次性'));
  check('mesh.pairing.start 不把 token 写进审计', !JSON.stringify(service.node.audit()).includes(JSON.parse(start.invitation).payload.token));
  const status = await service.execute({ method: 'mesh.pairing.status', params: {} });
  check('mesh.pairing.status 活动会话可见', status.active === true && status.sessionId === start.sessionId);
  equal('mesh.pairing.cancel 生效', (await service.execute({ method: 'mesh.pairing.cancel', params: {} })).cancelled, true);
  equal('取消后会话关闭', (await service.execute({ method: 'mesh.pairing.status', params: {} })).active, false);
  equal('未知方法仍然 METHOD_NOT_FOUND', (await asyncCapture(() => service.execute({ method: 'mesh.pairing.nope', params: {} }))).code, 'METHOD_NOT_FOUND');
  await service.close();

  // 全局 TLS 守卫：仓库内不得出现关闭全局 TLS 校验的开关
  const sourceFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) sourceFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'mesh'));
  const offenders = sourceFiles.filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('NODE_TLS_REJECT_UNAUTHORIZED') || /hostnameVerifier\s*=\s*true/.test(text);
  });
  equal('src/mesh 内不存在关闭全局 TLS 的开关', offenders.map((file) => path.relative(ROOT, file)), []);
  const clientSource = fs.readFileSync(path.join(ROOT, 'src', 'mesh', 'pairing', 'client.js'), 'utf8');
  check('客户端 pin 校验发生在任何请求字节之前（源码顺序守卫）', clientSource.indexOf('PIN_MISMATCH') > 0 && clientSource.indexOf('PIN_MISMATCH') < clientSource.indexOf("socket.write("));
}

// ────────────────────────────────────────────────────────────────────────────
// 执行
// ────────────────────────────────────────────────────────────────────────────
try {
  console.log('── A. 共享 golden fixtures ──');
  sectionFixtures();
  console.log('── B. Desktop 身份 v2（P-256）受控迁移 ──');
  sectionIdentityMigration();
  console.log('── C. 真实局域网 socket 互操作 ──');
  await sectionLiveInterop();
  console.log('── D. 重启 / 撤销 / 一次性 token 持久化 ──');
  await sectionRestartAndRevoke();
  console.log('── E. 服务层方法面 + 全局 TLS 守卫 ──');
  await sectionServiceAndGuards();
} catch (error) {
  failed += 1;
  console.log('FAIL 未捕获异常 — ' + String((error && error.stack) || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}

console.log('\n汇总：PASS ' + passed + ' · FAIL ' + failed);
// 硬退出：本套件跑真实 socket，避免个别 keep-alive 句柄让进程悬挂（结论已确定）。
process.exit(failed > 0 ? 1 : 0);
