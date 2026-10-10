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

/** 构造一条标准流事件（同形于 DSH 回合事件）。 */
export function modelStreamEvent(type, data = {}) {
  return { type, data };
}

/**
 * 定义一个 Model Provider：
 * - id/label 必填；listModels/chat/stream 必须真实实现（缺失直接抛错，不造假桩）；
 * - health 可选，默认视为可用；
 * - 实例不可变（Object.freeze），Key 只能经注入的 secrets 在调用时解析，绝不缓存。
 */
export function defineModelProvider({ id, label, defaultModel = null, supportsTools = false, methods }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('defineModelProvider 需要 id');
  if (typeof label !== 'string' || !label.trim()) throw new Error('defineModelProvider 需要 label');
  if (!methods || typeof methods !== 'object') throw new Error('defineModelProvider 需要 methods');
  for (const name of ['listModels', 'chat', 'stream']) {
    if (typeof methods[name] !== 'function') {
      throw new Error(`defineModelProvider「${id}」缺少必需方法 ${name}`);
    }
  }
  const provider = {
    id: id.trim(),
    label: label.trim(),
    defaultModel: typeof defaultModel === 'string' && defaultModel ? defaultModel : null,
    supportsTools: supportsTools === true,
    streamProtocol: MODEL_STREAM_PROTOCOL,
    listModels: methods.listModels,
    chat: methods.chat,
    stream: methods.stream,
    health: typeof methods.health === 'function'
      ? methods.health
      : async () => ({ available: true, provider: id.trim() })
  };
  return Object.freeze(provider);
}
