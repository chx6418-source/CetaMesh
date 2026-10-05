// CetaMesh Continuity Runtime 公共出口（阶段 09；会话 2 收口）。
// 窄接口 AgentProvider（createProviderRegistry / continuity 侧 createDshAgentProvider）
// 已移除：唯一正式契约在 src/agent/，会话操作一律经 Agent Broker。
export { createContinuityService, createContextMonitor, createWorkspaceReconciler } from './service.js';
export {
  CONTEXT_BANDS,
  DEFAULT_CONTEXT_POLICY,
  HANDOFF_REASONS,
  PACKET_LIMITS,
  ROLLOVER_STRATEGIES,
  IMPLEMENTED_ROLLOVER_STRATEGY,
  bandFor,
  continuityError,
  normalizePacket,
  normalizePolicy,
  normalizeReason
} from './types.js';
