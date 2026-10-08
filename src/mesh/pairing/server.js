// CetaMesh 统一配对 v1.1 —— Desktop 配对服务器（协议文档 §4/§6）。
//
// 只在需要时启动（用户点击「连接手机」/ 测试显式启动），绑定局域网 0.0.0.0:<持久化端口>；
// 与 legacy 控制台 HTTP（发行版禁止）是两回事：本服务器只有三条固定 POST 路由，
// 全部要求 cetamesh 信封 + 签名/token，独立于任何 UI 或控制面接口。
//
// 日志纪律：只记录 path + 错误码，绝不记录请求体、token、邀请原文。

import https from 'node:https';
import { meshError } from '../types.js';
import { PAIRING_LIMITS } from './protocol.js';

const ROUTES = Object.freeze({
  '/cetamesh/v1/pairing/exchange': { handler: 'exchange', requestLimit: PAIRING_LIMITS.requestChars },
  '/cetamesh/v1/pairing/confirm': { handler: 'confirm', requestLimit: PAIRING_LIMITS.requestChars },
  '/cetamesh/v1/mesh/envelope': { handler: 'mesh', requestLimit: PAIRING_LIMITS.responseChars }
});

const TRUST_CODES = new Set([
  'REFUSED_SIGNATURE', 'REFUSED_CONSUMED', 'REFUSED_EXPIRED', 'REFUSED_NOT_FOUND', 'REFUSED_REPLAY',
  'PEER_UNKNOWN', 'PEER_UNTRUSTED'
]);

function statusFor(error) {
  const code = String((error && error.code) || '');
  // 信任/凭据类拒绝 → 401；协议/结构类 → 400（Mobile 把非 2xx 折叠为 unauthorized/invalid_protocol）。
  return TRUST_CODES.has(code) ? 401 : 400;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(meshError('REFUSED_REQUEST', '请求体超过上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(meshError('REFUSED_REQUEST', '读取请求失败：' + String(error && error.message))));
  });
}

/**
 * handlers：{ exchange(bodyText, ctx), confirm(bodyText, ctx), mesh(bodyText, ctx) }
 *   · 返回 { envelope } → 200 + JSON 信封；
 *   · 抛出带 code 的 meshError → 4xx + { error: { code, message } }。
 */
export function createMeshPairingServer({ tls, handlers, log = null } = {}) {
  let server = null;
  let boundPort = null;

  const note = (path, code) => {
    if (typeof log === 'function') log({ scope: 'pairing-server', path, code });
  };

  async function handle(req, res) {
    const route = ROUTES[req.url];
    const respond = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (!route || req.method !== 'POST') {
      note(String(req.url).slice(0, 64), 'ROUTE_NOT_FOUND');
      respond(404, { error: { code: 'ROUTE_NOT_FOUND', message: '未找到该配对路由' } });
      return;
    }
    try {
      const bodyText = await readBody(req, route.requestLimit);
      const result = await handlers[route.handler](bodyText, { remote: req.socket.remoteAddress });
      respond(200, result.envelope);
      note(req.url, 'OK');
    } catch (error) {
      const code = (error && error.code) || 'REFUSED_REQUEST';
      note(req.url, code);
      respond(statusFor(error), { error: { code, message: String((error && error.message) || '配对请求被拒绝').slice(0, 200) } });
    }
  }

  return {
    get port() { return boundPort; },
    listening() { return Boolean(server && server.listening); },

    /** 启动监听；持久化端口被占用时回退到临时端口（endpoint 由调用方按实际端口重建）。 */
    start({ host = '0.0.0.0', port = null, fallbackPort = null } = {}) {
      if (server) return Promise.resolve({ port: boundPort });
      server = https.createServer({ key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.2' }, (req, res) => {
        handle(req, res).catch((error) => {
          note(String(req.url).slice(0, 64), (error && error.code) || 'INTERNAL');
          res.destroy(); // 兜底出口：连接已断时 destroy 幂等
        });
      });
      const attempt = (listenPort) => new Promise((resolve, reject) => {
        const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(listenPort, host);
      });
      return attempt(port === null ? (tls.port || 0) : port)
        .then((actual) => { boundPort = actual; return { port: actual }; })
        .catch((error) => {
          if (error && error.code === 'EADDRINUSE' && fallbackPort !== null) {
            return attempt(fallbackPort).then((actual) => { boundPort = actual; return { port: actual, fallback: true }; });
          }
          server = null;
          throw meshError('PAIRING_SERVER_FAILED', '配对服务器无法启动：' + String(error && error.code));
        });
    },

    stop() {
      return new Promise((resolve) => {
        const current = server;
        server = null;
        boundPort = null;
        if (!current) { resolve(); return; }
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    }
  };
}
