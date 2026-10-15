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

import crypto from 'node:crypto';
import {
  modelRuntimeError,
  mapReasoningEffort,
  createSseLineParser,
  MODEL_ERROR_CODES
} from '../types.js';
import { defineModelProvider, modelStreamEvent } from '../model-provider.js';

const LIST_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 300_000;
const SSE_IDLE_TIMEOUT_MS = 45_000;
const REASONING_EFFORT_CHOICES = Object.freeze(['off', 'low', 'high', 'max']);

function isReasoningModel(model) {
  return /^(?:o[134](?:-|$)|gpt-5(?:-|$))/i.test(String(model ?? '').trim());
}

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
  supportsTools = false,
  supportsReasoning = null,
  requestTimeoutMs = CHAT_TIMEOUT_MS,
  sseIdleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
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

  function toolCallingEnabled() {
    return typeof supportsTools === 'function' ? supportsTools() === true : supportsTools === true;
  }

  function reasoningEnabled(model) {
    if (!reasoningParam || !isReasoningModel(model)) return false;
    return typeof supportsReasoning === 'function' ? supportsReasoning(model) === true : supportsReasoning !== false;
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

  function capabilityToolName(id) {
    const value = String(id ?? '');
    if (!value || value.length > 128) {
      throw modelRuntimeError('MODEL_INVALID_TOOL_SCHEMA', 'Capability id is missing or too long');
    }
    const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
    if (safe.length <= 60) return 'cap_' + safe;
    const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
    return 'cap_' + safe.slice(0, 50) + '_' + digest;
  }

  function buildToolSchemas(tools) {
    const names = new Map();
    const byName = new Map();
    for (const descriptor of Array.isArray(tools) ? tools : []) {
      const id = typeof descriptor?.id === 'string' ? descriptor.id.trim() : '';
      const description = typeof descriptor?.description === 'string' ? descriptor.description.trim() : '';
      const parameters = descriptor?.inputSchema;
      if (!id || !description || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw modelRuntimeError('MODEL_INVALID_TOOL_SCHEMA', 'Capability tool requires id, description, and an object input schema');
      }
      const name = capabilityToolName(id);
      const previous = names.get(name);
      if (previous && previous !== id) {
        throw modelRuntimeError('MODEL_INVALID_TOOL_SCHEMA', 'Capability ids collide after Provider tool-name mapping');
      }
      names.set(name, id);
      byName.set(name, id);
    }
    const schemas = [...names.entries()].map(([name, id]) => {
      const descriptor = tools.find((item) => item.id === id);
      return {
        type: 'function',
        function: {
          name,
          description: descriptor.description,
          parameters: descriptor.inputSchema
        }
      };
    });
    return { schemas, byName };
  }

  function buildBody({ model, messages, reasoning, stream, tools = [], toolChoice }) {
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
    if (Array.isArray(tools) && tools.length) {
      if (!toolCallingEnabled()) {
        throw modelRuntimeError('MODEL_TOOL_CALLING_UNSUPPORTED', 'This Model Provider does not support structured tool calling');
      }
      body.tools = buildToolSchemas(tools).schemas;
      body.tool_choice = toolChoice === 'none' ? 'none' : 'auto';
    }
    const effort = reasoningEnabled(model) ? mapReasoningEffort(reasoning) : null;
    if (effort) body[reasoningParam] = effort;
    if (stream && supportsStreamOptions) body.stream_options = { include_usage: true };
    return body;
  }

  async function request(path, { body, signal, timeoutMs }) {
    const { apiKey, base } = resolveCredentials();
    const deadline = AbortSignal.timeout(timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
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
      if (deadline.aborted && !signal?.aborted) {
        throw modelRuntimeError('MODEL_REQUEST_TIMEOUT', `「${label}」请求超时`, { cause: error });
      }
      throw mapFetchError(error, apiKey);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapHttpError(response.status, bodyText, apiKey);
    }
    return { response, apiKey, signal: effectiveSignal, deadline };
  }

  return defineModelProvider({
    id,
    label,
    defaultModel,
    supportsTools: toolCallingEnabled,
    supportsReasoning: reasoningEnabled,
    settingsFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'string' },
      ...(reasoningParam ? [{
        key: 'reasoningEffort', label: '推理强度', type: 'string', choices: REASONING_EFFORT_CHOICES
      }] : [])
    ],
    methods: {
      async listModels({ signal } = {}) {
        const { apiKey, base } = resolveCredentials();
        const deadline = AbortSignal.timeout(LIST_TIMEOUT_MS);
        const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
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
        const { byName } = buildToolSchemas(options?.tools);
        const { response, signal: requestSignal } = await request('/chat/completions', {
          body,
          signal: options?.signal,
          timeoutMs: requestTimeoutMs
        });
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          if (requestSignal.aborted && requestSignal.reason?.name === 'TimeoutError') {
            throw modelRuntimeError('MODEL_REQUEST_TIMEOUT', `「${label}」请求超时`, { cause: error });
          }
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
          toolCalls: (Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []).map((call) => {
            const name = String(call?.function?.name ?? '');
            return {
              id: typeof call?.id === 'string' ? call.id : '',
              name,
              ...(byName.has(name) ? { capabilityId: byName.get(name) } : {}),
              arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
            };
          }),
          usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
          model: typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : null,
          finishReason: choice?.finish_reason ?? null
        };
      },

      /** 流式回合：async generator，产出 model-stream-v1 事件；取消以 turn/end(aborted) 收尾。 */
      async *stream(options) {
        const body = buildBody({ ...options, stream: true });
        const { byName } = buildToolSchemas(options?.tools);
        const { response, signal: requestSignal, deadline } = await request('/chat/completions', { body, signal: options?.signal, timeoutMs: requestTimeoutMs });
        const signal = options?.signal;
        const parser = createSseLineParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullText = '';
        let usage = null;
        let finished = false;
        let finishReasonSeen = false;
        let streamModel = null;
        const toolCalls = new Map();
        /** 处理一行 SSE：返回 true 表示遇到 [DONE]，流结束。 */
        const consumeLine = (line) => {
          if (!line.startsWith('data:')) return false;
          const data = line.slice(5).trim();
          if (!data) return false;
          if (data === '[DONE]') { finished = true; return true; }
          let payload;
          try {
            payload = JSON.parse(data);
          } catch (error) {
            throw modelRuntimeError(
              MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR,
              `「${label}」返回的 SSE data 不是合法 SSE JSON`,
              { cause: error }
            );
          }
          if (payload?.model) streamModel = String(payload.model);
          if (payload?.usage && typeof payload.usage === 'object') usage = payload.usage;
          const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
          if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) finishReasonSeen = true;
          const delta = choice?.delta;
          for (const toolDelta of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
            const index = Number.isInteger(toolDelta?.index) ? toolDelta.index : toolCalls.size;
            const previous = toolCalls.get(index) ?? { id: '', type: 'function', name: '', arguments: '' };
            if (typeof toolDelta?.id === 'string' && toolDelta.id) previous.id = toolDelta.id;
            if (typeof toolDelta?.type === 'string' && toolDelta.type) previous.type = toolDelta.type;
            if (typeof toolDelta?.function?.name === 'string') previous.name += toolDelta.function.name;
            if (typeof toolDelta?.function?.arguments === 'string') previous.arguments += toolDelta.function.arguments;
            toolCalls.set(index, previous);
          }
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
        yield modelStreamEvent('turn/start', {
          providerId: id,
          requestedModel: options?.requestedModel ?? 'provider-default',
          resolvedModel: null
        });
        // abort 竞争：undici 的 signal 只保证到响应头为止；响应体 reader.read() 在
        // 挂流（服务端停发数据）上会永久阻塞且不感知 abort。这里显式把 abort 注入
        // 读取循环：竞争命中即 cancel reader（关闭 socket）并按 aborted 收尾。
        const abortWait = requestSignal
          ? new Promise((_, reject) => {
              if (requestSignal.aborted) reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
              else requestSignal.addEventListener('abort', () => reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' })), { once: true });
            })
          : null;
        try {
          while (true) {
            let idleTimer;
            const idleWait = new Promise((_, reject) => {
              idleTimer = setTimeout(() => reject(modelRuntimeError('MODEL_STREAM_IDLE_TIMEOUT', `「${label}」流式响应长时间无数据`, {})), sseIdleTimeoutMs);
            });
            let readResult;
            try {
              readResult = await Promise.race([reader.read(), idleWait, ...(abortWait ? [abortWait] : [])]);
            } catch (error) {
              if (error?.code === 'MODEL_STREAM_IDLE_TIMEOUT') {
                try { await reader.cancel('idle timeout'); }
                catch (cancelError) { log(`Model Provider「${label}」SSE idle cleanup failed (${cancelError?.code ?? cancelError?.name ?? 'stream-error'})`); }
                throw error;
              }
              if (requestSignal.aborted && deadline.aborted && !signal?.aborted) {
                try { await reader.cancel('request timeout'); }
                catch (cancelError) { log(`Model Provider「${label}」SSE timeout cleanup failed (${cancelError?.code ?? cancelError?.name ?? 'stream-error'})`); }
                throw modelRuntimeError('MODEL_REQUEST_TIMEOUT', `「${label}」流式请求超时`, { cause: error });
              }
              throw error;
            } finally {
              clearTimeout(idleTimer);
            }
            const { done, value } = readResult;
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
          if (!finished && !finishReasonSeen) {
            throw modelRuntimeError('MODEL_STREAM_INCOMPLETE', `「${label}」流式响应提前结束，缺少完成标记`, {});
          }
        } catch (error) {
          const aborted = signal?.aborted || error?.name === 'AbortError';
          if (aborted) {
            try { await reader.cancel('aborted'); }
            catch (cancelError) { log(`Model Provider「${label}」SSE abort cleanup failed (${cancelError?.code ?? cancelError?.name ?? 'stream-error'})`); }
            yield modelStreamEvent('turn/end', { reason: { kind: 'aborted', usage } });
            return;
          }
          throw error;
        } finally {
          try { reader.releaseLock(); }
          catch (releaseError) { log(`Model Provider「${label}」SSE reader release failed (${releaseError?.code ?? releaseError?.name ?? 'stream-error'})`); }
        }
        log(`Model Provider「${label}」回合完成（model=${streamModel}，chars=${fullText.length}）`);
        if (toolCalls.size) {
          const completedCalls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
            id: call.id,
            type: call.type,
            name: call.name,
            ...(byName.has(call.name) ? { capabilityId: byName.get(call.name) } : {}),
            arguments: call.arguments
          }));
          yield modelStreamEvent('assistant/tool-calls', { toolCalls: completedCalls });
        }
        yield modelStreamEvent('assistant/message', {
          message: { content: [{ type: 'text', text: fullText }], ...(usage ? { usage } : {}) }
        });
        yield modelStreamEvent('turn/end', { providerId: id,
          requestedModel: options?.requestedModel ?? 'provider-default',
          resolvedModel: streamModel,
          reason: { kind: 'completed', usage } });
      }
    }
  });
}
