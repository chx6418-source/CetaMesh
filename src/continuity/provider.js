// CetaMesh Continuity —— AgentProvider 抽象（阶段 09）。
//
// rollover / handoff 只依赖本接口，不直接依赖 DSH：
//   id
//   createContextSession({ taskId, bootstrapPrompt }) -> { sessionId }
//   sendPrompt(sessionId, text)
//   cancel(sessionId)
//   archiveSession(sessionId) -> { archived, supported, note? }   // 没有对应端点就如实 supported:false
//   estimateTokens({ promptChars, outputChars })                  // 无真实 usage 时的事前估算
//   usageFromEvent?(event)                                        // 有真实 usage 就钩出来，没有就不实现
//
// 当前唯一实现是 DSH；注册表机制让未来的其它 Agent Provider（Codex / ...）
// 无需改动 Continuity Runtime 即可接入（跨 Provider Handoff 走同一 Handoff Packet）。

import { continuityError } from './types.js';
import { selectDshSessionModel } from '../dsh-model-selection.js';

export function createProviderRegistry() {
  const providers = new Map();
  return {
    register(provider) {
      if (!provider || typeof provider !== 'object') throw continuityError('INVALID_PROVIDER', 'AgentProvider 必须是对象');
      for (const method of ['id', 'createContextSession', 'sendPrompt', 'cancel', 'archiveSession', 'estimateTokens']) {
        if (typeof provider[method] !== 'function' && method !== 'id') {
          throw continuityError('INVALID_PROVIDER', `AgentProvider 缺少 ${method}()`);
        }
      }
      providers.set(provider.id, provider);
      return provider;
    },
    get(id) {
      const provider = providers.get(String(id ?? ''));
      if (!provider) throw continuityError('PROVIDER_NOT_FOUND', '未注册的 Agent Provider：' + String(id));
      return provider;
    },
    ids() {
      return [...providers.keys()];
    }
  };
}

/**
 * DSH AgentProvider：用桥接 worker 既有的 NodeApiClient（同一鉴权/传输层），
 * 不新建第二套 DSH 通道。
 */
export function createDshAgentProvider({ api, defaults, now = () => Date.now() }) {
  if (!api?.callEndpoint) throw continuityError('INVALID_PROVIDER', 'createDshAgentProvider 需要 DSH api 客户端');
  let promptSeq = 0;
  return {
    id: 'dsh',
    defaults,
    async createContextSession({ taskId, bootstrapPrompt, model, reasoningEffort }) {
      const value = await api.callEndpoint('session/create', { request: {} });
      const sessionId = String(value?.sessionId ?? '');
      if (!sessionId) throw continuityError('PROVIDER_ERROR', 'DSH 未返回 sessionId');
      // 按任务/提供方配置绑定模型；失败不回滚会话（模型可后续重绑），但要如实抛出。
      const provider = defaults?.provider ?? 'deepseek-official';
      const modelId = model ?? defaults?.model;
      if (modelId) {
        // provider 可能是历史配置值（如 llm-deepseek）：仅在 NO_ADAPTER 时按目录解析重试。
        await selectDshSessionModel(api, {
          sessionId,
          provider,
          model: modelId,
          reasoningEffort: reasoningEffort ?? defaults?.reasoningEffort ?? 'max'
        });
      }
      if (bootstrapPrompt) {
        await this.sendPrompt(sessionId, bootstrapPrompt);
      }
      return { sessionId, providerId: 'dsh' };
    },
    async sendPrompt(sessionId, text) {
      promptSeq += 1;
      await api.callEndpoint('session/prompt', {
        request: {
          requestId: `cetamesh-cont-${now().toString(36)}-${promptSeq}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }]
        }
      });
      return { accepted: true };
    },
    async cancel(sessionId) {
      await api.callEndpoint('session/cancel', { request: { sessionId } });
      return { cancelled: true };
    },
    async archiveSession(sessionId) {
      // DSH 0.1.5 没有按单会话归档的端点（只有 workspace/archiveSession）。
      // “结束旧 Session”的语义由 detach + 不再复用实现；这里如实报告能力边界。
      return { archived: false, supported: false, sessionId, note: 'DSH 无单会话归档端点；由 detach + 不复用实现语义' };
    },
    estimateTokens({ promptChars = 0, outputChars = 0, charsPerToken = 4 }) {
      const divisor = charsPerToken > 0 ? charsPerToken : 4;
      return Math.ceil((promptChars + outputChars) / divisor);
    }
  };
}
