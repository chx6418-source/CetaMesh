// CetaMesh Continuity Runtime 公共出口（阶段 09）。
export { createContinuityService, createProviderRegistry, createDshAgentProvider, createContextMonitor } from './service.js';
export {
  CONTEXT_BANDS,
  DEFAULT_CONTEXT_POLICY,
  HANDOFF_REASONS,
  PACKET_LIMITS,
  bandFor,
  continuityError,
  normalizePacket,
  normalizePolicy,
  normalizeReason
} from './types.js';
