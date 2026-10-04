// CetaMesh Memory v1 —— 统一 Memory Runtime 公共入口（阶段 04）。
export { createMemoryService, DESKTOP_USER_PRINCIPAL } from './service.js';
export { createMemoryRuntime } from './runtime.js';
export { createMemoryStore, MEMORY_SCHEMA_VERSION } from './store.js';
export {
  createMemoryPolicy,
  MEMORY_ACTIONS,
  AGENT_DEFAULT_READ_TYPES,
  AGENT_DEFAULT_WRITE_TYPES
} from './policy.js';
export {
  createQqMemoryAdapter,
  readQqMemory,
  qqScopeForConversation,
  QQ_CATEGORY_TO_TYPE
} from './adapters/qq.js';
export {
  LONG_TERM_TYPES,
  MEMORY_LIMITS,
  MEMORY_SOURCES,
  MEMORY_TYPES,
  SCOPE_KINDS,
  isLongTermType,
  isMemoryType,
  memoryError,
  normalizeScope,
  scopeKey
} from './types.js';
