// CetaMesh 统一配对 v1.1 —— Desktop 作为客户端的 pin 外联（协议文档 §5/§6）。
//
// 为什么是"先握手、比对指纹、手指纹一致才发送"：
// Node 没有原生 certificate pinning API；对自签局域网证书，唯一正确的做法是
// 让握手完成（此时不做 PKI 校验），**在任何应用字节写出之前**把服务端叶子证书的
// sha256(DER) 与邀请里的 tlsPin 做严格相等比较，不等立即断开。
// 这不是 trust-all：trust 决策完全由"单证书指纹相等"承担，且被测试锁定
// （pin 不符时对端一个字节都收不到）。普通 HTTPS / Model Provider 不走这条路径。

import crypto from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { meshError } from '../types.js';
import { verifyPayload } from '../identity.js';
import { createMeshEnvelope, validateMeshEnvelope, PAIRING_LIMITS } from './protocol.js';

const RESPONSE_CAP = 65536;

export const MESH_ENVELOPE_PATH = '/cetamesh/v1/mesh/envelope';

function sha256hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseTarget(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw meshError('PEER_ENDPOINT_INVALID', '对端 endpoint 非法'); }
  if (parsed.protocol !== 'https:') throw meshError('PEER_ENDPOINT_INVALID', '对端 endpoint 必须是 https');
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 443,
    path: parsed.pathname + (parsed.search || '')
  };
}

/** 带证书指纹 pin 的 HTTPS POST；返回 { status, body }。 */
export function httpsPostPinned({ url, tlsPin, body, timeoutMs = 15000, path = null } = {}) {
  const pin = String(tlsPin || '');
  if (!/^[0-9a-f]{64}$/.test(pin)) throw meshError('PEER_ENDPOINT_INVALID', '缺少或非法的对端 tlsPin');
  const target = parseTarget(url);
  if (path) target.path = path;
  const requestBody = Buffer.from(String(body || ''), 'utf8');
  if (requestBody.length > PAIRING_LIMITS.responseChars) throw meshError('PEER_REQUEST_TOO_LARGE', '请求体超过上限');

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    const timer = setTimeout(() => fail(meshError('PEER_TIMEOUT', '对端请求超时')), timeoutMs);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy(); // destroy 幂等：已关闭的连接再 destroy 是安全的
      reject(error);
    }
    function succeed(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy(); // 同上，幂等释放
      resolve(value);
    }

    const chunks = [];
    let received = 0;
    let verified = false;
    let requestSent = false;

    // SNI 只对 DNS 名字设置（对 IP 设置会被 Node 忽略并告警）。
    const serverName = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.host) ? {} : { servername: target.host };
    socket = tlsConnect({ host: target.host, port: target.port, ...serverName, rejectUnauthorized: false, minVersion: 'TLSv1.2' });

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      const fingerprint = peer && peer.raw ? sha256hex(peer.raw) : null;
      if (!fingerprint || fingerprint !== pin) {
        fail(meshError('PIN_MISMATCH', '对端证书指纹与 tlsPin 不一致：已在发送任何数据前断开'));
        return;
      }
      verified = true;
      const head = 'POST ' + target.path + ' HTTP/1.1\r\n'
        + 'host: ' + target.host + (target.port === 443 ? '' : ':' + target.port) + '\r\n'
        + 'content-type: application/json; charset=utf-8\r\n'
        + 'content-length: ' + requestBody.length + '\r\n'
        + 'connection: close\r\n\r\n';
      requestSent = true;
      socket.write(Buffer.concat([Buffer.from(head, 'utf8'), requestBody]));
    });

    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > RESPONSE_CAP) { fail(meshError('PEER_RESPONSE_TOO_LARGE', '对端响应超过上限')); return; }
      chunks.push(chunk);
    });
    socket.once('end', () => {
      if (!verified || !requestSent) { fail(meshError('PIN_MISMATCH', 'TLS 校验未完成')); return; }
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) { fail(meshError('PEER_RESPONSE_INVALID', '对端响应缺少 HTTP 头')); return; }
      const head = text.slice(0, split);
      const lines = head.split('\r\n');
      const status = Number((lines[0] || '').split(' ')[1]);
      if (!Number.isFinite(status)) { fail(meshError('PEER_RESPONSE_INVALID', '对端 HTTP 状态行非法')); return; }
      const headers = {};
      for (const line of lines.slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const declared = Number(headers['content-length']);
      let bodyText = text.slice(split + 4);
      if (Number.isFinite(declared) && bodyText.length > declared) bodyText = bodyText.slice(0, declared);
      succeed({ status, body: bodyText });
    });
    socket.once('error', (error) => fail(meshError('PEER_NETWORK', '对端网络错误：' + String((error && error.code) || (error && error.message)))));
  });
}

/**
 * 向已配对对端发送一条 Mesh 通道消息（客户端侧）。
 * 对端必须先提供 endpoint + tlsPin（配对交换时携带），否则如实报 PEER_ENDPOINT_MISSING。
 */
export async function requestPeerMesh({ peer, identity, privateKeyPem, type, payload = {}, expectType, timeoutMs = 15000 } = {}) {
  if (!peer || !peer.endpoint || !peer.tlsPin) {
    throw meshError('PEER_ENDPOINT_MISSING', '对端未提供可直连端点（endpoint/tlsPin），无法反向调用');
  }
  const to = peer.peerDeviceId || peer.deviceId || peer.nodeId;
  const envelope = createMeshEnvelope({ type, from: identity.nodeId, to, payload, privateKeyPem });
  const response = await httpsPostPinned({
    url: String(peer.endpoint).replace(/\/+$/, '') + MESH_ENVELOPE_PATH,
    tlsPin: peer.tlsPin,
    body: JSON.stringify(envelope),
    timeoutMs,
    path: MESH_ENVELOPE_PATH
  });
  if (response.status !== 200) {
    let code = 'PEER_REFUSED';
    try { code = JSON.parse(response.body).error.code || code; } catch { code = 'PEER_REFUSED'; } // 非 JSON 错误体：回到默认码
    throw meshError(code, '对端拒绝该请求（' + code + '）');
  }
  let parsed;
  try { parsed = JSON.parse(response.body); } catch { throw meshError('PEER_RESPONSE_INVALID', '对端响应不是合法 JSON'); }
  const message = validateMeshEnvelope(parsed, { nowMs: Date.now(), toDeviceId: identity.nodeId });
  if (expectType && message.type !== expectType) throw meshError('PEER_RESPONSE_INVALID', '对端响应类型不符：' + message.type);
  if (!verifyPayload(peer.publicKeyPem, message.signingString, message.signature)) {
    throw meshError('PEER_SIGNATURE_INVALID', '对端响应签名校验失败');
  }
  return { payload: message.payload, envelope: message };
}
