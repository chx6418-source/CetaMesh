// CetaMesh Desktop —— 产品空状态 / 友好错误文案（产品化任务 D · 第八、九节）。
//
// 为什么要有这一层：
//   1) 用户永远不该只看到技术错误。技术 code（MODEL_NO_MODEL、EXTENSION_DISABLED…）是给
//      工程师和日志看的；产品界面必须先给一句人话，再说"下一步做什么"。因此本模块把
//      "技术 code → 友好空状态"的映射集中在一张冻结表里（TECHNICAL_CODE_TO_STATE），
//      UI 只渲染 title / message / action，detail 只在"查看技术细节"里出现。
//   2) detail 与 message 在**结构上分离**：emptyStateForError 把所有技术文本都收进 detail，
//      message 恒等于产品文案。这样任何一层都不可能"不小心"把原始异常抛给用户。
//   3) 未知 code / 未知 key 不抛错：产品界面最怕的是"错误处理本身崩了"，所以两者都回落到
//      generic 空状态（fail-soft），而不是 undefined 或异常。
//
// 本模块是纯数据 + 纯函数：不读文件、不发网络、不依赖别的 domain，方便 UI 与测试直接引用。

/** 兜底条目的 id：未知 key / 未知 code 都落到这里。 */
export const GENERIC_EMPTY_STATE_KEY = 'generic.error';

/**
 * 产品文案表。约定每个条目恰好是 { key, title, message, action, technical }：
 *   - title   一句话说"发生了什么"（用户视角，不含技术术语）；
 *   - message 一句话说"为什么 / 现在是什么状态"；
 *   - action  一句话说"下一步点哪里"（可执行，不是安慰）；
 *   - technical 恒为 false —— 这张表里的文案都是产品文案，技术串只走 detail。
 */
export const EMPTY_STATES = Object.freeze({
  'chat.no-model': Object.freeze({
    key: 'chat.no-model',
    title: '先添加一个模型',
    message: '还没有配置任何对话模型，聊天暂时无法开始。',
    action: '打开 设置 → 模型，选择服务商并填入 API Key。',
    technical: false
  }),
  'chat.no-provider-key': Object.freeze({
    key: 'chat.no-provider-key',
    title: '还没有填写 API Key',
    message: '已选择模型服务商，但还没有保存 API Key，模型无法连接。',
    action: '打开 设置 → 模型，填入该服务商的 API Key 并保存。',
    technical: false
  }),
  'chat.no-model-selected': Object.freeze({
    key: 'chat.no-model-selected',
    title: '还没有选择模型',
    message: '服务商已就绪，但这个会话还没有指定用哪个模型。',
    action: '在会话顶部的模型选择里挑一个默认模型。',
    technical: false
  }),
  'agent.not-installed': Object.freeze({
    key: 'agent.not-installed',
    title: 'Codex 未安装',
    message: '这台电脑上还没有可用的 Agent 运行时，Agent 任务无法启动。',
    action: '按安装向导完成 Agent 运行时安装后重试。',
    technical: false
  }),
  'agent.not-configured': Object.freeze({
    key: 'agent.not-configured',
    title: '还没有配置 Agent',
    message: 'Agent 运行时可用，但当前没有选定的默认 Agent。',
    action: '打开 设置 → Agent，选择一个默认 Agent。',
    technical: false
  }),
  'plugin.disabled': Object.freeze({
    key: 'plugin.disabled',
    title: '插件已关闭',
    message: '这个扩展当前处于关闭状态，它的能力不会被执行。',
    action: '打开 插件 页面，确认权限后重新启用。',
    technical: false
  }),
  'capability.tool-denied': Object.freeze({
    key: 'capability.tool-denied',
    title: '需要审批',
    message: '这次操作超出了当前授权范围，已被安全策略拦下。',
    action: '在审批弹窗里确认本次操作，或调整该能力的授权范围。',
    technical: false
  }),
  'capability.approval-pending': Object.freeze({
    key: 'capability.approval-pending',
    title: '等待你批准',
    message: '请求已提交，正在等待你确认，批准之前不会执行。',
    action: '打开 审批 / 安全 页面，确认或拒绝这次请求。',
    technical: false
  }),
  'memory.empty': Object.freeze({
    key: 'memory.empty',
    title: '还没有记忆',
    message: '这里还没有任何长期记忆条目。',
    action: '在设置中开启记忆，或把一段对话标记为需要记住。',
    technical: false
  }),
  'task.empty': Object.freeze({
    key: 'task.empty',
    title: '还没有任务',
    message: '当前没有任何进行中或已完成的任务。',
    action: '新建一个任务，或把一段对话转成任务。',
    technical: false
  }),
  'workspace.empty': Object.freeze({
    key: 'workspace.empty',
    title: '还没有工作区',
    message: '还没有添加任何工作区目录，文件相关能力无从下手。',
    action: '打开 工作区 页面，添加一个本地目录。',
    technical: false
  }),
  'update.up-to-date': Object.freeze({
    key: 'update.up-to-date',
    title: '已是最新版本',
    message: '当前版本不需要更新。',
    action: '无需操作；有新版本时会在这里提示。',
    technical: false
  }),
  [GENERIC_EMPTY_STATE_KEY]: Object.freeze({
    key: GENERIC_EMPTY_STATE_KEY,
    title: '暂时无法完成',
    message: '这一步没有成功，具体原因见技术细节。',
    action: '按提示重试；仍然失败时展开技术细节并反馈给支持。',
    technical: false
  })
});

/**
 * 技术 code → 空状态 id。冻结，UI 与测试都读这张表，避免映射散落在各处。
 *
 * 这些 code 都是在 src/** 里真实存在的（见文件头注释与交付说明）：
 *   - MODEL_PROVIDER_KEY_MISSING / MODEL_NO_MODEL / MODEL_PROVIDER_UNKNOWN：
 *     src/model/types.js 的 MODEL_ERROR_CODES（src/model/service.js、providers/openai-compatible.js 抛出）；
 *   - PROVIDER_SECRET_NOT_FOUND：src/providers/secrets.js（未配置 API Key）；
 *   - AGENT_PROVIDER_UNKNOWN：src/agent/agent-provider.js 的 AGENT_ERROR_CODES；
 *   - PROVIDER_UNAVAILABLE：agent-provider.js / capability（运行时未就绪，按"未安装"处理）；
 *   - EXTENSION_DISABLED / EXTENSION_CRASH_LOOP_DISABLED：src/extension/runtime.js；
 *   - NOT_INSTALLED：src/extension/{installer,runtime}.js（未安装的扩展）；
 *   - CAPABILITY_DENIED：src/agent/managed-agent-provider.js（未授权时回落到该 code）；
 *   - PERMISSION_DENIED / *_SCOPE_DENIED / SENSITIVE_RESOURCE_DENIED 等：src/capability/policy.js、service.js；
 *   - APPROVAL_REQUIRED：src/extension/installer.js、src/mesh/protocol.js、src/mesh/node.js；
 *   - APPROVAL_PENDING / WORKSHOP_APPROVAL_PENDING：审批仍在等待；
 *   - APPROVAL_EXPIRED：src/capability/approval.js。
 * 仓库里没有 TOOL_DENIED / PLUGIN_DISABLED / EXTENSION_NOT_FOUND 字面量，但产品契约要求兼容，
 * 因此保留为别名（指向同一空状态），将来任一 code 出现都无需改 UI。
 */
export const TECHNICAL_CODE_TO_STATE = Object.freeze({
  MODEL_PROVIDER_KEY_MISSING: 'chat.no-provider-key',
  MODEL_PROVIDER_UNKNOWN: 'chat.no-model',
  MODEL_PROVIDER_UNAVAILABLE: 'chat.no-model',
  MODEL_NO_MODEL: 'chat.no-model',
  PROVIDER_SECRET_NOT_FOUND: 'chat.no-provider-key',

  AGENT_NOT_INSTALLED: 'agent.not-installed',
  AGENT_PROVIDER_UNKNOWN: 'agent.not-installed',
  PROVIDER_UNAVAILABLE: 'agent.not-installed',

  EXTENSION_DISABLED: 'plugin.disabled',
  EXTENSION_CRASH_LOOP_DISABLED: 'plugin.disabled',
  PLUGIN_DISABLED: 'plugin.disabled',
  EXTENSION_NOT_FOUND: 'plugin.disabled',
  NOT_INSTALLED: 'plugin.disabled',

  TOOL_DENIED: 'capability.tool-denied',
  CAPABILITY_DENIED: 'capability.tool-denied',
  PERMISSION_DENIED: 'capability.tool-denied',
  PERMISSION_FORBIDDEN: 'capability.tool-denied',
  NETWORK_SCOPE_DENIED: 'capability.tool-denied',
  FILESYSTEM_SCOPE_DENIED: 'capability.tool-denied',
  NETWORK_OPERATION_DENIED: 'capability.tool-denied',
  SENSITIVE_RESOURCE_DENIED: 'capability.tool-denied',
  PATH_OUTSIDE_WORKSPACE: 'capability.tool-denied',
  TARGET_NOT_ALLOWED: 'capability.tool-denied',

  APPROVAL_REQUIRED: 'capability.approval-pending',
  APPROVAL_PENDING: 'capability.approval-pending',
  WORKSHOP_APPROVAL_PENDING: 'capability.approval-pending',
  APPROVAL_NOT_APPROVED: 'capability.approval-pending',
  APPROVAL_EXPIRED: 'capability.approval-pending'
});

/**
 * 把 context 压成"补充信息"字符串。返回空串代表没有可展示的补充信息。
 * 为什么序列化：context 里的值可能来自 IPC（对象/数字/布尔），统一成字符串才能安全渲染。
 */
function describeContext(context) {
  if (!context || typeof context !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === '') continue;
    if (value instanceof Error) continue; // 错误对象不可直接渲染，只经 emptyStateForError 进 detail
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (!text) continue;
    parts.push(text.length > 120 ? text.slice(0, 120) : text);
  }
  return parts.join(' · ');
}

/** 归一化 key：容错 null / 非字符串 / 首尾空白，未知 key 返回 null（由调用方回落 generic）。 */
function normalizeKey(key) {
  const text = String(key ?? '').trim();
  return Object.hasOwn(EMPTY_STATES, text) ? text : null;
}

/**
 * 按产品 key 解析空状态文案。
 * 返回 { key, title, message, action, technical, context }：
 *   - 未知 key / 空 key → generic.error（绝不返回 undefined、绝不抛错）；
 *   - context 只作为结构字段附加，不混进 title/message/action —— 产品文案必须保持纯人话。
 */
export function emptyStateFor(key, context = {}) {
  const resolvedKey = normalizeKey(key) ?? GENERIC_EMPTY_STATE_KEY;
  const base = EMPTY_STATES[resolvedKey];
  return {
    key: base.key,
    title: base.title,
    message: base.message,
    action: base.action,
    technical: false,
    context: describeContext(context)
  };
}

/** 从 Error / 字符串 / 结构化失败对象里取技术 code；取不到返回 null。 */
function pickCode(errorLike) {
  if (typeof errorLike === 'string') {
    const text = errorLike.trim();
    return text ? text : null;
  }
  if (!errorLike || typeof errorLike !== 'object') return null;
  const code = errorLike.code ?? errorLike.errorCode ?? null;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/** 从 Error / 结构化失败对象里取原始技术文本（不含 code 部分）；取不到返回空串。 */
function pickMessage(errorLike) {
  if (typeof errorLike === 'string') return errorLike.trim();
  if (!errorLike || typeof errorLike !== 'object') return '';
  const message = errorLike.message ?? errorLike.detail ?? errorLike.error ?? '';
  // Error.message 可能是非字符串（被 IPC 序列化过），统一成字符串再截断。
  return typeof message === 'string' ? message.trim() : String(message ?? '').trim();
}

/**
 * 技术错误 → 友好空状态。输入可以是 Error、IPC 透传的 { code, message }、或裸 code 字符串。
 * 返回 { key, title, message, action, detail }：
 *   - message 恒为产品文案（人话），技术串只出现在 detail；
 *   - detail 可能是 null（没有技术信息时），UI 据此决定是否显示"技术细节"展开区；
 *   - 未知 code 不抛错，落 generic.error，detail 仍保留原始 code+message 供反馈。
 */
export function emptyStateForError(errorLike) {
  const code = pickCode(errorLike);
  const message = pickMessage(errorLike);
  const detail = [code, message].filter(Boolean).join(' ') || null;
  const resolvedKey = (code && TECHNICAL_CODE_TO_STATE[code]) || GENERIC_EMPTY_STATE_KEY;
  const base = EMPTY_STATES[resolvedKey] ?? EMPTY_STATES[GENERIC_EMPTY_STATE_KEY];
  return {
    key: base.key,
    title: base.title,
    message: base.message,
    action: base.action,
    detail
  };
}
