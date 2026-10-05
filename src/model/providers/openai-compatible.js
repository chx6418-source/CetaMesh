// OpenAI 兼容 Model Provider（会话 1 / TASK-S1-002）。
//
// DeepSeek Official / OpenAI / 任意 OpenAI 兼容端点共享本实现，只差常量：
//   deepseek-official  → https://api.deepseek.com            （reasoning 以模型区分：deepseek-reasoner）
//   openai             → https://api.openai.com/v1           （支持 reasoning_effort）
//   openai-compatible  → 由 Settings 的 baseUrl 提供          （默认不带 stream_options，兼容面最大）
//
// 安全约定：
//   - Key 只经注入的 secrets.raw(id) 在每次调用时解析，绝不缓存、绝不入日志；
//   - 所有错误文本在源头 scrub（Key 字符串出现即替换为 ***）；
//   - 事件与错误都不回显请求头。

import {
  modelRuntimeError,
  mapReasoningEffort,
  createSseLineParser,
  MODEL_ERROR_CODES
} from '../types.js';
import { defineModelProvider, modelStreamEvent } from '../model-provider.js';

const LIST_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 300_000;

function extractProviderMessage(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
    return null;
  } catch {
    const text = bodyText.trim();
    return text ? text.slice(0, 300) : null;
  }
}

export function createOpenAiCompatibleModelProvider({
  id,
  label,
  baseUrl,
  defaultModel = null,
  secrets,
  fetchImpl = fetch,
  reasoningParam = null,
  supportsStreamOptions = false,
  log = () => {}
} = {}) {
  if (!secrets || typeof secrets.raw !== 'function') {
    throw new Error(`createOpenAiCompatibleModelProvider「${id}」需要注入 secrets（src/providers/secrets.js）`);
  }

  function scrub(text, apiKey) {
    const value = String(text ?? '');
    if (!apiKey || !value) return value;
    return value.split(apiKey).join('***');
  }

  /** 每次调用时解析凭据；未配置 Key → 明确错误（fail-closed）。 */
  function resolveCredentials() {
    const entry = secrets.raw(id); // 缺 Key 抛 PROVIDER_SECRET_NOT_FOUND
    const base = String(entry.baseUrl || baseUrl || '').replace(/\/+$/, '');
    if (!base) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_PROVIDER_KEY_MISSING,
        `Model Provider「${label}」尚未配置服务地址（baseUrl）`
      );
    }
    return { apiKey: entry.apiKey, base };
  }

  function mapFetchError(error, apiKey) {
    const raw = String(error?.message ?? error);
    if (error?.name === 'AbortError' || /aborted/i.test(raw)) {
      return modelRuntimeError('ABORTED', '请求已取消', { cause: error });
    }
    const transport = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|socket/i.test(raw);
    const message = transport
      ? `无法连接到「${label}」：${scrub(raw, apiKey)}`
      : `「${label}」请求失败：${scrub(raw, apiKey)}`;
    return modelRuntimeError(
      transport ? MODEL_ERROR_CODES.MODEL_PROVIDER_UNAVAILABLE : MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR,
      message,
      { cause: error }
    );
  }

  function mapHttpError(status, bodyText, apiKey) {
    const detail = scrub(extractProviderMessage(bodyText) ?? `HTTP ${status}`, apiKey).slice(0, 500);
    let message;
    if (status === 401 || status === 403) message = `「${label}」认证失败（API Key 无效或无权限）：${detail}`;
    else if (status === 402) message = `「${label}」余额不足：${detail}`;
    else if (status === 404) message = `「${label}」模型或端点不存在：${detail}`;
    else if (status === 429) message = `「${label}」请求过于频繁或配额不足：${detail}`;
    else if (status >= 500) message = `「${label}」服务暂时不可用（HTTP ${status}）：${detail}`;
    else message = `「${label}」返回 HTTP ${status}：${detail}`;
    return modelRuntimeError(MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR, message);
  }

  function buildBody({ model, messages, reasoning, stream }) {
    if (typeof model !== 'string' || !model.trim()) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_NO_MODEL,
        `Model Provider「${label}」需要指定模型（会话未设置 model 且 Provider 无默认模型）`
      );
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw modelRuntimeError(MODEL_ERROR_CODES.INVALID_PARAMS, 'messages 不能为空');
    }
    const body = { model: model.trim(), messages, stream: Boolean(stream) };
    const effort = reasoningParam ? mapReasoningEffort(reasoning) : null;
    if (effort) body[reasoningParam] = effort;
    if (stream && supportsStreamOptions) body.stream_options = { include_usage: true };
    return body;
  }

  async function request(path, { body, signal, timeoutMs }) {
    const { apiKey, base } = resolveCredentials();
    const effectiveSignal = signal ?? AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json'
        },
        body: JSON.stringify(body),
        signal: effectiveSignal
      });
    } catch (error) {
      throw mapFetchError(error, apiKey);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapHttpError(response.status, bodyText, apiKey);
    }
    return { response, apiKey };
  }

  return defineModelProvider({
    id,
    label,
    defaultModel,
    methods: {
      async listModels({ signal } = {}) {
        const { apiKey, base } = resolveCredentials();
        const effectiveSignal = signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS);
        let response;
        try {
          response = await fetchImpl(`${base}/models`, {
            headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
            signal: effectiveSignal
          });
        } catch (error) {
          throw mapFetchError(error, apiKey);
        }
        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          throw mapHttpError(response.status, bodyText, apiKey);
        }
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          throw modelRuntimeError(MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR, `「${label}」模型列表不是合法 JSON`, { cause: error });
        }
        const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
        const models = entries
          .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
          .map((entry) => String(entry?.id ?? '').trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .map((modelId) => ({ id: modelId, label: modelId }));
        return models;
      },

      async chat(options) {
        const body = buildBody({ ...options, stream: false });
        const { response } = await request('/chat/completions', {
          body,
          signal: options?.signal,
          timeoutMs: CHAT_TIMEOUT_MS
        });
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          throw modelRuntimeError(MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR, `「${label}」响应不是合法 JSON`, { cause: error });
        }
        const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
        const rawContent = choice?.message?.content;
        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
            : '';
        return {
          text,
          usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
          model: String(payload?.model ?? body.model),
          finishReason: choice?.finish_reason ?? null
        };
      },

      /** 流式回合：async generator，产出 model-stream-v1 事件；取消以 turn/end(aborted) 收尾。 */
      async *stream(options) {
        const body = buildBody({ ...options, stream: true });
        const signal = options?.signal;
        const { response } = await request('/chat/completions', { body, signal, timeoutMs: CHAT_TIMEOUT_MS });
        const parser = createSseLineParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullText = '';
        let usage = null;
        let finished = false;
        let streamModel = body.model;
        /** 处理一行 SSE：返回 true 表示遇到 [DONE]，流结束。 */
        const consumeLine = (line) => {
          if (!line.startsWith('data:')) return false;
          const data = line.slice(5).trim();
          if (!data) return false;
          if (data === '[DONE]') { finished = true; return true; }
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            return false; // 忽略无法解析的行（兼容端点心跳/注释行）
          }
          if (payload?.model) streamModel = String(payload.model);
          if (payload?.usage && typeof payload.usage === 'object') usage = payload.usage;
          const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
          const delta = choice?.delta;
          const piece = typeof delta?.content === 'string'
            ? delta.content
            : Array.isArray(delta?.content)
              ? delta.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
              : '';
          if (piece) {
            fullText += piece;
            pendingEvents.push(modelStreamEvent('assistant/chunk', { chunk: { type: 'text-delta', text: piece } }));
          }
          return false;
        };
        let pendingEvents = [];
        yield modelStreamEvent('turn/start', {});
        // abort 竞争：undici 的 signal 只保证到响应头为止；响应体 reader.read() 在
        // 挂流（服务端停发数据）上会永久阻塞且不感知 abort。这里显式把 abort 注入
        // 读取循环：竞争命中即 cancel reader（关闭 socket）并按 aborted 收尾。
        const abortWait = signal
          ? new Promise((_, reject) => {
              if (signal.aborted) reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
              else signal.addEventListener('abort', () => reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' })), { once: true });
            })
          : null;
        try {
          while (true) {
            const { done, value } = await (abortWait
              ? Promise.race([reader.read(), abortWait])
              : reader.read());
            if (done) break;
            pendingEvents = [];
            let streamEnded = false;
            for (const line of parser.push(decoder.decode(value, { stream: true }))) {
              if (consumeLine(line)) { streamEnded = true; break; }
            }
            for (const event of pendingEvents) {
              yield event;
            }
            if (streamEnded) break;
          }
          // 收尾 flush：个别兼容端点最后一行不带换行。
          if (!finished) {
            pendingEvents = [];
            for (const line of parser.flush()) consumeLine(line);
            for (const event of pendingEvents) yield event;
          }
        } catch (error) {
          const aborted = signal?.aborted || error?.name === 'AbortError';
          if (aborted) {
            try { await reader.cancel('aborted'); } catch { /* 流已关闭 */ }
            yield modelStreamEvent('turn/end', { reason: { kind: 'aborted', usage } });
            return;
          }
          throw error;
        } finally {
          try { reader.releaseLock(); } catch { /* 流已关闭 */ }
        }
        log(`Model Provider「${label}」回合完成（model=${streamModel}，chars=${fullText.length}）`);
        yield modelStreamEvent('assistant/message', {
          message: { content: [{ type: 'text', text: fullText }], ...(usage ? { usage } : {}) }
        });
        yield modelStreamEvent('turn/end', { reason: { kind: 'completed', usage } });
      }
    }
  });
}
