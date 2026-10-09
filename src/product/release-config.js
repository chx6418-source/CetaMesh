// CetaMesh Desktop —— 官方发行配置（产品化任务 D）。
//
// 为什么要有这个文件：About 页要显示的「开发者 / 官方网站 / GitCode / GitHub / 许可证 /
// 隐私说明 / 安全说明」，以及 Feedback 要用的「反馈 endpoint / 安全联系入口」，都是
// **发行方的事实**，不是代码里可以随手写死的字符串。写死在源码里意味着：改一个链接要重新
// 发版，而且无法区分「尚未配置」和「配置成空」。所以统一放 `release-config.json`
// （随安装包分发的静态配置），运行时读取 + 归一化。
//
// 红线：
//   1) 没有配置就如实报 null（UI 显示「未配置」），**绝不编造**一个看起来像真的官网/邮箱；
//   2) 所有对外 URL 必须是 https（反馈会带诊断信息，明文 http 一律拒绝）；
//   3) 配置损坏不影响软件启动：回落默认值 + 如实带上 lastError，由 UI 提示，而不是崩溃或静默。

import path from 'node:path';
import { readJsonFile } from '../storage/json-file.js';

export const RELEASE_CONFIG_VERSION = 1;
export const RELEASE_CONFIG_FILENAME = 'release-config.json';

const MAX_TEXT = 300;
const MAX_URL = 600;

/** 未提供配置时的事实默认值：产品身份来自仓库既有事实，链接留空表示「未配置」。 */
export const DEFAULT_RELEASE_CONFIG = Object.freeze({
  schemaVersion: RELEASE_CONFIG_VERSION,
  product: 'CetaMesh',
  edition: 'Desktop',
  developer: null,
  website: null,
  repositories: Object.freeze({
    gitcode: 'https://gitcode.com/ygdnn/CetaMesh',
    github: 'https://github.com/chx6418-source/whalebridge',
    primary: 'https://github.com/chx6418-source/whalebridge'
  }),
  license: Object.freeze({
    name: 'GPL-3.0-only',
    file: 'LICENSE',
    url: 'https://www.gnu.org/licenses/gpl-3.0.html'
  }),
  privacy: Object.freeze({ doc: 'docs/product/PRIVACY.md', summary: '' }),
  security: Object.freeze({ doc: 'docs/product/SECURITY.md', contact: null, advisoryUrl: null }),
  feedback: Object.freeze({ endpoint: null, requestTimeoutMs: 4000, outboxMaxEntries: 100 })
});

function textOrNull(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** 只接受 https 的绝对 URL；其它一律当「未配置」（返回 null），不抛错、不猜测。 */
function httpsOrNull(value, max = MAX_URL) {
  const text = textOrNull(value, max);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null; // 非法 URL 视为未配置：About 要能照常显示，配置问题由 lastError 上报。
  }
}

/**
 * 从 GitHub 仓库地址推导「私密漏洞报告」入口。
 * 这是唯一一个可以从既有事实（仓库地址）确定性推导出来的官方安全入口，
 * 因此没有显式配置 contact 时用它兜底；推导不出来就返回 null（不编造邮箱）。
 */
export function deriveAdvisoryUrl(repositoryUrl) {
  const repo = httpsOrNull(repositoryUrl);
  if (!repo) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repo);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}/security/advisories/new`;
}

/** 安全联系入口：显式配置优先，其次 GitHub 私密报告，最后如实报 null。 */
export function resolveSecurityContact(config) {
  const explicit = httpsOrNull(config?.security?.contact);
  if (explicit) return { url: explicit, source: 'configured' };
  const derived = deriveAdvisoryUrl(config?.repositories?.github);
  if (derived) return { url: derived, source: 'github-advisories' };
  return { url: null, source: 'unconfigured' };
}

function normalize(raw, fallback) {
  const repo = raw && typeof raw.repositories === 'object' && raw.repositories ? raw.repositories : {};
  const license = raw && typeof raw.license === 'object' && raw.license ? raw.license : {};
  const privacy = raw && typeof raw.privacy === 'object' && raw.privacy ? raw.privacy : {};
  const security = raw && typeof raw.security === 'object' && raw.security ? raw.security : {};
  const feedback = raw && typeof raw.feedback === 'object' && raw.feedback ? raw.feedback : {};

  const gitcode = httpsOrNull(repo.gitcode) || fallback.repositories.gitcode;
  const github = httpsOrNull(repo.github) || fallback.repositories.github;
  const primary = httpsOrNull(repo.primary) || github || gitcode || fallback.repositories.primary;

  const timeout = Number(feedback.requestTimeoutMs);
  const maxEntries = Number(feedback.outboxMaxEntries);

  return {
    schemaVersion: RELEASE_CONFIG_VERSION,
    product: textOrNull(raw?.product, 40) || fallback.product,
    edition: textOrNull(raw?.edition, 40) || fallback.edition,
    developer: textOrNull(raw?.developer, 120),
    website: httpsOrNull(raw?.website),
    repositories: { gitcode, github, primary },
    license: {
      name: textOrNull(license.name, 60) || fallback.license.name,
      file: textOrNull(license.file, 200) || fallback.license.file,
      url: httpsOrNull(license.url) || fallback.license.url
    },
    privacy: {
      doc: textOrNull(privacy.doc, 200) || fallback.privacy.doc,
      summary: textOrNull(privacy.summary, 800) || ''
    },
    security: {
      doc: textOrNull(security.doc, 200) || fallback.security.doc,
      contact: httpsOrNull(security.contact),
      advisoryUrl: httpsOrNull(security.advisoryUrl)
    },
    feedback: {
      endpoint: httpsOrNull(feedback.endpoint),
      requestTimeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(Math.round(timeout), 500), 30000) : fallback.feedback.requestTimeoutMs,
      outboxMaxEntries: Number.isFinite(maxEntries) ? Math.min(Math.max(Math.round(maxEntries), 1), 1000) : fallback.feedback.outboxMaxEntries
    }
  };
}

/** 配置完整度（UI 用它决定显示「未配置」还是真实值，测试用它断言不编造）。 */
export function configReadiness(config) {
  const contact = resolveSecurityContact(config);
  return {
    developerConfigured: Boolean(config?.developer),
    websiteConfigured: Boolean(config?.website),
    feedbackEndpointConfigured: Boolean(config?.feedback?.endpoint),
    securityContactConfigured: Boolean(contact.url),
    securityContactSource: contact.source
  };
}

/**
 * 读取发行配置。缺失 → 默认值（不是错误）；损坏 → 默认值 + lastError（如实上报）。
 * read 可注入，测试用它覆盖「缺失 / 损坏 / 部分字段」三条路径。
 */
export function loadReleaseConfig({ rootDir, file = null, read = readJsonFile, fallback = DEFAULT_RELEASE_CONFIG } = {}) {
  const root = path.resolve(rootDir || process.cwd());
  const target = file || path.join(root, RELEASE_CONFIG_FILENAME);
  let raw = null;
  let lastError = null;
  try {
    raw = read(target, { missing: null });
  } catch (error) {
    // 配置损坏不阻断启动，但必须如实记录：UI/报告要能说出「配置读不出来」这件事。
    lastError = String(error?.code || error?.message || error);
  }
  const config = normalize(raw, fallback);
  const contact = resolveSecurityContact(config);
  if (config.security.contact && contact.source === 'configured' && !config.security.advisoryUrl) {
    config.security.advisoryUrl = config.security.contact;
  }
  if (!config.security.advisoryUrl) config.security.advisoryUrl = contact.url;
  return {
    config,
    file: target,
    source: raw ? 'release-config.json' : 'defaults',
    lastError,
    readiness: configReadiness(config)
  };
}
