// DSH Agent Provider（阶段 06；会话 2 起作为 Agent Broker 的第一个真实 Provider）：
// 把 DSH 0.1.5 Typert 网关映射到标准 AgentProvider 契约。
//
// 复用现有 src/dsh-client.js 的 NodeApiClient（由 Desktop composition root 注入共享实例，不重写、不另建连接）。
// 端点映射（均以本仓库真实调用与 2026-10-04 对运行中 DSH 的探测为准）：
//   createSession  → session/create（+ 可选 session/selectModel 绑定模型）
//   send           → session/prompt（requestId/mode/content 内容块数组）
//   cancel         → session/cancel（探测确认端点存在：假 sessionId 返回业务错 session/not-found）
//   status         → session/list 投影（running/blank/updatedAt/title）
//   contextUsage   → session/list 投影的 tokenUsage / contextPressure（旧会话可能无投影 → available:false）
//   resume         → session/list 存在性校验（DSH 会话持久于 DSH 侧，可重新挂载）
//   closeSession   → workspace/archiveSession
//   follow         → session/follow 流（turn/start / assistant/chunk / assistant/message / turn/end）
//   selectModel    → session/selectModel
//   health         → settings/describe（3s 超时；DSH 未启动时的优雅降级依据）
//   archiveSession / nativeCheckpoint / nativeHandoff → 不支持：DSH 无对应端点
//   （checkpoint 实测 HTTP 404、无跨 Provider 交接协议），由契约桩显式拒绝；
//   Broker 包装为 { supported:false, reason:'UNSUPPORTED' }，绝不伪造。
//
// rolloverStrategy：DSH 无原生压缩/续接能力，上下文临限时的推荐策略是"开新会话"。
import crypto from 'node:crypto';
import { agentProviderError, defineAgentProvider, normalizePromptContent, AGENT_EVENT_PROTOCOL_DSH } from './agent-provider.js';
import { selectDshSessionModel } from '../dsh-model-selection.js';

const CALL_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * 传输层失败 → PROVIDER_UNAVAILABLE（DSH 未启动/断连，调用方据此优雅降级）；
 * 其他失败（业务错误、协议错误）→ PROVIDER_ERROR。业务错误码（如 session/not-found）
 * 由调用方在更外层先判别，不经过这里。
 */
function wrapDshError(error, label) {
  const message = String(error?.message ?? error);
  const transport = /传输失败|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|WebSocket 错误|socket hang up|TIMEOUT/i.test(message);
  return agentProviderError(transport ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', `${label}：${message}`, { cause: error });
}

export function createDshAgentProvider({ api, defaults = {}, log = () => {} } = {}) {
  if (!api || typeof api.callEndpoint !== 'function' || typeof api.openRemoteStream !== 'function') {
    throw new Error('createDshAgentProvider 需要注入 dsh-client.js 的 NodeApiClient 实例');
  }
  const dshDefaults = {
    provider: String(defaults.provider ?? 'deepseek-official'),
    model: defaults.model ? String(defaults.model) : null,
    reasoningEffort: defaults.reasoningEffort ? String(defaults.reasoningEffort) : null
  };

  /** session/list 单条投影；找不到返回 null（不抛错，由调用方决定语义）。 */
  async function findSessionItem(sessionId) {
    let value;
    try {
      value = await api.callEndpoint('session/list', { _request: {} }, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      throw wrapDshError(error, '读取 DSH 会话列表失败');
    }
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.find((item) => item?.sessionId === sessionId) ?? null;
  }

  function requireSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw agentProviderError('INVALID_PARAMS', 'sessionId 不能为空');
    }
    return sessionId.trim();
  }

  return defineAgentProvider({
    id: 'dsh',
    label: 'DSH Agent',
    eventProtocol: AGENT_EVENT_PROTOCOL_DSH,
    capabilityExtras: {
      rolloverStrategy: {
        preferred: 'fresh-session',
        note: 'DSH 无原生压缩/续接端点：上下文临限时优先结束旧会话并开新会话（Bootstrap 结构化恢复）'
      }
    },
    methods: {
      async createSession({ cwd, model, reasoningEffort, modelProvider } = {}) {
        const request = {};
        if (cwd !== undefined && cwd !== null && String(cwd).trim()) request.cwd = String(cwd);
        let value;
        try {
          value = await api.callEndpoint('session/create', { request }, AbortSignal.timeout(CALL_TIMEOUT_MS));
        } catch (error) {
          throw wrapDshError(error, '创建 DSH 会话失败');
        }
        const sessionId = String(value?.sessionId ?? '');
        if (!sessionId) throw agentProviderError('PROVIDER_ERROR', 'DSH 未返回 sessionId');
        // 模型绑定：显式入参优先，其次 bridge 默认模型（与 QQ 桥接 ensureSessionModel 行为一致）。
        // 绑定失败不丢弃会话：返回 modelBindingError，调用方可 resume 后重试或换模型。
        const wantModel = model !== undefined && model !== null ? String(model) : dshDefaults.model;
        let bound = null;
        let modelBindingError = null;
        if (wantModel) {
          try {
            const { value: result } = await selectDshSessionModel(api, {
              sessionId,
              provider: String(modelProvider ?? dshDefaults.provider),
              model: wantModel,
              reasoningEffort: String(reasoningEffort ?? dshDefaults.reasoningEffort ?? 'max')
            }, { timeoutMs: CALL_TIMEOUT_MS, log });
            bound = result?.selected ?? null;
          } catch (error) {
            modelBindingError = String(error?.message ?? error);
            log(`DSH Agent Provider 模型绑定失败（会话已创建 ${sessionId}）：${modelBindingError}`);
          }
        }
        return {
          sessionId,
          provider: 'dsh',
          model: bound?.model ?? wantModel,
          modelBindingError
        };
      },

      async send({ sessionId, content, mode = 'queue' } = {}) {
        const sid = requireSessionId(sessionId);
        const blocks = normalizePromptContent(content);
        const requestId = `cetamesh-agent-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        let value;
        try {
          value = await api.callEndpoint('session/prompt', {
            request: { requestId, sessionId: sid, mode, content: blocks }
          }, AbortSignal.timeout(CALL_TIMEOUT_MS));
        } catch (error) {
          throw wrapDshError(error, '提交回合失败');
        }
        return { accepted: true, requestId, sessionId: sid, value: value ?? null };
      },

      async cancel({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        try {
          await api.callEndpoint('session/cancel', { request: { sessionId: sid } }, AbortSignal.timeout(LIST_TIMEOUT_MS));
          return { cancelled: true, sessionId: sid };
        } catch (error) {
          if (String(error?.message ?? error).includes('session/not-found')) {
            throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`, { cause: error });
          }
          throw wrapDshError(error, '取消未确认');
        }
      },

      async status({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`);
        return {
          sessionId: sid,
          provider: 'dsh',
          running: item.running === true,
          blank: item.blank === true,
          updatedAt: item.updatedAt ?? null,
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
          title: item.projections?.values?.title ?? null
        };
      },

      async contextUsage({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`);
        const values = item.projections?.values ?? {};
        if (!values.tokenUsage && !values.contextPressure) {
          // 旧会话投影未计算（asOfSeq=-1）：如实上报不可用，禁止伪造 0 值。
          return { sessionId: sid, provider: 'dsh', available: false };
        }
        return {
          sessionId: sid,
          provider: 'dsh',
          available: true,
          tokenUsage: values.tokenUsage ?? null,
          contextPressure: values.contextPressure ?? null
        };
      },

      async resume({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `无法恢复：会话不存在：${sid}`);
        log(`DSH Agent Provider 恢复会话：${sid}（running=${item.running === true}）`);
        return {
          resumed: true,
          sessionId: sid,
          provider: 'dsh',
          running: item.running === true,
          updatedAt: item.updatedAt ?? null
        };
      },

      async closeSession({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        try {
          await api.callEndpoint('workspace/archiveSession', { request: { sessionId: sid } }, AbortSignal.timeout(LIST_TIMEOUT_MS));
          return { closed: true, sessionId: sid };
        } catch (error) {
          if (String(error?.message ?? error).includes('session/not-found')) {
            throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`, { cause: error });
          }
          throw wrapDshError(error, '关闭会话失败');
        }
      },

      // 直接返回 async iterable（不包 async 包装，消费方 for await 即可）：
      // 事件流是有状态资源，调用方负责用 signal 中止。
      follow({ sessionId, signal } = {}) {
        const sid = requireSessionId(sessionId);
        return api.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId: sid } } }, { signal });
      },

      async selectModel({ sessionId, model, reasoningEffort, modelProvider } = {}) {
        const sid = requireSessionId(sessionId);
        if (!model) throw agentProviderError('INVALID_PARAMS', 'selectModel 需要 model');
        let value;
        try {
          ({ value } = await selectDshSessionModel(api, {
            sessionId: sid,
            provider: String(modelProvider ?? dshDefaults.provider),
            model: String(model),
            reasoningEffort: String(reasoningEffort ?? dshDefaults.reasoningEffort ?? 'max')
          }, { timeoutMs: CALL_TIMEOUT_MS, log }));
        } catch (error) {
          throw wrapDshError(error, '绑定模型失败');
        }
        return { sessionId: sid, selected: value?.selected ?? null };
      },

      async health() {
        try {
          await api.callEndpoint('settings/describe', {}, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
          return { available: true, provider: 'dsh' };
        } catch (error) {
          return { available: false, provider: 'dsh', reason: String(error?.message ?? error) };
        }
      }
    }
  });
}
