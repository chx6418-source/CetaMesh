// CetaMesh Desktop —— 诊断信息（产品化任务 D，第四节）。
//
// 诊断附件的安全模型是**白名单 + 二次脱敏**，而不是黑名单：
//   1) 只有本文件里显式列出的字段会进 payload —— 版本、平台、Build ID、最近错误码、
//      Provider/Plugin 的**状态布尔值**。聊天内容、Memory、文件正文、prompt 根本没有入口，
//      因为它们不在白名单里（即使调用方把整个对象塞进来也不会被读取）；
//   2) 所有剩下的字符串仍然过一次既有 redaction（src/logging/redact.js），
//      防止「插件 id 里被人塞了 token」这类意外；
//   3) 长度有界，整个 payload 有硬上限，避免把状态文件整份带出去。
//
// 用户可见性：DIAGNOSTICS_POLICY 明确列出「包含什么/绝不包含什么」，UI 直接展示给用户看，
// 而不是让用户盲选一个「附加诊断信息」的勾选框。

import { redactText } from '../logging/index.js';

export const DIAGNOSTICS_SCHEMA_VERSION = 1;
/** 整个诊断附件的硬上限（字节）。超过就丢弃低价值字段，绝不截断成半截 JSON。 */
export const DIAGNOSTICS_MAX_BYTES = 32 * 1024;

export const DIAGNOSTICS_POLICY = Object.freeze({
  includes: Object.freeze([
    '产品名与版本',
    'Build ID / Commit / 构建时间',
    '平台与架构（含 Node 版本）',
    '最近错误码（只含枚举码，不含消息）',
    'Model Provider 配置状态（是否已配置 Key 的布尔值）',
    '插件数量与启用/关闭数量',
    '少量安全设置项（主题、是否自动检查更新、日志脱敏开关）'
  ]),
  excludes: Object.freeze([
    'API Key 与任何凭据',
    'token / session / cookie / 配对密钥',
    '聊天内容（消息正文、prompt、回复）',
    'Memory（长期记忆）内容',
    '文件正文与文件路径',
    'private key 与证书私钥材料'
  ])
});

function clamp(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

/** 字符串一律过 redaction 再截断：白名单字段也不假设「一定安全」。 */
function safeText(value, max = 120) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return clamp(redactText(text), max);
}

function safeCode(value) {
  const text = safeText(value, 64);
  if (!text) return null;
  // 错误码是枚举量：只保留 [A-Z0-9_.-]，避免把消息伪装成 code 混进来。
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : null;
}

function safeBool(value) {
  return value === true;
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * 组装诊断附件。
 * 所有输入都可为空 —— 拿不到的部分如实缺省（null / 0），绝不编造，也绝不因为缺数据而抛错。
 */
export function buildDiagnostics({
  aboutInfo = null,
  providers = [],
  extensions = [],
  settings = null,
  errorRegistry = null,
  lastErrorCode = null,
  now = () => Date.now()
} = {}) {
  const recent = typeof errorRegistry?.list === 'function' ? errorRegistry.list() : [];
  const last = typeof errorRegistry?.last === 'function' ? errorRegistry.last() : null;

  const payload = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    product: {
      name: safeText(aboutInfo?.product, 40),
      edition: safeText(aboutInfo?.edition, 40),
      version: safeText(aboutInfo?.version, 40),
      shellVersion: safeText(aboutInfo?.shellVersion, 40),
      versionConsistent: aboutInfo ? aboutInfo.versionConsistent === true : null
    },
    build: {
      buildId: safeText(aboutInfo?.build?.buildId, 80),
      commit: safeText(aboutInfo?.build?.commit, 64),
      commitSource: safeCode(aboutInfo?.build?.commitSource),
      buildTime: safeText(aboutInfo?.build?.buildTime, 40)
    },
    platform: {
      os: safeText(aboutInfo?.runtime?.platform ?? process.platform, 40),
      arch: safeText(aboutInfo?.runtime?.arch ?? process.arch, 40),
      node: safeText(aboutInfo?.runtime?.node ?? process.versions.node, 40)
    },
    // 只发状态布尔值：Provider 的 label 是产品文案（安全），Key 本身永远不在这里。
    providers: (Array.isArray(providers) ? providers : []).slice(0, 20).map((provider) => ({
      id: safeText(provider?.id, 64),
      label: safeText(provider?.label, 80),
      hasKey: safeBool(provider?.hasKey)
    })),
    plugins: {
      total: safeCount(extensions?.length ?? extensions?.total),
      enabled: safeCount(Array.isArray(extensions) ? extensions.filter((entry) => entry?.enabled === true).length : extensions?.enabled),
      disabled: safeCount(Array.isArray(extensions) ? extensions.filter((entry) => entry?.enabled !== true).length : extensions?.disabled)
    },
    settings: {
      theme: safeText(settings?.general?.theme, 20),
      autoCheckUpdates: settings?.updates?.autoCheck === true,
      redactLogs: settings?.security?.redactLogs === true
    },
    lastErrorCode: safeCode(lastErrorCode) || safeCode(last?.code),
    recentErrorCodes: recent.slice(-10).map((entry) => safeCode(entry?.code)).filter(Boolean)
  };

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > DIAGNOSTICS_MAX_BYTES) {
    // 理论上到不了这里（字段全部有界）；真到了就丢掉历史错误码而不是产出超大附件。
    payload.recentErrorCodes = [];
    payload.truncated = true;
  }
  return payload;
}

/**
 * 二次防线：任何要进入反馈 payload 的对象都过一遍。
 * 逐字段保留白名单结构，并把所有字符串再脱敏一次；非白名单字段直接丢弃。
 */
export function sanitizeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  return {
    schemaVersion: diagnostics.schemaVersion ?? DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: safeText(diagnostics.generatedAt, 40),
    product: {
      name: safeText(diagnostics.product?.name, 40),
      edition: safeText(diagnostics.product?.edition, 40),
      version: safeText(diagnostics.product?.version, 40),
      shellVersion: safeText(diagnostics.product?.shellVersion, 40),
      versionConsistent: diagnostics.product?.versionConsistent === true ? true : null
    },
    build: {
      buildId: safeText(diagnostics.build?.buildId, 80),
      commit: safeText(diagnostics.build?.commit, 64),
      commitSource: safeCode(diagnostics.build?.commitSource),
      buildTime: safeText(diagnostics.build?.buildTime, 40)
    },
    platform: {
      os: safeText(diagnostics.platform?.os, 40),
      arch: safeText(diagnostics.platform?.arch, 40),
      node: safeText(diagnostics.platform?.node, 40)
    },
    providers: (Array.isArray(diagnostics.providers) ? diagnostics.providers : []).slice(0, 20).map((provider) => ({
      id: safeText(provider?.id, 64),
      label: safeText(provider?.label, 80),
      hasKey: provider?.hasKey === true
    })),
    plugins: {
      total: safeCount(diagnostics.plugins?.total),
      enabled: safeCount(diagnostics.plugins?.enabled),
      disabled: safeCount(diagnostics.plugins?.disabled)
    },
    settings: {
      theme: safeText(diagnostics.settings?.theme, 20),
      autoCheckUpdates: diagnostics.settings?.autoCheckUpdates === true,
      redactLogs: diagnostics.settings?.redactLogs === true
    },
    lastErrorCode: safeCode(diagnostics.lastErrorCode),
    recentErrorCodes: (Array.isArray(diagnostics.recentErrorCodes) ? diagnostics.recentErrorCodes : [])
      .slice(-10)
      .map((code) => safeCode(code))
      .filter(Boolean)
  };
}

/** 「最小 metadata」：安全漏洞反馈默认只带这些，绝不自动附加日志。 */
export function minimalDiagnostics({ aboutInfo = null, now = () => Date.now() } = {}) {
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    product: {
      name: safeText(aboutInfo?.product, 40),
      version: safeText(aboutInfo?.version, 40)
    },
    platform: {
      os: safeText(aboutInfo?.runtime?.platform ?? process.platform, 40),
      arch: safeText(aboutInfo?.runtime?.arch ?? process.arch, 40)
    },
    minimal: true
  };
}
