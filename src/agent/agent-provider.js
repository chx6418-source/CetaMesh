// AgentProvider 领域契约（阶段 06）。
//
// Agent Provider != Model Provider：
//   - Model Provider 决定"用哪个模型厂商/模型"（DSH 内部的 provider/model，见
//     chat-service 的 config.provider 与 control-service 的 model.*）；
//   - Agent Provider 决定"任务由哪种 Agent Runtime 执行"（会话生命周期、回合、
//     取消、恢复、上下文用量），是 Chat / Task 与具体 Agent 实现之间的领域边界。
//
// 不支持的能力必须显式 unsupported：defineAgentProvider 会为未实现的方法自动
// 填充抛 AGENT_UNSUPPORTED 的桩，capabilities() 同时列出 supported / unsupported，
// 禁止为了接口完整而伪造能力（DSH 无 checkpoint / handoff 端点，实测 404 / 无协议）。
//
// 依赖方向：agent-provider（契约）← dsh-agent-provider（实现，复用 dsh-client.js）
//          ← service（注册与 agent.* 方法族）← bridge（注入共享 api 实例）。

/** AgentProvider 必须提供（或显式 unsupported）的方法。 */
export const AGENT_PROVIDER_METHODS = Object.freeze([
  'createSession',
  'send',
  'cancel',
  'status',
  'contextUsage',
  'checkpoint',
  'resume',
  'handoff',
  'capabilities',
  'closeSession',
  // 扩展方法（真实能力，非接口凑数）：
  'follow',       // 会话事件流（进度接收的唯一通道，async generator）
  'selectModel',  // 会话级模型绑定（DSH session/selectModel）
  'health'        // 可用性探测（优雅降级依据）
]);

/**
 * 会话事件流协议标识。消费方（如 Chat 回合状态机）只能驱动自己认识的事件协议；
 * 当前唯一协议是 DSH 0.1.5 Typert 网关的 session/follow 事件
 * （turn/start / assistant/chunk / assistant/message / turn/end）。
 */
export const AGENT_EVENT_PROTOCOL_DSH = 'dsh-session-events';

export const AGENT_ERROR_CODES = Object.freeze({
  AGENT_UNSUPPORTED: 'AGENT_UNSUPPORTED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND'
});

/** 带稳定 code 的 Provider 错误；IPC 层据此原样透传错误码。 */
export function agentProviderError(code, message, { cause } = {}) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** prompt 内容归一化：字符串 → 单个 text 块；数组 → 原样（宽松校验块结构）。 */
export function normalizePromptContent(content) {
  if (typeof content === 'string') {
    if (!content.trim()) throw agentProviderError('INVALID_PARAMS', '消息内容不能为空');
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw agentProviderError('INVALID_PARAMS', 'content 必须是非空字符串或内容块数组');
  }
  for (const block of content) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      throw agentProviderError('INVALID_PARAMS', 'content 块必须是含 type 的对象');
    }
  }
  return content;
}

/**
 * 定义一个 Agent Provider：
 * - id/label 必填；eventProtocol 标识会话事件流协议（无流能力则 null）；
 * - methods 中未提供的契约方法自动填充 unsupported 桩（显式拒绝，绝不假装支持）；
 * - capabilities() 返回 supported / unsupported 明细，供 UI 与调用方在发起前判断。
 */
export function defineAgentProvider({ id, label, eventProtocol = null, methods }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('defineAgentProvider 需要 id');
  if (typeof label !== 'string' || !label.trim()) throw new Error('defineAgentProvider 需要 label');
  if (!methods || typeof methods !== 'object') throw new Error('defineAgentProvider 需要 methods');

  const providerId = id.trim();
  const filled = {};
  const supported = {};
  const unsupported = [];
  for (const name of AGENT_PROVIDER_METHODS) {
    // capabilities 由 defineAgentProvider 自己保证（永远真实可用），不参与自动填充。
    if (name === 'capabilities') {
      supported[name] = true;
      continue;
    }
    const implementation = methods[name];
    if (typeof implementation === 'function') {
      filled[name] = implementation;
      supported[name] = true;
    } else {
      filled[name] = async () => {
        throw agentProviderError(
          'AGENT_UNSUPPORTED',
          `Agent Provider「${label}」不支持 ${name}：该 Provider 没有对应能力`
        );
      };
      supported[name] = false;
      unsupported.push(name);
    }
  }

  const provider = {
    id: providerId,
    label: label.trim(),
    eventProtocol,
    ...filled,
    // 必须放在 ...filled 之后：否则未实现 methods.capabilities 时会把真实实现覆盖成拒绝桩。
    capabilities() {
      return Object.freeze({
        id: providerId,
        label: label.trim(),
        eventProtocol,
        supported: Object.freeze({ ...supported }),
        unsupported: Object.freeze([...unsupported])
      });
    }
  };
  return Object.freeze(provider);
}
