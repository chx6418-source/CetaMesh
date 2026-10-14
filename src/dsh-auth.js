// DSH 0.1.5+ web 服务对 /api/* 强制浏览器会话 Cookie 鉴权（回环地址也不例外）。
// 协议与 @deepseek-ai/dsh-client-connection 的 BrowserAuth 对齐：
//   Cookie 名 = "dsh-auth-" + base64url(sha256(authority))，authority = 请求 Host（含端口）
//   Cookie 值 = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
//   payload   = { version: 1, authority, issuedAt, expiresAt }（毫秒时间戳，服务端上限 30 天）
// secret 持久保存在 <DSH_HOME>/.credentials.yaml 的 client-connection/browser-session 记录里，
// 跨 dsh web 重启不变，因此这里离线锻造即可，无需抓取启动 URL 里的 ?token=。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_TTL_MS = 25 * 24 * 60 * 60 * 1000; // 服务端上限 30 天，留出时钟偏差余量
const SECRET_RECACHE_MS = 60 * 1000;

let cachedSecret = null;
let cachedSecretAt = 0;
let cachedSecretFile = null;

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function dshCredentialsFile(dshHome = null) {
  const home = (typeof dshHome === 'string' && dshHome.trim())
    || (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/** 从 .credentials.yaml 提取 client-connection/browser-session 的 base64url secret（返回原始字节）。 */
export function readDshSessionSecret(dshHome = null) {
  const file = dshCredentialsFile(dshHome);
  if (cachedSecret && cachedSecretFile === file && Date.now() - cachedSecretAt < SECRET_RECACHE_MS) return cachedSecret;
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf('client-connection/browser-session:');
  if (at === -1) throw new Error(`${file} 里没有 client-connection/browser-session 记录（DSH web 尚未首次启动过？）`);
  const match = text.slice(at, at + 2000).match(/^\s+secret:\s*([A-Za-z0-9_-]+)\s*$/m);
  if (!match) throw new Error(`${file} 的 browser-session 记录里找不到 secret 字段`);
  const secret = Buffer.from(match[1], 'base64url');
  if (secret.byteLength !== 32) throw new Error(`${file} 的 secret 长度异常（${secret.byteLength} 字节，应为 32）`);
  cachedSecret = secret;
  cachedSecretAt = Date.now();
  cachedSecretFile = file;
  return secret;
}

/** 按 dsh-client-connection 规则锻造指定 authority 的会话 Cookie（形如 "dsh-auth-xxx=v1.…"）。 */
export function forgeDshAuthCookie(authority, now = Date.now(), dshHome = null) {
  const name = COOKIE_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authority).digest());
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + COOKIE_TTL_MS };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = encodeBase64Url(crypto.createHmac('sha256', readDshSessionSecret(dshHome)).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}

/** 从 baseUrl（如 http://127.0.0.1:3080）取 authority（"127.0.0.1:3080"）。 */
export function authorityOf(baseUrl) {
  return new URL(baseUrl).host;
}

/**
 * 解析桥接可用的 DSH 鉴权 Cookie：
 * 优先用配置里手动指定的 authCookie（完整 "dsh-auth-…=v1.…" 或裸 "v1.…" 值），
 * 否则用本机 DSH secret 离线锻造。返回形如 "name=value" 的完整 Cookie 头值。
 */
export function resolveDshAuthCookie(baseUrl, authCookie, dshHome = null) {
  if (authCookie && String(authCookie).trim()) {
    const raw = String(authCookie).trim();
    // 裸值（以 v1. 开头）补上按 authority 派生的 Cookie 名；否则视为完整 "name=value" 对
    return raw.startsWith('v1.') ? `${COOKIE_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authorityOf(baseUrl)).digest())}=${raw}` : raw;
  }
  return forgeDshAuthCookie(authorityOf(baseUrl), Date.now(), dshHome);
}
