// CetaMesh Persistent Task v1 —— 公共入口（阶段 07）。
export { createTaskService } from './service.js';
export { createTaskRuntime } from './runtime.js';
export { createTaskStore, TASK_SCHEMA_VERSION } from './store.js';
export {
  ATTENTION_STATUSES,
  TASK_LIMITS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTaskStatus,
  isTerminalStatus,
  needsAttention,
  taskError
} from './types.js';
