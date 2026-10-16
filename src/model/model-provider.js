// ModelProvider 契约（会话 1 / TASK-S1-001）。
//
// 最低能力：id / label / listModels() / chat() / stream() / abort / health()。
// Abort 经每请求的 AbortSignal 传入（chat/stream 的 options.signal），Provider 必须
// 尊重该 signal 并在取消时以 turn/end(aborted) 事件收尾，不得悬挂。
//
// 统一流事件协议（model-stream-v1）：与 DSH session/follow 的回合事件同名同形
// （turn/start / assistant/chunk(text-delta) / assistant/message / turn/end），
// 使 Chat 回合状态机（desktop/chat-service.js）对两条路径零改动复用。
// 这是刻意决策：协议已被阶段 03 验证，重造第二种格式只会引入漂移。

export const MODEL_STREAM_PROTOCOL = 'model-stream-v1';

export const MODEL_PROVIDER_METHODS = Object.freeze(['listModels', 'chat', 'stream', 'health']);

const SETTING_FIELD_TYPES = new Set(['string', 'number', 'boolean']);
const SECRET_SETTING_KEY = /(api.?key|secret|token|password|credential|private.?key)/i;

function normalizeSettingsFields(fields = []) {
  if (!Array.isArray(fields)) throw new Error('Model Provider settingsFields 必须是数组');
  const seen = new Set();
  return Object.freeze(fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`Model Provider settingsFields[${index}] 必须是对象`);
    }
    const key = typeof field.key === 'string' ? field.key.trim() : '';
    const label = typeof field.label === 'string' ? field.label.trim() : '';
    const type = field.type;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || SECRET_SETTING_KEY.test(key)
      || !label || label.length > 120 || !SETTING_FIELD_TYPES.has(type)) {
      throw new Error(`Model Provider settingsFields[${index}] 的 key、label 或 type 无效`);
    }
    if (seen.has(key)) throw new Error(`Model Provider settingsFields 重复字段：${key}`);
    seen.add(key);

    const descriptor = { key, label, type };
    if (field.choices !== undefined) {
      if (type !== 'string' || !Array.isArray(field.choices) || field.choices.length === 0
        || field.choices.length > 50
        || field.choices.some(value => typeof value !== 'string' || !value.trim() || value.length > 120)
        || new Set(field.choices).size !== field.choices.length) {
        throw new Error(`Model Provider settingsFields[${index}] choices 无效`);
      }
      descriptor.choices = Object.freeze([...field.choices]);
    }
    if (field.min !== undefined || field.max !== undefined) {
      if (type !== 'number'
        || (field.min !== undefined && !Number.isFinite(field.min))
        || (field.max !== undefined && !Number.isFinite(field.max))
        || (field.min !== undefined && field.max !== undefined && field.min > field.max)) {
        throw new Error(`Model Provider settingsFields[${index}] numeric range 无效`);
      }
      if (field.min !== undefined) descriptor.min = field.min;
      if (field.max !== undefined) descriptor.max = field.max;
    }
    return Object.freeze(descriptor);
  }));
}

/** 构造一条标准流事件（同形于 DSH 回合事件）。 */
export function modelStreamEvent(type, data = {}) {
  return { type, data };
}

/**
 * 定义一个 Model Provider：
 * - id/label 必填；listModels/chat/stream 必须真实实现（缺失直接抛错，不造假桩）；
 * - health 可选；未探测的 Provider 必须返回 unknown/unverified，不能伪报 available；
 * - 实例不可变（Object.freeze），Key 只能经注入的 secrets 在调用时解析，绝不缓存。
 */
export function defineModelProvider({ id, label, defaultModel = null, supportsTools = false, supportsToolsForModel = null, supportsReasoning = false, settingsFields = [], methods }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('defineModelProvider 需要 id');
  if (typeof label !== 'string' || !label.trim()) throw new Error('defineModelProvider 需要 label');
  if (!methods || typeof methods !== 'object') throw new Error('defineModelProvider 需要 methods');
  for (const name of ['listModels', 'chat', 'stream']) {
    if (typeof methods[name] !== 'function') {
      throw new Error(`defineModelProvider「${id}」缺少必需方法 ${name}`);
    }
  }
  const normalizedSettingsFields = normalizeSettingsFields(settingsFields);
  const toolCapability = typeof supportsTools === 'function' ? supportsTools : () => supportsTools === true;
  const reasoningCapability = typeof supportsReasoning === 'function' ? supportsReasoning : () => supportsReasoning === true;
  const provider = {
    id: id.trim(),
    label: label.trim(),
    defaultModel: typeof defaultModel === 'string' && defaultModel ? defaultModel : null,
    settingsFields: () => normalizedSettingsFields,
    streamProtocol: MODEL_STREAM_PROTOCOL,
    listModels: methods.listModels,
    chat: methods.chat,
    stream: methods.stream,
    health: typeof methods.health === 'function'
      ? methods.health
      : async () => ({
        provider: id.trim(), status: 'unverified', available: null,
        configured: null, reachable: null, authenticated: null, inferencing: null
      })
  };
  Object.defineProperties(provider, {
    supportsTools: { enumerable: true, get: () => toolCapability() === true },
    supportsToolsForModel: { enumerable: true, value: model => (typeof supportsToolsForModel === 'function'
      ? supportsToolsForModel(model) : toolCapability(model)) === true },
    supportsReasoning: { enumerable: true, value: model => reasoningCapability(model) === true }
  });
  return Object.freeze(provider);
}
