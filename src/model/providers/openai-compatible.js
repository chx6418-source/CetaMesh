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
  attachModelDiagnostics,
  mapReasoningEffort,
  createSseLineParser,
  MODEL_ERROR_CODES
} from '../types.js';
import { defineModelProvider, modelStreamEvent } from '../model-provider.js';

const LIST_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 300_000;
const SSE_IDLE_TIMEOUT_MS = 45_000;
const REASONING_EFFORT_CHOICES = Object.freeze(['off', 'low', 'high', 'max']);
const DSML_MARKERS = Object.freeze(['<｜｜DSML｜｜', '<||DSML||', '<｜DSML｜', '<|DSML|']);

function guardInternalToolSyntax(text, enabled, structured = false) {
  if (!enabled) return 0;
  const positions = DSML_MARKERS.map(marker => text.indexOf(marker)).filter(index => index >= 0);
  if (positions.length) {
    if (structured) return text.length - Math.min(...positions);
    throw modelRuntimeError('MODEL_TOOL_PROTOCOL_MISMATCH', 'Model returned internal tool syntax as assistant text');
  }
  let held = 0;
  for (const marker of DSML_MARKERS) {
    for (let size = 1; size < marker.length; size += 1) {
      if (text.endsWith(marker.slice(0, size))) held = Math.max(held, size);
    }
  }
  return held;
}

function hasDeepSeekToolContext(id, options) {
  return (Array.isArray(options?.tools) && options.tools.length > 0
    || Array.isArray(options?.messages) && options.messages.some(message => Array.isArray(message?.tool_calls) && message.tool_calls.length > 0));
}

// Canonicalize object keys only: schema array order can carry meaning.
function canonicalSchema(value) {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalSchema(value[key])])
  );
  return value;
}

function isReasoningModel(model) {
  return /^(?:o[134](?:-|$)|gpt-5(?:-|$))/i.test(String(model ?? '').trim());
}

export function createOpenAiCompatibleModelProvider({
  id,
  label,
  baseUrl,
  defaultModel = null,
  secrets,
  fetchImpl = fetch,
  reasoningParam = null,
  protocolProfile = null,
  supportsStreamOptions = false,
  supportsTools = false,
  supportsReasoning = null,
  contextProfiles = {},
  requestTimeoutMs = CHAT_TIMEOUT_MS,
  sseIdleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
  log = () => {}
} = {}) {
  if (!secrets || typeof secrets.raw !== 'function') {
    throw new Error(`createOpenAiCompatibleModelProvider「${id}」需要注入 secrets（src/providers/secrets.js）`);
  }
  const catalogCapabilities = new Map();
  // Only explicitly selected adapters can own native continuation state.
  const deepseekProfile = protocolProfile === 'deepseek-chat-v1';
  function continuation(value, model) {
    return deepseekProfile && typeof value === 'string'
      ? { profile: 'deepseek-chat-v1', providerId: id, model, reasoningContent: value } : null;
  }

  function requireResponseContinuation(value, body) {
    if (deepseekProfile && body.thinking?.type === 'enabled' && hasDeepSeekToolContext(id, body) && typeof value !== 'string') {
      throw modelRuntimeError('MODEL_CONTINUATION_REQUIRED', '模型未返回当前工具回合所需的原生续接数据；已停止继续执行工具，请核验已有结果。');
    }
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
      ? `无法连接到「${label}」，请检查网络和服务地址`
      : `「${label}」请求失败，请检查服务配置`;
    return modelRuntimeError(
      transport ? MODEL_ERROR_CODES.MODEL_PROVIDER_UNAVAILABLE : MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR,
      message,
      { cause: error }
    );
  }

  function toolCallingEnabled(model = null) {
    const configured = typeof supportsTools === 'function' ? supportsTools(model) === true : supportsTools === true;
    const advertised = catalogCapabilities.get(String(model ?? ''))?.tools;
    return configured && advertised !== false;
  }

  function reasoningEnabled(model) {
    const advertised = catalogCapabilities.get(String(model ?? ''))?.reasoning;
    if (deepseekProfile) return advertised !== false;
    if (!reasoningParam || advertised === false || (!isReasoningModel(model) && advertised !== true)) return false;
    return typeof supportsReasoning === 'function' ? supportsReasoning(model) === true : supportsReasoning !== false;
  }

  function mapHttpError(status, bodyText, apiKey, response = null, model = null) {
    // Provider bodies may echo prompts, native reasoning, headers or credentials.
    // Classify locally; never publish a provider-controlled diagnostic string.
    const category = status === 400 || status === 422 ? 'validation'
      : status === 401 || status === 403 ? 'authentication' : status === 402 ? 'quota'
      : status === 404 ? 'model-or-endpoint' : status === 429 ? 'rate-limit'
      : status >= 500 ? 'server' : 'provider';
    const guidance = { validation: '请求字段不兼容，请检查模型模式与会话续接', authentication: '认证失败（API Key 无效或无权限）',
      quota: '余额或配额不足', 'model-or-endpoint': '模型或端点不存在', 'rate-limit': '请求过于频繁或配额不足',
      server: '服务暂时不可用', provider: '模型请求被拒绝' };
    const safeMessage = `「${label}」${guidance[category]}（HTTP ${status}）`;
    const error = modelRuntimeError(MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR, safeMessage);
    const requestId = response?.headers?.get('x-request-id') ?? response?.headers?.get('request-id');
    attachModelDiagnostics(error, { category, httpStatus: status, stage: 'model-http', providerId: id, model,
      safeMessage, ...(requestId && /^[A-Za-z0-9._:-]{1,160}$/.test(requestId) && !requestId.includes(apiKey)
        ? { requestId } : {}) });
    return error;
  }

  // Conservative known automatic-cache profiles; compatible endpoints and
  // unrecognized models remain unknown. This never injects API parameters or
  // promises a hit: only returned usage verifies actual cache reads.
  function promptCacheCapabilities(model = defaultModel) {
    const unknown = { status: 'unknown', mode: null, readUsageField: null, writeUsageField: null };
    let endpoint;
    try { endpoint = new URL(secrets.raw(id)?.baseUrl || baseUrl); } catch { return unknown; }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port) return unknown;
    if (id === 'openai' && endpoint.hostname === 'api.openai.com' && endpoint.pathname.replace(/\/$/, '') === '/v1'
      && ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
        'o1-preview', 'o1-preview-2024-09-12', 'o1-mini', 'o1-mini-2024-09-12'].includes(String(model ?? ''))) {
      return { status: 'supported', mode: 'automatic', readUsageField: 'prompt_tokens_details.cached_tokens', writeUsageField: null };
    }
    if (id === 'deepseek-official' && endpoint.hostname === 'api.deepseek.com' && ['', '/', '/v1', '/v1/'].includes(endpoint.pathname)
      && /^deepseek-(?:chat|reasoner)$/.test(String(model ?? ''))) {
      return { status: 'supported', mode: 'automatic', readUsageField: 'prompt_cache_hit_tokens', writeUsageField: null };
    }
    return unknown;
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
    const descriptors = new Map();
    for (const descriptor of Array.isArray(tools) ? tools : []) {
      const id = typeof descriptor?.id === 'string' ? descriptor.id.trim() : '';
      const description = typeof descriptor?.description === 'string' ? descriptor.description.trim() : '';
      const parameters = descriptor?.inputSchema;
      if (!id || !description || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw modelRuntimeError('MODEL_INVALID_TOOL_SCHEMA', 'Capability tool requires id, description, and an object input schema');
      }
      const name = capabilityToolName(id);
      const previous = names.get(name);
      if (previous) {
        throw modelRuntimeError('MODEL_INVALID_TOOL_SCHEMA', 'Duplicate or colliding capability ids in Provider tool schema');
      }
      names.set(name, id);
      descriptors.set(id, { description, inputSchema: parameters });
      byName.set(name, id);
    }
    const schemas = [...names.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, id]) => {
      const descriptor = descriptors.get(id);
      return {
        type: 'function',
        function: {
          name,
          description: descriptor.description,
          parameters: canonicalSchema(descriptor.inputSchema)
        }
      };
    });
    return { schemas, byName };
  }

  function contextCapabilities(model = defaultModel) {
    let endpoint;
    try { endpoint = new URL(secrets.raw(id)?.baseUrl || baseUrl); } catch { return { status: 'unknown' }; }
    // Explicit profiles are pinned to an endpoint as well as exact model ID.
    const declared = Object.hasOwn(contextProfiles, model) ? contextProfiles[model] : null;
    if (declared && declared.baseUrl === endpoint.href.replace(/\/$/, '')) return { ...declared, status: 'declared' };
    if (id === 'openai' && endpoint.href === 'https://api.openai.com/v1'
      && ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'].includes(model)) {
      // Verified 2026-10-24; default reservation is local policy, not model capacity.
      return { status: 'verified', contextWindowTokens: 128000, maxOutputTokens: 16384,
        defaultOutputTokens: 4096, outputTokenParameter: 'max_tokens', version: '2026-10-24',
        source: 'https://developers.openai.com/api/docs/models/gpt-4o-mini' };
    }
    return { status: 'unknown' };
  }

  function buildBody({ model, messages, reasoning, stream, tools = [], toolChoice, maxOutputTokens }) {
    if (typeof model !== 'string' || !model.trim()) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_NO_MODEL,
        `Model Provider「${label}」需要指定模型（会话未设置 model 且 Provider 无默认模型）`
      );
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw modelRuntimeError(MODEL_ERROR_CODES.INVALID_PARAMS, 'messages 不能为空');
    }
    const thinking = deepseekProfile && reasoning !== 'off';
    const wireMessages = messages.map(message => {
      const { modelContinuation, reasoning_content, ...wire } = message;
      if (deepseekProfile && message.role === 'assistant' && thinking && tools.length) {
        if (modelContinuation?.profile !== 'deepseek-chat-v1' || modelContinuation.providerId !== id
          || modelContinuation.model !== model.trim() || typeof modelContinuation.reasoningContent !== 'string') {
          throw modelRuntimeError('MODEL_CONTINUATION_REQUIRED', '此会话缺少当前模型的原生续接数据。请新建会话并核验已有工具结果；不要重放已完成操作。');
        }
      }
      if (deepseekProfile && message.role === 'assistant' && modelContinuation?.profile === 'deepseek-chat-v1'
        && modelContinuation.providerId === id && modelContinuation.model === model.trim()
        && typeof modelContinuation.reasoningContent === 'string') wire.reasoning_content = modelContinuation.reasoningContent;
      return wire;
    });
    const body = { model: model.trim(), messages: wireMessages, stream: Boolean(stream) };
    if (maxOutputTokens !== undefined) {
      const capacity = contextCapabilities(model.trim());
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0
        || capacity.status === 'unknown' || maxOutputTokens > capacity.maxOutputTokens
        || !['max_tokens', 'max_completion_tokens'].includes(capacity.outputTokenParameter)) {
        throw modelRuntimeError('MODEL_CONTEXT_BUDGET_INVALID', 'Output token cap is not supported by this model profile');
      }
      // Official o-series Chat Completions rejects legacy max_tokens. Custom
      // deployments own their declared compatibility; do not infer it by name.
      if (id === 'openai' && resolveCredentials().base === 'https://api.openai.com/v1'
        && /^o[0-9](?:-|$)/.test(model.trim()) && capacity.outputTokenParameter === 'max_tokens') {
        throw modelRuntimeError('MODEL_CONTEXT_BUDGET_INVALID', 'Official reasoning model requires max_completion_tokens');
      }
      body[capacity.outputTokenParameter] = maxOutputTokens;
    }
    if (deepseekProfile) {
      body.thinking = { type: thinking ? 'enabled' : 'disabled' };
      if (thinking && reasoning != null) {
        const effort = { low: 'low', high: 'high', max: 'max' }[reasoning];
        if (!effort) throw modelRuntimeError('INVALID_PARAMS', 'Unsupported DeepSeek reasoning effort');
        body.reasoning_effort = effort;
      }
    }
    if (Array.isArray(tools) && tools.length) {
      if (!toolCallingEnabled(model)) {
        throw modelRuntimeError('MODEL_TOOL_CALLING_UNSUPPORTED', 'This Model Provider does not support structured tool calling');
      }
      body.tools = buildToolSchemas(tools).schemas;
      body.tool_choice = toolChoice === 'none' ? 'none' : 'auto';
    }
    const effort = reasoningEnabled(model) ? mapReasoningEffort(reasoning) : null;
    if (effort && !deepseekProfile) body[reasoningParam] = effort;
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
      throw mapHttpError(response.status, bodyText, apiKey, response, body.model);
    }
    return { response, apiKey, signal: effectiveSignal, deadline };
  }

  return defineModelProvider({
    promptCacheCapabilities,
    contextCapabilities,
    id,
    label,
    defaultModel,
    supportsTools: toolCallingEnabled,
    supportsToolsForModel: toolCallingEnabled,
    supportsReasoning: reasoningEnabled,
    settingsFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'string' },
      ...((reasoningParam || deepseekProfile) ? [{
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
          throw mapHttpError(response.status, bodyText, apiKey, response);
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
          .filter(entry => typeof entry?.id === 'string' && entry.id.trim())
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(entry => {
            const modelId = entry.id.trim();
            const capabilities = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
            const tools = typeof capabilities.tools === 'boolean' ? capabilities.tools
              : typeof entry.supports_tools === 'boolean' ? entry.supports_tools : null;
            const reasoning = typeof capabilities.reasoning === 'boolean' ? capabilities.reasoning : null;
            const streaming = typeof capabilities.streaming === 'boolean' ? capabilities.streaming : null;
            catalogCapabilities.set(modelId, { tools, reasoning, streaming });
            return { id: modelId, label: modelId,
              toolCalling: tools === null ? 'unverified' : tools ? 'supported' : 'unsupported',
              streaming: streaming === null ? 'unverified' : streaming ? 'supported' : 'unsupported',
              reasoning: reasoning === null ? 'unverified' : reasoning ? 'supported' : 'unsupported' };
          });
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
        let text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
            : '';
        const structured = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
        const hidden = guardInternalToolSyntax(text, hasDeepSeekToolContext(id, options), structured);
        if (structured && DSML_MARKERS.some(marker => text.includes(marker))) text = text.slice(0, text.length - hidden);
        requireResponseContinuation(choice?.message?.reasoning_content, body);
        return {
          text,
          ...(continuation(choice?.message?.reasoning_content, body.model) ? { modelContinuation: continuation(choice.message.reasoning_content, body.model) } : {}),
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
        let nativeReasoning = null;
        let emittedTextLength = 0;
        const guardDsml = hasDeepSeekToolContext(id, options);
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
          if (deepseekProfile && typeof delta?.reasoning_content === 'string') nativeReasoning = (nativeReasoning ?? '') + delta.reasoning_content;
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
            const held = guardInternalToolSyntax(fullText, guardDsml, true);
            const safeEnd = fullText.length - held;
            if (safeEnd > emittedTextLength) {
              pendingEvents.push(modelStreamEvent('assistant/chunk', { chunk: { type: 'text-delta', text: fullText.slice(emittedTextLength, safeEnd) } }));
              emittedTextLength = safeEnd;
            }
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
          const hidden = guardInternalToolSyntax(fullText, guardDsml, toolCalls.size > 0);
          if (toolCalls.size && DSML_MARKERS.some(marker => fullText.includes(marker))) fullText = fullText.slice(0, fullText.length - hidden);
          if (emittedTextLength < fullText.length) {
            yield modelStreamEvent('assistant/chunk', { chunk: { type: 'text-delta', text: fullText.slice(emittedTextLength) } });
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
        requireResponseContinuation(nativeReasoning, body);
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
          ...(continuation(nativeReasoning, body.model) ? { modelContinuation: continuation(nativeReasoning, body.model) } : {}),
          reason: { kind: 'completed', usage } });
      }
    }
  });
}

