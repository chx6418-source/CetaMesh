// CetaMesh Desktop —— 反馈入口链接（修正版：只提供入口，不在软件内收集反馈）。
//
// 产品决策（WHY）：CetaMesh Desktop **不实现**反馈服务、本地 Outbox、软件内反馈表单 / Bug 提交 /
// 漏洞上传，也不自动上传日志。软件只提供四个入口，点击后用系统默认浏览器打开**官方网站**的对应页面：
//   反馈与建议 → /feedback         Bug 反馈 → /feedback?type=bug
//   功能建议   → /feedback?type=feature            安全漏洞 → /security
// 站点根与页面路径来自发行配置 `release-config.json`（`feedback.baseUrl` / `feedback.paths`，
// `baseUrl` 缺省时回落 `website`）—— 域名只有一个来源，不散落在各个页面里。
//
// 链接允许携带的 query **只有三个非敏感字段**：version / build / platform。
// 这是白名单而不是黑名单：builder 只接受这三个参数，其它键根本没有进入 URL 的路径。
// 明确禁止（既不允许出现，也没有入口）：API Key、Token、聊天内容、Memory、用户文件路径、
// 插件配置、Device secret、日志正文。

/** 入口 id（顺序即 UI 展示顺序）。 */
export const FEEDBACK_ENTRY_IDS = Object.freeze(['general', 'bug', 'feature', 'security']);

/** 允许出现在反馈链接里的 query 键（白名单，写死在代码里，配置无法扩大它）。 */
export const FEEDBACK_ALLOWED_QUERY_KEYS = Object.freeze(['version', 'build', 'platform']);

/** 安全漏洞入口必须单独显示这句话。 */
export const SECURITY_NOTICE =
  '安全问题请通过官方安全反馈页面提交，不要在公开 Issue 中披露敏感漏洞。';

/** 浏览器打开失败时的提示（原文由产品给定，不要在别处改写）。 */
export const BROWSER_OPEN_FAILURE_MESSAGE = '无法打开浏览器，请稍后访问 CetaMesh 官方网站。';

/** 官方站点尚未配置时的提示：如实说明，不猜域名，也不影响软件其它功能。 */
export const FEEDBACK_NOT_CONFIGURED_MESSAGE = '官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。';

const ENTRY_LABELS = Object.freeze({
  general: { label: '反馈与建议', description: '对 CetaMesh 的整体意见与建议。' },
  bug: { label: 'Bug 反馈', description: '功能异常、崩溃、表现与预期不符。' },
  feature: { label: '功能建议', description: '希望新增或改进的能力。' },
  security: { label: '安全漏洞', description: '安全问题请走官方安全通道，不要公开披露。' }
});

const MAX_VALUE = Object.freeze({ version: 40, build: 64, platform: 20 });

/** 平台标记：只映射成官网能理解的稳定取值，不发原始 os.release() 之类的细节。 */
export function platformTag(platform) {
  const value = String(platform ?? '').trim().toLowerCase();
  if (value === 'win32' || value === 'windows') return 'windows';
  if (value === 'darwin' || value === 'macos') return 'macos';
  if (value === 'linux') return 'linux';
  return value ? value.slice(0, MAX_VALUE.platform).replace(/[^a-z0-9._-]/g, '') : '';
}

/**
 * 单个 query 值的安全化：白名单字符集 + 长度上限。
 * `&`、`=`、`?`、`#`、空格、控制字符、引号一律剔除 —— 即使上游数据被污染，
 * 也不可能靠字符串拼接伪造出额外的 query 参数。
 */
export function sanitizeQueryValue(value, max = 64) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.slice(0, max).replace(/[^A-Za-z0-9._+-]/g, '');
}

/**
 * 值层**形状**白名单：形状不合法就整体**丢弃**该参数（fail-closed），而不是"剔除字符后照带"。
 * 这一层是为了让污染值没有残留空间：例如 version 里混进 `&token=...`，剔除字符后会留下
 * `token...` 片段；而版本号本身就没有这些形状，直接不带才是正确行为。
 */
const VALUE_SHAPES = Object.freeze({
  version: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/,
  build: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/,
  platform: /^[A-Za-z0-9._-]{1,20}$/
});

/** 形状校验 + 字符白名单；不合法返回空串（宁可不带，也不带可疑内容）。 */
export function safeQueryValue(key, value, max = 64) {
  const raw = String(value ?? '').trim().slice(0, max);
  if (!raw) return '';
  const shape = VALUE_SHAPES[key];
  if (shape && !shape.test(raw)) return '';
  return sanitizeQueryValue(raw, max);
}

/** 只有这三个参数会被拼进链接。 */
function feedbackQuery(aboutInfo) {
  return {
    version: safeQueryValue('version', aboutInfo?.version, MAX_VALUE.version),
    build: safeQueryValue('build', aboutInfo?.build?.buildId, MAX_VALUE.build),
    platform: safeQueryValue(
      'platform',
      platformTag(aboutInfo?.platform?.os ?? aboutInfo?.runtime?.platform),
      MAX_VALUE.platform
    )
  };
}

/** 站点根 + 页面路径 + 白名单 query → 绝对 https URL。baseUrl 已由发行配置层校验过 https。 */
export function buildEntryUrl(baseUrl, sitePath, query = {}) {
  const base = String(baseUrl ?? '').trim();
  if (!base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null; // 配置层已过滤过非法 URL；这里再兜一次，绝不拼接半个 URL。
  }
  if (url.protocol !== 'https:') return null;
  const [pathPart, queryPart = ''] = String(sitePath ?? '').split('?');
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath + (pathPart.startsWith('/') ? pathPart : `/${pathPart}`);
  url.search = queryPart; // 页面自身的参数（例如 type=bug）先放进去
  for (const key of FEEDBACK_ALLOWED_QUERY_KEYS) {
    const value = query[key];
    if (value) url.searchParams.set(key, value);
  }
  url.hash = '';
  return url.toString();
}

/**
 * 组装四个反馈入口。`configured` 为 false 时 entries 里的 url 全是 null，
 * UI 如实提示「官方反馈页面尚未配置」，而不是打开一个猜测出来的地址。
 */
export function buildFeedbackLinks({ config = null, aboutInfo = null, baseUrl = undefined } = {}) {
  const resolvedBase = baseUrl === undefined
    ? (config?.feedback?.baseUrl || config?.website || null)
    : baseUrl;
  const base = typeof resolvedBase === 'string' && resolvedBase.trim() ? resolvedBase.trim() : null;
  const paths = config?.feedback?.paths ?? {};
  const query = feedbackQuery(aboutInfo);

  const entries = FEEDBACK_ENTRY_IDS.map((id) => {
    const meta = ENTRY_LABELS[id];
    const sitePath = typeof paths[id] === 'string' && paths[id] ? paths[id] : null;
    return {
      id,
      label: meta.label,
      description: meta.description,
      kind: id === 'security' ? 'security' : 'feedback',
      sitePath,
      url: base && sitePath ? buildEntryUrl(base, sitePath, query) : null
    };
  });

  return {
    configured: Boolean(base && entries.every((entry) => entry.sitePath)),
    baseUrl: base,
    query,
    allowedQueryKeys: [...FEEDBACK_ALLOWED_QUERY_KEYS],
    entries,
    securityNotice: SECURITY_NOTICE,
    messages: {
      openFailure: BROWSER_OPEN_FAILURE_MESSAGE,
      notConfigured: FEEDBACK_NOT_CONFIGURED_MESSAGE
    }
  };
}

/** 单个入口查询（UI 点击时用；未知 id 返回 null，不抛错）。 */
export function entryById(links, id) {
  const wanted = String(id ?? '').trim();
  return (links?.entries ?? []).find((entry) => entry.id === wanted) ?? null;
}
