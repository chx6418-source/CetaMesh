// Smart Router 服务（会话 1 / TASK-S1-005/006）。
//
// Cost Policy 持久化在 <stateDir>/router/policy.json（走统一 Storage Primitive 原子写；
// 损坏回落默认值——策略文件不是关键数据，不 fail-closed 阻塞聊天）。
// router.* 是桌面私有方法族：policy.get / policy.set / classify。
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { classifyTask, costPolicies } from './smart-router.js';
import { DEFAULT_COST_POLICY, normalizeCostPolicy, normalizeDecision, routerError } from './types.js';

const POLICY_SCHEMA_VERSION = 1;

export function createRouterService({ stateDir, log = () => {} } = {}) {
  if (!stateDir) throw new Error('createRouterService 需要 stateDir');
  const file = path.join(stateDir, 'router', 'policy.json');

  function readPolicy() {
    try {
      const parsed = readJsonFile(file);
      return normalizeCostPolicy(parsed?.costPolicy);
    } catch (error) {
      if (error?.code === 'INVALID_PARAMS') throw error;
      // 缺失 / 损坏 → 回落默认（策略文件不是关键数据，不 fail-closed 阻塞聊天）。
      return DEFAULT_COST_POLICY;
    }
  }

  function writePolicy(policy) {
    writeJsonAtomic(file, { schemaVersion: POLICY_SCHEMA_VERSION, costPolicy: policy });
  }

  function classify(params = {}) {
    const decision = classifyTask({
      text: params?.text,
      attachments: Array.isArray(params?.attachments) ? params.attachments : [],
      hasWorkspaceContext: params?.hasWorkspaceContext === true,
      agentEnabled: params?.agentEnabled !== false,
      costPolicy: params?.costPolicy !== undefined && params.costPolicy !== null && params.costPolicy !== ''
        ? normalizeCostPolicy(params.costPolicy)
        : readPolicy()
    });
    return { decision: normalizeDecision(decision) };
  }

  const handlers = {
    'router.policy.get': () => ({ costPolicy: readPolicy(), options: costPolicies(), default: DEFAULT_COST_POLICY }),
    'router.policy.set': (params) => {
      const policy = normalizeCostPolicy(params?.costPolicy);
      writePolicy(policy);
      log(`Smart Router Cost Policy → ${policy}`);
      return { costPolicy: policy, options: costPolicies() };
    },
    'router.classify': (params) => classify(params)
  };

  return {
    /** 供 chat-service 进程内调用：以当前持久化策略做确定性路由。 */
    classify,
    currentPolicy: readPolicy,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(routerError('METHOD_NOT_FOUND', `未知 Router 方法：${String(method ?? '')}`));
      }
      return Promise.resolve().then(() => handler(params ?? {}));
    }
  };
}
