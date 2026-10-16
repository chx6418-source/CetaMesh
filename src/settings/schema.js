// CetaMesh Desktop —— 产品设置模型（阶段 12）。
//
// 把此前散落在工程配置里的东西整理成**成熟产品设置**：10 个分区，每项都有类型、默认值、
// 以及（对安全相关的项）**锁定**语义。
//
// 与旧 config.json 的关系：config.json 是 WhaleBridge/QQ 时代的运行时配置；本模块是
// CetaMesh 自己的产品设置（state/settings.json），两者互不改写。
//
// 锁定项（locked）表达的是"这不是偏好，而是产品的安全姿态"：
// 用户可以看见它、知道它开着，但不能在 UI 上把它关掉。试图关闭 -> LOCKED_SETTING。

import { DEFAULT_GITHUB_FALLBACK_MANIFEST_URL, DEFAULT_GITCODE_MANIFEST_URL } from '../update/sources.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const SETTING_SECTIONS = Object.freeze([
  'general', 'models', 'agents', 'memory', 'workspace',
  'devices', 'extensions', 'security', 'updates', 'advanced'
]);

export const SECTION_LABELS = Object.freeze({
  general: 'General',
  models: 'Models',
  agents: 'Agents',
  memory: 'Memory',
  workspace: 'Workspace',
  devices: 'Devices',
  extensions: 'Extensions',
  security: 'Security',
  updates: 'Updates',
  advanced: 'Advanced'
});

const bool = (value, { locked = false, description = '' } = {}) => ({ type: 'boolean', default: value, locked, description });
const text = (value, { choices = null, description = '' } = {}) => ({ type: 'string', default: value, choices, locked: false, description });
const num = (value, { min = 0, max = Number.MAX_SAFE_INTEGER, description = '' } = {}) => ({ type: 'number', default: value, min, max, locked: false, description });

/**
 * 字段表。locked: true 的项不能在 UI 上关闭 —— 它们是安全默认，不是偏好。
 */
export const FIELDS = Object.freeze({
  general: Object.freeze({
    language: text('zh-CN', { choices: ['zh-CN', 'en-US'], description: '界面语言' }),
    theme: text('system', { choices: ['system', 'light', 'dark'], description: '主题' }),
    startMinimized: bool(false, { description: '启动时最小化到托盘' }),
    confirmOnExit: bool(true, { description: '退出前确认' })
  }),
  models: Object.freeze({
    provider: text('deepseek-official', { description: '模型 provider' }),
    defaultModel: text('deepseek-flash', { description: '新会话默认模型' }),
    reasoningEffort: text('max', { choices: ['off', 'low', 'high', 'max'], description: '推理强度' }),
    openaiCompatibleToolCalling: bool(false, { description: '允许 OpenAI 兼容 Provider 使用结构化工具调用（仅对该协议 Provider 生效）' }),
    openaiCompatibleReasoningEffort: bool(false, { description: '允许 OpenAI 兼容 Provider 发送推理强度参数（仅已知支持的推理模型生效）' }),
    streaming: bool(true, { description: '流式输出' })
  }),
  agents: Object.freeze({
    defaultAgentPreset: text('whale-chat-v2', { description: '默认 Agent Preset' }),
    defaultAgentProvider: text('auto', { choices: ['auto', 'dsh', 'codex', 'zcode'], description: '新建会话默认 Agent Provider' }),
    allowBackgroundTurns: bool(true, { description: '允许后台回合' }),
    codexOpenAiEnvironmentAuthorized: bool(false, { description: '明确授权 Codex CLI 使用本机 OPENAI_API_KEY 与 OPENAI_BASE_URL；只传递这两个变量，不导入其它凭据' })
  }),
  memory: Object.freeze({
    enabled: bool(true, { description: '启用统一 Memory' }),
    requireConfirmationForLongTerm: bool(true, {
      locked: true,
      description: '长期记忆必须经用户确认后写入（安全姿态，不可关闭）'
    }),
    defaultScope: text('global', { description: '新建记忆的默认 Scope' }),
    retrievalLimit: num(50, { min: 1, max: 200, description: '单次检索返回上限' })
  }),
  workspace: Object.freeze({
    defaultWorkspaceId: text('', { description: '默认工作区' }),
    boundaryEnforcement: text('strict', { choices: ['strict', 'warn'], description: '越界访问处理' })
  }),
  devices: Object.freeze({
    meshEnabled: bool(true, { description: '启用 Device Mesh' }),
    requireApprovalForRemoteCapabilities: bool(true, {
      locked: true,
      description: '远程能力请求必须本地批准（安全姿态，不可关闭）'
    }),
    presenceTtlMs: num(90000, { min: 10000, max: 600000, description: '在线判定 TTL（毫秒）' })
  }),
  extensions: Object.freeze({
    allowLocalImport: bool(true, { description: '允许本地导入扩展' }),
    developerMode: bool(false, { description: '允许加载未经目录验证的本地插件；本地插件仍须通过 Extension Runtime 审查并默认禁用' }),
    requireReviewApproval: bool(true, {
      locked: true,
      description: '高风险权限必须显式批准（安全姿态，不可关闭）'
    }),
    maxInstalled: num(50, { min: 0, max: 500, description: '已安装扩展上限' })
  }),
  security: Object.freeze({
    redactLogs: bool(true, {
      locked: true,
      description: '日志脱敏（API key / Token / 配对密钥 / 私钥 / 凭据 / 完整敏感 prompt，安全姿态，不可关闭）'
    }),
    auditRetention: num(500, { min: 0, max: 10000, description: '审计保留条数' }),
    allowedUpdateHosts: text('github.com,objects.githubusercontent.com,gitcode.com,raw.gitcode.com', { description: '允许的更新下载主机（逗号分隔）' })
  }),
  updates: Object.freeze({
    channel: text('stable', { choices: ['stable', 'rc', 'beta'], description: '更新通道' }),
    autoCheck: bool(false, { description: '启动时自动检查更新（默认关闭）' }),
    manifestUrl: text(DEFAULT_GITCODE_MANIFEST_URL, { description: '主更新源清单 HTTPS 地址（默认：GitCode 中国区优先源）' }),
    fallbackManifestUrl: text(DEFAULT_GITHUB_FALLBACK_MANIFEST_URL, { description: '备用更新源清单 HTTPS 地址（默认：GitHub；仅主源失败时访问）' }),
    pinnedPublicKey: text('', { description: '签名验证公钥（Ed25519, SPKI PEM）' })
  }),
  advanced: Object.freeze({
    showEngineeringPages: bool(false, { description: '显示工程/诊断页面' }),
    logLevel: text('info', { choices: ['error', 'warn', 'info', 'debug'], description: '日志级别' }),
    diagnosticsVerbosity: text('normal', { choices: ['normal', 'verbose'], description: '诊断详细程度' })
  })
});

export function settingsError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function isKnownSection(section) {
  return SETTING_SECTIONS.includes(section);
}

/** 默认值（含锁定项的默认）。 */
export function defaultSettings() {
  const out = {};
  for (const section of SETTING_SECTIONS) {
    out[section] = {};
    for (const [key, spec] of Object.entries(FIELDS[section])) out[section][key] = spec.default;
  }
  return out;
}

/** 字段元数据（UI 用来渲染表单与标注"锁定"）。 */
export function describeFields() {
  return SETTING_SECTIONS.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    fields: Object.entries(FIELDS[section]).map(([key, spec]) => ({
      key,
      type: spec.type,
      default: spec.default,
      locked: spec.locked === true,
      choices: spec.choices || null,
      min: spec.min === undefined ? null : spec.min,
      max: spec.max === undefined ? null : spec.max,
      description: spec.description || ''
    }))
  }));
}

/** 单字段校验；不通过抛 SETTINGS_INVALID。 */
export function coerceField(section, key, value) {
  const spec = FIELDS[section] ? FIELDS[section][key] : null;
  if (!spec) throw settingsError('UNKNOWN_SETTING', '未知设置项：' + section + '.' + key);
  if (spec.locked === true && value !== spec.default) {
    throw settingsError('LOCKED_SETTING',
      section + '.' + key + ' 是安全姿态项，不能修改（' + (spec.description || '') + '）');
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 必须是布尔值');
    return value;
  }
  if (spec.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 必须是数字');
    if (n < spec.min || n > spec.max) {
      throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 必须在 ' + spec.min + '..' + spec.max + ' 之间');
    }
    return n;
  }
  const str = String(value === null || value === undefined ? '' : value);
  if (spec.choices && !spec.choices.includes(str)) {
    throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 只能是：' + spec.choices.join(' / '));
  }
  if (str.length > 2000) throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 过长');
  return str;
}

/** 把任意（可能损坏 / 缺字段 / 多字段）输入归一化为完整设置；未知键被丢弃而不是写入。 */
export function normalizeSettings(raw, { strict = false } = {}) {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw settingsError('SETTINGS_INVALID', '设置根节点必须是对象');
    return out;
  }
  if (strict && Object.keys(raw).some(section => !SETTING_SECTIONS.includes(section))) {
    throw settingsError('SETTINGS_INVALID', '设置含未知分区');
  }
  for (const section of SETTING_SECTIONS) {
    const input = raw[section];
    if (input === undefined) continue;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      if (strict) throw settingsError('SETTINGS_INVALID', section + ' 分区结构无效');
      continue;
    }
    if (strict && Object.keys(input).some(key => !Object.hasOwn(FIELDS[section], key))) {
      throw settingsError('SETTINGS_INVALID', section + ' 含未知设置项');
    }
    for (const key of Object.keys(FIELDS[section])) {
      if (!Object.hasOwn(input, key)) continue;
      try {
        if (strict && typeof input[key] !== FIELDS[section][key].type) throw settingsError('SETTINGS_INVALID', section + '.' + key + ' 类型无效');
        out[section][key] = coerceField(section, key, input[key]);
      } catch (error) {
        if (strict) throw error;
        // 损坏或非法的单项回退到默认值，其余设置仍然可用（不因为一项坏掉就整份失效）。
        out[section][key] = FIELDS[section][key].default;
      }
    }
  }
  return out;
}

/** 分区补丁校验：返回归一化后的补丁，任一字段非法就整体拒绝（不做部分写入）。 */
export function validateSectionPatch(section, patch) {
  if (!isKnownSection(section)) throw settingsError('UNKNOWN_SECTION', '未知设置分区：' + String(section));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw settingsError('SETTINGS_INVALID', '分区补丁必须是对象');
  }
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = coerceField(section, key, value);
  }
  if (Object.keys(out).length === 0) throw settingsError('SETTINGS_INVALID', '补丁不能为空');
  return out;
}
