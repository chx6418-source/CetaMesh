// CetaMesh Desktop —— Provider 配置体验（产品化任务 D · 第八节）。
//
// 为什么要有这一层：
//   1) 普通用户只需要回答三个问题：用哪个服务商、粘贴 API Key、用哪个模型。其余
//      （base URL、推理强度、超时……）是工程字段，默认值就能跑，不该出现在第一屏。
//      本模块把 describeFields() 的真实元数据切成 basic / advanced 两组，UI 按组渲染即可。
//   2) provider / API Key / model 不是硬编码文案：provider 与 model 从 models 分区元数据里按
//      真实 key（provider / model / defaultModel 或中文描述）定位；API Key 的元数据不在
//      settings schema 里（它按服务商存在 state/provider-keys.json，见 src/providers/secrets.js），
//      所以这里显式标注它的归属与来源，而不是从别处抄一份 label。
//   3) Provider 连通性测试失败也必须说人话：describeProviderTestFailure() 把
//      { provider, ok, status, message } 变成 { code, title, message, detail }，
//      message 恒为产品文案，原始串只进 detail。

/** basic 分组的稳定顺序：服务商 → API Key → 模型。UI 与测试都依赖这个顺序。 */
export const PROVIDER_BASIC_FIELD_KEYS = Object.freeze(['provider', 'apiKey', 'model']);

/** basic 分组里三个字段各自的元数据来源，供 UI 显示"这个值存在哪"。 */
export const PROVIDER_FIELD_SOURCES = Object.freeze({
  provider: Object.freeze({ kind: 'settings', path: 'models.provider' }),
  apiKey: Object.freeze({ kind: 'secret', path: 'state/provider-keys.json' }),
  model: Object.freeze({ kind: 'settings', path: 'models.defaultModel' })
});

// 字段身份识别：按 key 精确匹配，或按真实描述里的中文关键词匹配（describeFields 的 description）。
const PROVIDER_KEY_RE = /^(provider|provider_?id|provider_?name|vendor)$/;
const PROVIDER_TEXT_RE = /模型\s*provider|服务商|供应商/;
const MODEL_KEY_RE = /^(model|default_?model|model_?id|model_?name)$/;
const MODEL_TEXT_RE = /默认模型|模型名称|模型$/;
const ADVANCED_KEY_RE = /(base_?url|endpoint|reasoning|effort|timeout|retry|stream|temperature|proxy|api_?version|token_?limit|max_?tokens)/;
const ADVANCED_TEXT_RE = /推理|超时|重试|流式|地址|代理|温度/;
// 与 Provider 配置无关的字段（主题、语言、日志级别…）不得混进 advanced。
const UNRELATED_KEY_RE = /(^|\.)(theme|language|log_?level|verbosity|accent|palette|font)/;
const UNRELATED_SECTION_RE = /advanced|engineering|诊断|工程/;

/** 安全取字段元数据字符串；只接受真实非空字符串，避免把 undefined 渲染成 "undefined"。 */
function metaString(meta, ...keys) {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 把一个真实字段元数据行转成 UI 要的 { key, label, type, required, description }。 */
function toEntry(meta, { key, label, required, description }) {
  return {
    key,
    label,
    type: metaString(meta, 'type') || 'string',
    required: required === true,
    description: description || metaString(meta, 'description') || ''
  };
}

/** 归组：basic 三个字段 + 从真实元数据里挑出的工程字段。 */
function flattenFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const out = [];
  for (const section of list) {
    if (!section || typeof section !== 'object') continue;
    const sectionKey = metaString(section, 'section').toLowerCase();
    const sectionLabel = metaString(section, 'label');
    // advanced 分区整体是工程区（advanced.showEngineeringPages 等），不该出现在服务商配置里。
    if (UNRELATED_SECTION_RE.test(sectionKey) || UNRELATED_SECTION_RE.test(sectionLabel)) continue;
    for (const field of Array.isArray(section.fields) ? section.fields : []) {
      if (!field || typeof field !== 'object') continue;
      const key = metaString(field, 'key');
      if (!key) continue;
      out.push({ section: sectionKey, sectionLabel, field, key });
    }
  }
  return out;
}

/** 在真实元数据里定位 provider / model 字段（先精确 key，再中文描述）。 */
function findMeta(flat, { keyRe, textRe }) {
  return flat.find((item) => keyRe.test(item.key))
    ?? flat.find((item) => textRe.test(metaString(item.field, 'description')));
}

/** 是否属于 Provider 配置相关的工程字段（防止把主题/日志之类混进 advanced）。 */
function isRelated(row) {
  if (UNRELATED_KEY_RE.test(row.key)) return false;
  if (ADVANCED_KEY_RE.test(row.key)) return true;
  if (ADVANCED_TEXT_RE.test(metaString(row.field, 'description'))) return true;
  // 与 provider/model 同分区（models 分区）的其余字段，默认也是模型配置的一部分。
  return row.section === 'models';
}

/**
 * 依据 describeFields() 的真实元数据切分 Provider 配置：
 *   basic    = 服务商 / API Key / 模型（普通用户三件套，顺序固定）
 *   advanced = base URL、推理强度、超时等工程字段（同一张元数据表里挑出来，不是抄文案）
 * 返回不冻结：UI 可以在渲染前再过滤/排序。
 */
export function buildProviderView({ fields } = {}) {
  const flat = flattenFields(fields);

  const providerMeta = findMeta(flat, { keyRe: PROVIDER_KEY_RE, textRe: PROVIDER_TEXT_RE });
  const modelMeta = findMeta(flat, { keyRe: MODEL_KEY_RE, textRe: MODEL_TEXT_RE });

  const basic = [];

  // 服务商：label 优先取真实元数据描述，没有才用默认人话；来源写清楚存在哪。
  const providerRawLabel = metaString(providerMeta?.field, 'description');
  basic.push(toEntry(providerMeta?.field, {
    key: 'provider',
    label: providerRawLabel ? `${providerRawLabel}（服务商）` : '服务商',
    required: true,
    description: `必填。选择模型服务商；当前保存在设置 ${PROVIDER_FIELD_SOURCES.provider.path}。`
  }));

  // API Key：settings schema 里没有这项，它按服务商存于 state/provider-keys.json。
  basic.push({
    key: 'apiKey',
    label: 'API Key',
    type: 'secret',
    required: true,
    description: '必填。粘贴所选服务商的 API Key；它保存在系统凭据文件中（state/provider-keys.json），不回显明文。'
  });

  // 模型：真实 schema 里叫 models.defaultModel，产品语义就是"新会话默认模型"。
  const modelRawLabel = metaString(modelMeta?.field, 'description');
  basic.push(toEntry(modelMeta?.field, {
    key: 'model',
    label: modelRawLabel || '模型',
    required: true,
    description: modelRawLabel
      ? `必填。${modelRawLabel}；当前保存在设置 ${PROVIDER_FIELD_SOURCES.model.path}。`
      : `必填。选择新会话默认使用的模型；当前保存在设置 ${PROVIDER_FIELD_SOURCES.model.path}。`
  }));

  const advanced = flat
    .filter((row) => row !== providerMeta && row !== modelMeta)
    .filter((row) => !PROVIDER_KEY_RE.test(row.key) && !MODEL_KEY_RE.test(row.key))
    .filter(isRelated)
    .map((row) => toEntry(row.field, {
      key: row.key,
      label: metaString(row.field, 'description') || row.key,
      // 工程字段都有默认值：普通用户不填也能跑，所以 required 一律 false。
      required: false,
      description: `${row.sectionLabel || row.section || 'settings'}：可留默认值，仅高级用户调整。`
    }));

  return { basic, advanced };
}

/**
 * 普通用户要填什么、高级用户才碰什么。返回结构化字段（UI 自己排版）+ text（可直接展示）。
 * 文案里出现的 provider/model 名称来自 buildProviderView 的结果，避免与真实元数据脱节。
 */
export function providerFieldGuidance(view) {
  const resolved = view && Array.isArray(view.basic) ? view : buildProviderView({ fields: [] });
  const providerLabel = resolved.basic.find((item) => item.key === 'provider')?.label ?? '服务商';
  const modelLabel = resolved.basic.find((item) => item.key === 'model')?.label ?? '模型';
  const advancedKeys = Array.isArray(resolved.advanced) ? resolved.advanced.map((item) => item.key) : [];

  const basic = [
    { key: 'provider', label: providerLabel, required: true, hint: '选择模型服务商，例如 DeepSeek / OpenAI。' },
    { key: 'apiKey', label: 'API Key', required: true, hint: '从服务商控制台复制，粘贴后保存即可，本机不回显明文。' },
    { key: 'model', label: modelLabel, required: true, hint: '选择新会话默认使用的模型。' }
  ];
  const advanced = [
    { key: 'baseUrl', required: false, hint: '只有使用自建 / 代理网关时才需要改，默认地址通常可用。' },
    { key: 'reasoning', required: false, hint: '推理强度影响速度与费用，默认值适合大多数场景。' },
    { key: 'timeout', required: false, hint: '网络较慢时才需要调大。' }
  ];

  return Object.freeze({
    basic: Object.freeze(basic.map((item) => Object.freeze({ ...item }))),
    advanced: Object.freeze(advanced.map((item) => Object.freeze({ ...item }))),
    advancedFieldKeys: Object.freeze(advancedKeys),
    text: '普通用户只需要填三项：服务商、API Key、模型。'
      + 'Base URL、推理强度、超时等属于工程选项，默认值即可，只有自建网关或排查网络问题的高级用户才需要调整。'
  });
}

/** 测试失败的产品文案表。detail 另存原始技术串，message 永远是人话。 */
const TEST_FAILURE_COPY = Object.freeze({
  PROVIDER_TEST_AUTH_FAILED: Object.freeze({
    title: 'API Key 无效或无权限',
    message: '服务商拒绝了这次请求：API Key 无效或无权限，请重新复制并保存。'
  }),
  PROVIDER_TEST_NETWORK: Object.freeze({
    title: '网络不可用',
    message: '网络不可用或超时：请检查本机网络、代理设置，或稍后重试。'
  }),
  PROVIDER_TEST_HTTP_ERROR: Object.freeze({
    title: '服务商返回错误',
    message: '已经能连上服务商，但它返回了错误状态，请稍后重试或更换服务商。'
  }),
  PROVIDER_TEST_KEY_MISSING: Object.freeze({
    title: '尚未配置 API Key',
    message: '尚未配置 API Key：请先在 设置 → 模型 中填入并保存。'
  })
});

/** 归一化服务商 id：只用于回显，非法值不放大成异常。 */
function normalizeProviderName(provider) {
  const text = String(provider ?? '').trim().toLowerCase();
  return text || 'unknown';
}

/**
 * Provider 连通性测试结果 / 错误对象 → 可展示的失败文案。
 * 输入形态：
 *   - createProviderSecrets().test() 的结构化结果 { provider, ok, status, message }；
 *   - Error / IPC 对象 { code, message }；
 *   - 字符串 code 或字符串 message。
 * 返回 { ok:false, provider, code, title, message, detail }。
 */
export function describeProviderTestFailure(failure) {
  const ok = failure && typeof failure === 'object' && failure.ok === true;
  const provider = normalizeProviderName(failure && typeof failure === 'object' ? failure.provider : null);
  const rawCode = failure && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code.trim() : '';
  const rawMessage = typeof failure === 'string'
    ? failure.trim()
    : String(failure?.message ?? failure?.detail ?? '').trim();
  const status = Number(failure && typeof failure === 'object' ? failure.status : NaN);
  const detail = [rawCode, rawMessage].filter(Boolean).join(' ') || null;

  // 判定顺序有讲究：先看显式 code（IPC 透传的领域错误最可信），再看 HTTP 状态码，最后看文本。
  let code;
  if (status === 401 || status === 403) code = 'PROVIDER_TEST_AUTH_FAILED';
  else if (status === 0) code = 'PROVIDER_TEST_NETWORK';
  else if (rawCode === 'PROVIDER_SECRET_NOT_FOUND' || rawCode === 'PROVIDER_TEST_KEY_MISSING') code = 'PROVIDER_TEST_KEY_MISSING';
  else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError|TimeoutError|NETWORK|TIMEOUT|FETCH/i.test(`${rawCode} ${rawMessage}`)) code = 'PROVIDER_TEST_NETWORK';
  else if (Number.isFinite(status) && status >= 400) code = 'PROVIDER_TEST_HTTP_ERROR';
  else if (/尚未配置|not configured|no api key|missing key/i.test(`${rawCode} ${rawMessage}`)) code = 'PROVIDER_TEST_KEY_MISSING';
  else if (/认证失败|无效或无权限|unauthorized|invalid api key/i.test(rawMessage)) code = 'PROVIDER_TEST_AUTH_FAILED';
  else code = 'PROVIDER_TEST_HTTP_ERROR';

  const copy = TEST_FAILURE_COPY[code];
  // 成功结果不该走这个函数：显式 ok:true 时如实返回 ok，但文案仍是产品文案。
  if (ok) {
    return {
      ok: true,
      provider,
      code,
      title: '连接正常',
      message: 'API Key 可用，连接测试通过。',
      detail
    };
  }

  return {
    ok: false,
    provider,
    code,
    title: copy.title,
    message: copy.message,
    detail
  };
}
