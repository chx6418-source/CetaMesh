// CetaMesh Memory v1 —— 桌面 Memory 服务（阶段 04）。
//
// 分层：IPC(memory.*) → 本模块（主体绑定 + 方法白名单）→ Memory Runtime。
// 安全前提：memory.* 只经桌面 Shell 的命名管道暴露（bridge.js 的 startUiIpcServer），
// 该通道本身就是用户级控制面；因此这里把主体固定为用户，**不接受调用方自带 principal**，
// 避免通过 IPC 伪造用户身份。Agent 侧只能走 runtime.proposeCandidate（候选，需用户确认）。

import path from 'node:path';
import { createMemoryRuntime } from './runtime.js';
import { createQqMemoryAdapter } from './adapters/qq.js';
import { memoryError } from './types.js';

export const DESKTOP_USER_PRINCIPAL = Object.freeze({ kind: 'user', id: 'desktop' });

export function createMemoryService({ stateDir, socialV2File, now, audit } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMemoryService 需要 stateDir');
  const runtime = createMemoryRuntime({ stateDir, now, audit });
  const adapter = createQqMemoryAdapter({
    socialV2File: socialV2File || path.join(stateDir, 'social-v2.json'),
    now
  });
  const user = DESKTOP_USER_PRINCIPAL;

  const handlers = {
    'memory.list': (p) => runtime.list({
      principal: user, scope: p.scope, types: p.types, pinned: p.pinned, query: p.query, limit: p.limit
    }),
    'memory.search': (p) => runtime.search({
      principal: user, scope: p.scope, types: p.types, pinned: p.pinned, query: p.query, limit: p.limit
    }),
    'memory.get': (p) => runtime.get({ principal: user, id: p.id }),
    'memory.create': (p) => runtime.create({
      principal: user, type: p.type, scope: p.scope, content: p.content,
      tags: p.tags, source: p.source, pinned: p.pinned
    }),
    'memory.update': (p) => runtime.update({
      principal: user, id: p.id, expectedRev: p.expectedRev, content: p.content, tags: p.tags, pinned: p.pinned
    }),
    'memory.delete': (p) => runtime.remove({ principal: user, id: p.id, expectedRev: p.expectedRev }),
    'memory.pin': (p) => runtime.update({
      principal: user, id: p.id, expectedRev: p.expectedRev, pinned: p.pinned !== false
    }),
    // 页面级聚合查询：一次 IPC 往返拿到列表 + 候选（UI 只挂一个 Area，避免并发 issue 互斥）。
    'memory.overview': (p) => {
      const list = runtime.list({
        principal: user, scope: p.scope, types: p.types, pinned: p.pinned, query: p.query, limit: p.limit
      });
      const candidates = runtime.listCandidates({ principal: user, status: p.candidateStatus });
      return { memories: list.memories, meta: list.meta, candidates: candidates.candidates };
    },
    'memory.stats': () => runtime.stats({ principal: user }),
    'memory.candidates.list': (p) => runtime.listCandidates({ principal: user, status: p.status }),
    // Chat 模型提出候选：以受限 Agent 主体登记；此时并未写入任何长期记忆。
    'memory.candidates.propose': (p) => runtime.proposeCandidate({
      principal: {
        kind: 'agent',
        id: String(p.agentId === undefined || p.agentId === null ? 'chat' : p.agentId),
        grants: { scopes: Array.isArray(p.scopes) ? p.scopes : [] }
      },
      type: p.type, scope: p.scope, content: p.content, reason: p.reason
    }),
    // 长期写入的唯一入口：用户明确确认。
    'memory.candidates.confirm': (p) => runtime.confirmCandidate({
      principal: user, id: p.id, decision: p.decision, content: p.content, pinned: p.pinned
    }),
    'memory.adapters.qq.import': (p) => adapter.importInto({
      runtime, principal: user, dryRun: p.dryRun === true
    })
  };

  return {
    stateDir,
    runtime,
    adapter,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(memoryError('METHOD_NOT_FOUND', '未知 Memory 方法：' + String(method)));
      }
      // 统一异步语义：同步 handler 的 throw 也转成 rejected Promise。
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() {}
  };
}
