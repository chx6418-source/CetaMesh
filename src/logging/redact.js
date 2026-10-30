// CetaMesh Desktop —— 日志脱敏（阶段 12）。
//
// 默认禁止输出（按阶段要求）：
//   API key / Token / Pairing secret / Private key / 完整敏感 prompt / Credential
//
// 做法分两层：
//   1) 文本层：正则命中即替换，保留"哪一类被抹掉了"的标记，便于排查而不泄漏原值；
//   2) 字段层：按 key 名判定（prompt / messages / token / privateKey …），
//      这类字段**整体替换为摘要**（只报长度），因为"完整敏感 prompt"无法靠正则识别。
//
// 注意：脱敏是**默认开启且不可关闭**的安全姿态（见 settings 的 security.redactLogs 锁定项）。

export const REDACTION_MARK = '[REDACTED';

/** 文本层规则：只替换"值"，保留键名，方便定位问题。 */
export const TEXT_RULES = Object.freeze([
  {
    id: 'privateKey',
    // PEM 私钥整块抹掉（多行）。
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => REDACTION_MARK + ':privateKey]'
  },
  {
    // 必须排在通用 token 规则之前：否则 "Authorization: Bearer <jwt>" 会先被通用规则
    // 匹配成 "Authorization: Bearer"，把 Bearer 这个词抹掉、真正的 JWT 却留在日志里。
    id: 'bearerToken',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{6,})/gi,
    replace: () => 'Bearer ' + REDACTION_MARK + ':token]'
  },
  {
    id: 'pairingSecret',
    re: /((?:pairing[-_]?secret|pairing[-_]?code|invite[-_]?code)\s*[:=]\s*)(["']?)([A-Za-z0-9._-]{6,})/gi,
    replace: (_m, prefix, quote) => prefix + quote + REDACTION_MARK + ':pairingSecret]'
  },
  {
    id: 'apiKey',
    re: /((?:api[-_]?key|apikey)\s*[:=]\s*)(["']?)([A-Za-z0-9._-]{6,})/gi,
    replace: (_m, prefix, quote) => prefix + quote + REDACTION_MARK + ':apiKey]'
  },
  {
    id: 'token',
    re: /((?:access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization)\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
    replace: (_m, prefix, quote) => prefix + quote + REDACTION_MARK + ':token]'
  },
  {
    id: 'credential',
    re: /((?:password|passwd|secret|credential|access[-_]?key)\s*[:=]\s*)(["']?)([^\s"',;]{4,})/gi,
    replace: (_m, prefix, quote) => prefix + quote + REDACTION_MARK + ':credential]'
  },
  {
    id: 'cookie',
    re: /((?:cookie|set-cookie)\s*[:=]\s*)([^\s"';]{8,})/gi,
    replace: (_m, prefix) => prefix + REDACTION_MARK + ':cookie]'
  }
]);

/** 字段层：这些 key 的**值**整体替换为摘要（不保留内容，只报长度与类型）。 */
export const SENSITIVE_KEYS = Object.freeze([
  'prompt', 'systemprompt', 'system_prompt', 'messages', 'conversation', 'history',
  'apikey', 'api_key', 'token', 'accesstoken', 'access_token', 'httpaccesstoken', 'http_access_token', 'refreshtoken',
  'secret', 'pairingsecret', 'pairing_secret', 'invitecode', 'invite_code',
  'privatekey', 'private_key', 'password', 'passwd', 'credential', 'authorization', 'cookie'
]);

export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(String(key).toLowerCase());
}

function summarize(value) {
  if (typeof value === 'string') return REDACTION_MARK + ':sensitive len=' + value.length + ']';
  if (Array.isArray(value)) return [REDACTION_MARK + ':sensitive items=' + value.length + ']'];
  if (value && typeof value === 'object') return REDACTION_MARK + ':sensitive keys=' + Object.keys(value).length + ']';
  return REDACTION_MARK + ':sensitive]';
}

/**
 * 文本脱敏。
 *
 * 关键实现细节：**单遍处理**。如果直接逐条规则 replace，后一条规则会命中前一条的输出——
 * 例如 credential 规则会把已替换出来的 pairingSecret= 里的 Secret 再匹配一次，
 * 结果是"值仍然被抹掉、但类别标错"。所以这里先把每条规则的产物换成不含任何
 * 字母数字的占位符，全部规则跑完后再还原，保证规则之间互不干扰。
 */
export function redactText(input) {
  let text = String(input === null || input === undefined ? '' : input);
  const tokens = [];
  for (const rule of TEXT_RULES) {
    text = text.replace(rule.re, (...args) => {
      const replacement = typeof rule.replace === 'function' ? rule.replace(...args) : rule.replace;
      tokens.push(replacement);
      return '\u0000' + (tokens.length - 1) + '\u0000';
    });
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

/** 结构化脱敏：按 key 判定 + 递归对字符串做文本脱敏。 */
export function redactObject(value, { depth = 0, maxDepth = 6 } = {}) {
  if (depth > maxDepth) return REDACTION_MARK + ':depth]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, { depth: depth + 1, maxDepth }));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? summarize(item) : redactObject(item, { depth: depth + 1, maxDepth });
    }
    return out;
  }
  return value;
}

/** 一行日志 = 一条结构化记录；序列化前必须脱敏。 */
export function redactLogLine(entry) {
  if (typeof entry === 'string') return redactText(entry);
  return JSON.stringify(redactObject(entry));
}

/**
 * 脱敏 sink 包装：所有下游输出都必须经过它。
 * enabled=false 会被拒绝 —— 这是安全姿态，不是偏好。
 */
export function createRedactingSink(sink, { enabled = true } = {}) {
  if (enabled !== true) {
    throw Object.assign(new Error('日志脱敏不能被关闭'), { code: 'REDACTION_REQUIRED' });
  }
  if (typeof sink !== 'function') throw new Error('createRedactingSink 需要一个 sink 函数');
  return (entry) => {
    const safe = typeof entry === 'string' ? redactText(entry) : redactObject(entry);
    return sink(safe);
  };
}
