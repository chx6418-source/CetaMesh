// Model Runtime —— 共享类型与错误映射（会话 1 / TASK-S1-001）。
//
// Model Provider 决定"用哪个模型厂商/模型"（DeepSeek / OpenAI / OpenAI 兼容），
// 与 AgentProvider（src/agent/agent-provider.js，决定"任务由哪种 Agent Runtime 执行"）
// 是两个正交概念。Chat 的普通回合走本层，不经过 DSH。
//
// 错误约定：
//   - 所有 Provider 错误统一映射为带稳定 code 的 Error（IPC 层原样透传 code）；
//   - 错误信息绝不携带 API Key：Provider 实现层在源头做 scrub，这里再兜底截断。

export const MODEL_ERROR_CODES = Object.freeze({
  MODEL_PROVIDER_UNKNOWN: 'MODEL_PROVIDER_UNKNOWN',
  MODEL_PROVIDER_KEY_MISSING: 'MODEL_PROVIDER_KEY_MISSING',
  MODEL_PROVIDER_UNAVAILABLE: 'MODEL_PROVIDER_UNAVAILABLE',
  MODEL_PROVIDER_ERROR: 'MODEL_PROVIDER_ERROR',
  MODEL_NO_MODEL: 'MODEL_NO_MODEL',
  INVALID_PARAMS: 'INVALID_PARAMS'
});

/** 带 code 的 Model Runtime 错误；message 一律视为可展示文本（不含 Key）。 */
export function modelRuntimeError(code, message, { cause } = {}) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** reasoning 会话值 → OpenAI reasoning_effort；'off' 表示不携带该参数（返回 null）。 */
export function mapReasoningEffort(effort) {
  switch (String(effort ?? '')) {
    case 'low': return 'low';
    case 'high':
    case 'max': return 'high';
    default: return null;
  }
}

/** 错误/事件文本兜底：截断 + 去除 Key 痕迹（scrubKey 由 Provider 注入）。 */
export function boundedErrorText(text, limit = 1000) {
  return String(text ?? '').slice(0, limit);
}

/**
 * SSE 行解析器：跨 chunk 缓冲，产出完整行（兼容 \r\n）。
 * 返回 push(text) → string[]（本次新完成的行）与 flush()（流结束时剩余）。
 */
export function createSseLineParser() {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      const lines = [];
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
      }
      return lines;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest ? [rest] : [];
    }
  };
}
