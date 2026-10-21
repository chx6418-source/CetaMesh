// CetaMesh Desktop —— 官方发行配置（产品化任务 D）。
//
// 为什么要有这个文件：About 页要显示的「开发者 / 官方网站 / GitCode / GitHub / 许可证 /
// 隐私说明 / 安全说明」，以及**反馈入口的官方站点与页面路径**，都是**发行方的事实**，
// 不是代码里可以随手写死的字符串。写死在源码里意味着：改一个链接要重新发版，而且无法区分
// 「尚未配置」和「配置成空」。所以统一放 `release-config.json`（随安装包分发的静态配置），
// 运行时读取 + 归一化。
//
// 红线：
//   1) 没有配置就如实报 null（UI 显示「未配置」并提示稍后再试），**绝不编造**一个看起来像真的官网；
//   2) 所有对外 URL 必须是 https；页面路径必须是站点内的绝对路径（拒绝 `//host` 协议相对写法）；
//   3) 配置损坏不影响软件启动：回落默认值 + 如实带上 lastError，由 UI 提示，而不是崩溃或静默。

import path from 'node:path';
import { readJsonFile } from '../storage/json-file.js';

export const RELEASE_CONFIG_VERSION = 1;
export const RELEASE_CONFIG_FILENAME = 'release-config.json';

const MAX_TEXT = 300;
const MAX_URL = 600;
const MAX_PATH = 200;

/**
 * 未在官方配置中确认的页面路径一律为 null；现有 release-config.json 中的既有路径继续生效。
 */
export const DEFAULT_FEEDBACK_PATHS = Object.freeze({
  general: null,
  bug: null,
  feature: null,
  security: null,
  docs: null,
  privacy: null,
  terms: null,
  pluginDocs: null
});

/** 未提供配置时的事实默认值：产品身份来自仓库既有事实，链接留空表示「未配置」。 */
export const DEFAULT_RELEASE_CONFIG = Object.freeze({
  schemaVersion: RELEASE_CONFIG_VERSION,
  product: 'CetaMesh',
  edition: 'Desktop',
  developer: null,
  website: null,
  productLinks: Object.freeze({
    officialUrls: Object.freeze({ website: null, websiteRepository: null, gitcode: null, github: null, license: null }),
    paths: DEFAULT_FEEDBACK_PATHS
  }),
  repositories: Object.freeze({
    gitcode: null,
    github: null,
    primary: null
  }),
  license: Object.freeze({
    name: 'GPL-3.0-only',
    file: 'LICENSE',
    url: null
  }),
  privacy: Object.freeze({ doc: 'docs/product/PRIVACY.md', summary: '' }),
  security: Object.freeze({ doc: 'docs/product/SECURITY.md', contact: null, advisoryUrl: null }),
  feedback: Object.freeze({ baseUrl: null, paths: DEFAULT_FEEDBACK_PATHS }),
  pluginService: Object.freeze({ catalogUrl: null, allowedHosts: Object.freeze([]) })
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
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null; // 非法 URL 视为未配置：About 要能照常显示，配置问题由 lastError 上报。
  }
}

/**
 * 站点内绝对路径校验。拒绝：
 *   - 不以 `/` 开头（可能是绝对 URL，会把用户带去别的站点）；
 *   - `//host/...`（协议相对，等于换域名）；
 *   - query / fragment、反斜杠 / 空白 / 控制字符（避免站点路径扩大链接参数或跳转）。
 */
function sitePath(value, fallbackPath) {
  const text = textOrNull(value, MAX_PATH);
  if (!text) return fallbackPath;
  if (!text.startsWith('/') || text.startsWith('//')) return fallbackPath;
  if (/[?#\\\s\u0000-\u001f]/.test(text)) return fallbackPath;
  return text;
}

function feedbackPaths(rawPaths, fallbackPaths) {
  const source = rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths) ? rawPaths : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_FEEDBACK_PATHS)) {
    out[key] = sitePath(source[key], fallbackPaths[key] ?? null);
  }
  return out;
}

/** 安全联系入口只接受明确配置的地址，不从仓库地址猜测页面路径。 */
export function resolveSecurityContact(config) {
  const explicit = httpsOrNull(config?.security?.contact);
  if (explicit) return { url: explicit, source: 'configured' };
  return { url: null, source: 'unconfigured' };
}

/**
 * 反馈/安全入口的站点根：显式 legacy `feedback.baseUrl` 优先，其次集中配置的 `website`。
 * 两者都没配置就返回 null —— UI 如实提示「官方页面尚未配置，请稍后访问」，绝不猜域名。
 */
export function resolveFeedbackBaseUrl(config) {
  return httpsOrNull(config?.feedback?.baseUrl) || httpsOrNull(config?.website) || null;
}

function normalize(raw, fallback) {
  const repo = raw && typeof raw.repositories === 'object' && raw.repositories ? raw.repositories : {};
  const productLinks = raw && typeof raw.productLinks === 'object' && raw.productLinks ? raw.productLinks : {};
  const officialUrls = productLinks.officialUrls && typeof productLinks.officialUrls === 'object' ? productLinks.officialUrls : {};
  const configuredPaths = productLinks.paths && typeof productLinks.paths === 'object' ? productLinks.paths : null;
  const license = raw && typeof raw.license === 'object' && raw.license ? raw.license : {};
  const privacy = raw && typeof raw.privacy === 'object' && raw.privacy ? raw.privacy : {};
  const security = raw && typeof raw.security === 'object' && raw.security ? raw.security : {};
  const feedback = raw && typeof raw.feedback === 'object' && raw.feedback ? raw.feedback : {};
  const pluginService = raw && typeof raw.pluginService === 'object' && raw.pluginService ? raw.pluginService : {};
  const catalogUrl = httpsOrNull(pluginService.catalogUrl);
  const configuredHosts = Array.isArray(pluginService.allowedHosts)
    ? pluginService.allowedHosts.map(value => String(value).trim().toLowerCase())
      .filter(value => /^[a-z0-9.-]{1,253}$/.test(value)).slice(0, 20)
    : [];
  const catalogHost = catalogUrl ? new URL(catalogUrl).hostname.toLowerCase() : null;
  const pluginHosts = [...new Set([...configuredHosts, ...(catalogHost ? [catalogHost] : [])])];

  const website = httpsOrNull(officialUrls.website) || httpsOrNull(raw?.website) || fallback.productLinks.officialUrls.website;
  const websiteRepository = httpsOrNull(officialUrls.websiteRepository) || fallback.productLinks.officialUrls.websiteRepository;
  const gitcode = httpsOrNull(officialUrls.gitcode) || httpsOrNull(repo.gitcode) || fallback.productLinks.officialUrls.gitcode;
  const github = httpsOrNull(officialUrls.github) || httpsOrNull(repo.github) || fallback.productLinks.officialUrls.github;
  const primary = httpsOrNull(repo.primary) || github || gitcode || fallback.repositories.primary;
  const paths = feedbackPaths(configuredPaths ?? feedback.paths, fallback.productLinks.paths);
  const licenseUrl = httpsOrNull(officialUrls.license) || httpsOrNull(license.url) || fallback.productLinks.officialUrls.license || fallback.license.url || null;
  const feedbackBaseUrl = httpsOrNull(feedback.baseUrl) || website;

  return {
    schemaVersion: RELEASE_CONFIG_VERSION,
    product: textOrNull(raw?.product, 40) || fallback.product,
    edition: textOrNull(raw?.edition, 40) || fallback.edition,
    developer: textOrNull(raw?.developer, 120),
    website,
    productLinks: {
      officialUrls: { website, websiteRepository, gitcode, github, license: licenseUrl },
      paths
    },
    repositories: { gitcode, github, primary },
    license: {
      name: textOrNull(license.name, 60) || fallback.license.name,
      file: textOrNull(license.file, 200) || fallback.license.file,
      url: licenseUrl
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
      baseUrl: feedbackBaseUrl,
      paths
    },
    pluginService: { catalogUrl, allowedHosts: pluginHosts }
  };
}

/** 配置完整度（UI 用它决定显示「未配置」还是真实值，测试用它断言不编造）。 */
export function configReadiness(config) {
  const contact = resolveSecurityContact(config);
  return {
    developerConfigured: Boolean(config?.developer),
    websiteConfigured: Boolean(config?.website),
    feedbackBaseConfigured: Boolean(resolveFeedbackBaseUrl(config)),
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
