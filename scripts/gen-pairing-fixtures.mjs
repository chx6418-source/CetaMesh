#!/usr/bin/env node
// CetaMesh 统一配对协议 v1.1 —— Golden Fixture 生成器。
//
// 用途：生成 fixtures/pairing/ 下两端仓库共享的协议测试向量。
// 约束：
//   · 本脚本嵌入**固定的测试专用密钥**（仅测试，绝不可用于任何真实环境）；
//   · 除 ECDSA 签名值本身随机外，其余内容全部确定性生成；
//     签名文件是"冻结向量"——默认不覆盖已存在的文件，必须显式 --force。
//   · 对协议的任何修改（transcript / 字段 / 语义）必须同步：协议文档 + 两端实现 + 本 fixtures。
//
// 用法：node scripts/gen-pairing-fixtures.mjs [--out fixtures/pairing] [--force]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const outIndex = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIndex >= 0 ? args[outIndex + 1] : path.join('fixtures', 'pairing'));

// ── 固定测试密钥（TEST ONLY）────────────────────────────────────────────────
const KEYS = {
  desktop: {
    privatePem: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNJNtmCD8FB54i/gi\nu7sShjavQnjs1RVR7w0R1bJSZJ2hRANCAARhpnhlkd5oMCF+FW3Dq9vCPJmp4BfI\n7rrdvPQy1jQt70RS9Df74lM4u1pkgHIvrubqdzPnLCv+mP6qWSNPtuFq\n-----END PRIVATE KEY-----\n',
    publicPem: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYaZ4ZZHeaDAhfhVtw6vbwjyZqeAX\nyO663bz0MtY0Le9EUvQ3++JTOLtaZIByL67m6ncz5ywr/pj+qlkjT7bhag==\n-----END PUBLIC KEY-----\n',
    x963: 'BGGmeGWR3mgwIX4VbcOr28I8mangF8juut289DLWNC3vRFL0N/viUzi7WmSAci+u5up3M+csK/6Y/qpZI0+24Wo=',
    nodeId: 'node_ec23aac43cd6bfe4c3b03ab0a377a8cb'
  },
  mobile: {
    privatePem: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgst3UPZflYtkAq5Uc\nlKK6TEJdJYpWsvBSR0vOlxWAfWehRANCAATUmlxYdaFUMy+2h8DD+Jmv9kRGMa3u\nJD0Mdx0DQ8FXfzJe7xtOyzHcWuG5OEKBtAJ3ZfwXU1McSr1tJagtgn0B\n-----END PRIVATE KEY-----\n',
    publicPem: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1JpcWHWhVDMvtofAw/iZr/ZERjGt\n7iQ9DHcdA0PBV38yXu8bTssx3FrhuThCgbQCd2X8F1NTHEq9bSWoLYJ9AQ==\n-----END PUBLIC KEY-----\n',
    x963: 'BNSaXFh1oVQzL7aHwMP4ma/2REYxre4kPQx3HQNDwVd/Ml7vG07LMdxa4bk4QoG0Andl/BdTUxxKvW0lqC2CfQE=',
    nodeId: 'node_dc61c162c6e416315297154887a1185c'
  },
  legacyEd25519: {
    privatePem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB2MZt1lTJuP/kUPMkeANAaEkuVg4n8VUroCAsexFWZR\n-----END PRIVATE KEY-----\n',
    publicPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3ikxNJfAbN/tLULqesjopnQcNF34r3uLv6Ja/U+sHs0=\n-----END PUBLIC KEY-----\n'
  }
};

// ── 固定时间与标识 ──────────────────────────────────────────────────────────
const TIMESTAMP = '2026-10-08T12:00:00.000Z';
const EXPIRES_AT = '2026-10-08T12:04:30.000Z'; // TTL 270s
const INVITATION_ID = 'inv_7f3a91c2d4e5b6a8';
const ENDPOINT = 'https://192.168.1.23:47821';
const DESKTOP_NAME = 'CetaMesh Desktop';
const MOBILE_DEVICE = {
  deviceId: 'a7f3c1e0-9b2d-4e6a-9f11-7c3d5e8b0a42',
  deviceName: 'Pixel 9 测试机',
  publicKey: KEYS.mobile.x963,
  platform: 'android',
  createdAt: TIMESTAMP
};

const sha256hex = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const tokenBytes = crypto.createHash('sha256').update('cetamesh-pairing-fixture-token-1').digest();
const TOKEN = tokenBytes.toString('base64');
const NONCE = crypto.createHash('sha256').update('cetamesh-pairing-fixture-nonce-1').digest().toString('base64');
const MESH_NONCE = crypto.createHash('sha256').update('cetamesh-mesh-fixture-nonce-1').digest().toString('base64');
const TLS_PIN = sha256hex('cetamesh-fixture-tls-cert-v1');

const sign = (privatePem, text) => crypto.sign('sha256', Buffer.from(text, 'utf8'), crypto.createPrivateKey(privatePem)).toString('base64');
const verify = (publicPem, text, signature) => crypto.verify('sha256', Buffer.from(text, 'utf8'), crypto.createPublicKey(publicPem), Buffer.from(signature, 'base64'));

const desktopPeer = { deviceId: KEYS.desktop.nodeId, deviceName: DESKTOP_NAME, publicKey: KEYS.desktop.x963, keyAlgorithm: 'p256' };
const desktopPeerNoAlg = { deviceId: KEYS.desktop.nodeId, deviceName: DESKTOP_NAME, publicKey: KEYS.desktop.x963 };
const invitationV11 = { invitationId: INVITATION_ID, endpoint: ENDPOINT, token: TOKEN, expiresAt: EXPIRES_AT, peer: desktopPeer, tlsPin: TLS_PIN };
const invitationV1 = { invitationId: INVITATION_ID, endpoint: ENDPOINT, token: TOKEN, expiresAt: EXPIRES_AT, peer: desktopPeerNoAlg };

const envelope = (id, type, payload, timestamp = TIMESTAMP) => ({ protocol: 'cetamesh', version: 1, id, type, timestamp, payload });

// v1.1 transcript（与协议文档 §3 逐字节一致）
function transcript(invitation, device, nonce, phase) {
  const base = ['cetamesh-pairing-v1.1', phase, invitation.invitationId, invitation.endpoint,
    invitation.peer.deviceId, invitation.peer.publicKey, device.deviceId, device.publicKey, nonce, invitation.expiresAt];
  return JSON.stringify(base.concat(invitation.tlsPin));
}
function meshSigningString(type, id, from, to, timestamp, nonce, ph) {
  return JSON.stringify(['cetamesh-mesh-v1', type, id, from, to, timestamp, nonce, ph]);
}

const exchangeSig = sign(KEYS.mobile.privatePem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'exchange'));
const challengeSig = sign(KEYS.desktop.privatePem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'challenge'));
const acceptedSig = sign(KEYS.desktop.privatePem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'accepted'));
const confirmSig = sign(KEYS.mobile.privatePem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'confirm'));

const exchangePayload = { invitationId: INVITATION_ID, token: TOKEN, nonce: NONCE, device: MOBILE_DEVICE, signature: exchangeSig };
const challengePayload = { invitationId: INVITATION_ID, nonce: NONCE, peer: desktopPeer, expiresAt: EXPIRES_AT, signature: challengeSig };
const acceptedPayload = { invitationId: INVITATION_ID, nonce: NONCE, peer: desktopPeer, expiresAt: EXPIRES_AT, signature: acceptedSig };

const presencePayload = {};
const presencePh = sha256hex(JSON.stringify(presencePayload));
const presenceId = 'mesh-msg-0001';
const presenceSig = sign(KEYS.mobile.privatePem, meshSigningString('mesh.presence.ping', presenceId, MOBILE_DEVICE.deviceId, KEYS.desktop.nodeId, TIMESTAMP, MESH_NONCE, presencePh));
const presenceEnvelope = {
  protocol: 'cetamesh', version: 1, id: presenceId, type: 'mesh.presence.ping', timestamp: TIMESTAMP,
  from: MOBILE_DEVICE.deviceId, to: KEYS.desktop.nodeId, nonce: MESH_NONCE, payload: presencePayload, ph: presencePh, signature: presenceSig
};

// ── 自检：固定向量必须自洽（防止协议改动后 fixtures 静默失真）──────────────
function assert(condition, message) {
  if (!condition) throw new Error('[gen-pairing-fixtures] 自检失败：' + message);
}
assert(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(TOKEN), 'token 必须符合 v1 nonce 文法');
assert(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(NONCE), 'nonce 必须符合 v1 文法');
assert(/^B[A-Za-z0-9+/]{85}[AEIMQUYcgkosw048]=$/.test(KEYS.desktop.x963), 'desktop x963 文法');
assert(/^[0-9a-f]{64}$/.test(TLS_PIN), 'tlsPin 必须是小写 hex64');
{
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const der = Buffer.concat([spkiPrefix, Buffer.from(KEYS.desktop.x963, 'base64')]);
  const derived = 'node_' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  assert(derived === KEYS.desktop.nodeId, 'nodeId 必须与 x963 派生的 SPKI 一致');
}
assert(verify(KEYS.mobile.publicPem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'exchange'), exchangeSig), 'exchange 签名自洽');
assert(verify(KEYS.desktop.publicPem, transcript(invitationV11, MOBILE_DEVICE, NONCE, 'challenge'), challengeSig), 'challenge 签名自洽');
assert(verify(KEYS.mobile.publicPem, meshSigningString('mesh.presence.ping', presenceId, MOBILE_DEVICE.deviceId, KEYS.desktop.nodeId, TIMESTAMP, MESH_NONCE, presencePh), presenceSig), 'presence 签名自洽');

// ── 构建 fixture 文件集 ─────────────────────────────────────────────────────
const badSignature = exchangeSig.split('').map((char, index) => (index === Math.floor(exchangeSig.length / 2) ? (char === 'A' ? 'B' : 'A') : char)).join('');

const files = {
  'test-keys.json': {
    _warning: 'TEST ONLY — 这些密钥只用于协议 fixture，绝不可用于任何真实设备或环境。',
    desktop: { publicPem: KEYS.desktop.publicPem, x963: KEYS.desktop.x963, nodeId: KEYS.desktop.nodeId, privatePem: KEYS.desktop.privatePem },
    mobile: { publicPem: KEYS.mobile.publicPem, x963: KEYS.mobile.x963, nodeId: KEYS.mobile.nodeId, privatePem: KEYS.mobile.privatePem },
    legacyEd25519: { publicPem: KEYS.legacyEd25519.publicPem, privatePem: KEYS.legacyEd25519.privatePem }
  },
  'invitation-v1.json': {
    description: '合法的 v1 邀请（无 tlsPin / 无 keyAlgorithm）。now 用 envelope 的 timestamp。',
    now: TIMESTAMP, expect: 'accept', envelope: envelope('pairing-invite-0001', 'pairing.invitation', invitationV1)
  },
  'invitation-v1.1.json': {
    description: '合法的 v1.1 邀请（含 keyAlgorithm 与 tlsPin）。now 用 envelope 的 timestamp。',
    now: TIMESTAMP, expect: 'accept', envelope: envelope('pairing-invite-0001', 'pairing.invitation', invitationV11)
  },
  'transcripts-v1.1.json': {
    description: 'v1.1 四个 phase 的 transcript 精确字符串（与协议文档 §3 逐字节一致）。',
    invitation: 'invitation-v1.1.json', device: { deviceId: MOBILE_DEVICE.deviceId, publicKey: MOBILE_DEVICE.publicKey }, nonce: NONCE,
    phases: {
      exchange: transcript(invitationV11, MOBILE_DEVICE, NONCE, 'exchange'),
      challenge: transcript(invitationV11, MOBILE_DEVICE, NONCE, 'challenge'),
      confirm: transcript(invitationV11, MOBILE_DEVICE, NONCE, 'confirm'),
      accepted: transcript(invitationV11, MOBILE_DEVICE, NONCE, 'accepted')
    }
  },
  'exchange-v1.1.json': {
    description: 'Mobile → Desktop 的合法 exchange（v1.1 transcript 的固定签名向量）。',
    now: TIMESTAMP, expect: 'accept', envelope: envelope('mobile-event-0001', 'pairing.exchange', exchangePayload)
  },
  'challenge-v1.1.json': {
    description: 'Desktop → Mobile 的合法 challenge 响应（v1.1 transcript 的固定签名向量）。',
    now: TIMESTAMP, expect: 'accept', envelope: envelope('desktop-pairing-0001', 'pairing.challenge', challengePayload)
  },
  'accepted-v1.1.json': {
    description: 'Desktop → Mobile 的合法 accepted 响应（v1.1 transcript 的固定签名向量）。',
    now: TIMESTAMP, expect: 'accept', envelope: envelope('desktop-pairing-0002', 'pairing.accepted', acceptedPayload)
  },
  'confirm-v1.1.json': {
    description: 'Mobile → Desktop 的合法 confirm（v1.1 transcript 的固定签名向量）。',
    now: TIMESTAMP, expect: 'accept',
    envelope: envelope('mobile-event-0002', 'pairing.confirm', { invitationId: INVITATION_ID, nonce: NONCE, deviceId: MOBILE_DEVICE.deviceId, signature: confirmSig })
  },
  'bad-signature.json': {
    description: 'exchange 的签名被翻转一个字符（必须被拒绝：REFUSED_SIGNATURE）。',
    now: TIMESTAMP, expect: 'reject',
    envelope: envelope('mobile-event-0003', 'pairing.exchange', { ...exchangePayload, signature: badSignature })
  },
  'expired.json': {
    description: '过期邀请。now（12:05:10Z）晚于 expiresAt（12:04:30Z），必须被拒绝：REFUSED_EXPIRED。',
    now: '2026-10-08T12:05:10.000Z', expect: 'reject',
    envelope: envelope('pairing-invite-0002', 'pairing.invitation', { ...invitationV11, expiresAt: '2026-10-08T12:03:00.000Z' }, '2026-10-08T11:58:00.000Z')
  },
  'replay.json': {
    description: '同一 token 的第二次使用向量：token 指纹（小写 hex）与消费语义（必须被拒绝：REFUSED_CONSUMED）。',
    expect: 'reject', token: TOKEN, tokenFingerprint: sha256hex(TOKEN),
    firstUse: 'accept', secondUse: 'reject', secondUseWith: { invitationId: 'inv_0000000000000000', expect: 'reject' }
  },
  'mesh-presence-ping-v1.1.json': {
    description: '配对完成后的 mesh.presence.ping（Mobile → Desktop，固定签名向量）。',
    now: TIMESTAMP, expect: 'accept', envelope: presenceEnvelope
  },
  'README.md': `# fixtures/pairing — 统一配对协议 v1.1 共享测试向量

> 事实源：\`docs/protocol/UNIFIED_PAIRING_V1_1.md\`（两个仓库各存一份完全相同的副本）。
> 本目录内容在两个仓库中**逐字节相同**；改动必须同时更新两端。

- 生成：\`node scripts/gen-pairing-fixtures.mjs\`（Desktop 仓库内的作者工具）。
  除 ECDSA 签名外全部确定性生成；**签名文件是冻结向量**，脚本默认不覆盖已存在文件（\`--force\` 才覆盖）。
- 使用：每个 fixture 是 \`{description, now?, expect, envelope?}\` 包装；
  测试用 \`now\`（缺省 = envelope.timestamp）调用各自的解析/校验函数，验证 accept / reject 语义。
- \`transcripts-v1.1.json\` 的字符串必须两端逐字节一致（协议文档 §3）。
- \`test-keys.json\` 是**测试专用**密钥，绝不可用于真实设备。
`
};

fs.mkdirSync(OUT, { recursive: true });
let written = 0; const skipped = [];
for (const [name, content] of Object.entries(files)) {
  const file = path.join(OUT, name);
  if (fs.existsSync(file) && !force) { skipped.push(name); continue; }
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
  written += 1;
}
process.stdout.write(`[gen-pairing-fixtures] 写出 ${written} 个文件到 ${OUT}\n`);
if (skipped.length) process.stdout.write(`[gen-pairing-fixtures] 已存在、未覆盖（--force 可覆盖）：${skipped.join(', ')}\n`);
