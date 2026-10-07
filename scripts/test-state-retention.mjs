// D12 State Retention 行为测试。
// 覆盖：日志大小轮转、social-v2 会话缓冲 TTL / 总量上限（wakeConfig 保留）、
// 卡片缓存 TTL/上限、已决策候选淘汰（pending 绝不清）、长期记忆不受日志式清理影响。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateLogFileBySize } from '../src/logging/rotate.js';
import { applySocialConversationRetention, applySocialCardRetention } from '../src/social-retention.js';
import { pruneDecidedCandidates } from '../src/memory/runtime.js';
import { createMemoryStore } from '../src/memory/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function assert(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`✅ ${label}`);
  } else {
    failed = 1;
    console.error(`❌ ${label}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `state-retention-`));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// ── 1. bridge.log 大小轮转 ───────────────────────────────────────────────────
{
  const dir = freshDir();
  const logFile = path.join(dir, 'bridge.log');
  assert(rotateLogFileBySize(logFile, { maxBytes: 1024 }) === false, '日志不存在时不轮转');

  fs.writeFileSync(logFile, 'x'.repeat(2048), 'utf8');
  assert(rotateLogFileBySize(logFile, { maxBytes: 1024 }) === true, '超限触发轮转');
  assert(fs.readFileSync(path.join(dir, 'bridge.log.1'), 'utf8').length === 2048, '旧日志整体挪到 bridge.log.1');

  fs.writeFileSync(logFile, 'new line\n', 'utf8');
  assert(rotateLogFileBySize(logFile, { maxBytes: 1024 }) === false, '新活跃文件低于阈值不再轮转');

  // 第二次轮转应替换上一代 .1（最多保留 1 MiB × 2）
  fs.writeFileSync(logFile, 'y'.repeat(2048), 'utf8');
  assert(rotateLogFileBySize(logFile, { maxBytes: 1024 }) === true, '再次轮转成功');
  assert(fs.readFileSync(path.join(dir, 'bridge.log.1'), 'utf8')[0] === 'y', '新一代 .1 替换上一代（日志总量有界）');
}

// ── 2. social-v2 会话保留：TTL 清缓冲、配置保留、总量上限 ────────────────────
{
  const conversations = {
    'group:100': {
      wakeConfig: { enabled: true }, lastIncomingAt: NOW - 30 * DAY, lastAiReplyAt: NOW - 30 * DAY,
      recentMessages: [{ text: 'old' }], unread: [{ text: 'u' }], activeTopics: ['t'], pendingThoughts: [{ text: 'p' }],
      memberImpressions: { u1: { traits: ['x'] } }, seenForwardIds: ['f1'], wakeTimes: [1], sendTimes: [2], stickerCollectTimes: [3]
    },
    'group:200': {
      wakeConfig: { enabled: false }, lastIncomingAt: NOW - 1 * 60 * 1000,
      recentMessages: [{ text: 'fresh' }], unread: []
    },
    'private:300': {
      // 从未活跃（时间戳全 0）：不应被 TTL 误伤，也不应作为“最活跃”参与排序
      wakeConfig: { enabled: true }
    }
  };
  const stats = applySocialConversationRetention(conversations, { now: NOW, messageTtlMs: 14 * DAY, maxConversations: 500 });
  assert(stats.staleCleared === 1, '恰好一个超 TTL 会话被清缓冲');
  const stale = conversations['group:100'];
  assert(stale.recentMessages.length === 0 && stale.unread.length === 0 && stale.seenForwardIds.length === 0, '超 TTL 会话的消息性缓冲被清空');
  assert(stale.wakeConfig?.enabled === true, '超 TTL 会话的 wakeConfig（用户配置）保留');
  assert(conversations['group:200'].recentMessages.length === 1, '活跃会话完全不动');
  assert(conversations['private:300'].wakeConfig?.enabled === true, '零时间戳会话不被误清');

  // 总量上限：最不活跃的整体丢弃（含 wakeConfig），并在结果中如实计数
  const many = {};
  for (let i = 0; i < 8; i++) {
    many[`group:${i}`] = { wakeConfig: { i }, lastIncomingAt: NOW - i * DAY, recentMessages: [{ text: 'm' }] };
  }
  const capped = applySocialConversationRetention(many, { now: NOW, messageTtlMs: 14 * DAY, maxConversations: 5 });
  assert(capped.dropped === 3, `超出上限的 3 个最不活跃会话被整体丢弃（实际 ${capped.dropped}）`);
  assert(Object.keys(many).length === 5, '会话总数收敛到 maxConversations');
  assert(('group:0' in many) && !('group:7' in many), '丢弃的是最旧活动，保留最近活动');
}

// ── 3. 卡片缓存保留：TTL + 上限（cache 语义，可回源） ────────────────────────
{
  const conversations = {
    'group:100': { ref1: [{ raw: 'r1', time: NOW - 30 * DAY }] },
    'group:200': { ref2: [{ raw: 'r2', time: NOW - 1 * 60 * 1000 }] },
    'group:300': { ref3: [{ raw: 'r3' }] } // 无时间戳（旧版本数据）→ 视为最旧，仅参与总量淘汰
  };
  applySocialCardRetention(conversations, { now: NOW, cardTtlMs: 7 * DAY, maxCardConversations: 300 });
  assert(!('group:100' in conversations), '超 7 天的卡片会话缓存被移除');
  assert('group:200' in conversations, '新鲜卡片缓存保留');
  assert('group:300' in conversations, '无时间戳数据不被 TTL 误删（仅总量淘汰兜底）');

  const many = {};
  for (let i = 0; i < 6; i++) {
    many[`group:${i}`] = { [`ref${i}`]: [{ raw: 'r', time: NOW - i * DAY }] };
  }
  const stats = applySocialCardRetention(many, { now: NOW, cardTtlMs: 7 * DAY, maxCardConversations: 3 });
  assert(stats.dropped === 3 && Object.keys(many).length === 3, '卡片缓存总量上限生效（最旧优先）');
}

// ── 4. Memory 候选：已决策流水淘汰，pending 绝不自动清 ───────────────────────
{
  const list = [
    { id: 'p1', status: 'pending', decidedAt: null },
    { id: 'd1', status: 'accepted', decidedAt: NOW - 10 * DAY },
    { id: 'd2', status: 'accepted', decidedAt: NOW - 9 * DAY },
    { id: 'd3', status: 'rejected', decidedAt: NOW - 8 * DAY }
  ];
  const pruned = pruneDecidedCandidates(list);
  assert(pruned.some((c) => c.id === 'p1'), 'pending 候选永不被保留策略清除');
  const beyondCap = [
    ...Array.from({ length: 205 }, (_, i) => ({ id: `a${i}`, status: 'accepted', decidedAt: NOW - (400 - i) * DAY })),
    { id: 'p2', status: 'pending', decidedAt: null }
  ];
  const pruned2 = pruneDecidedCandidates(beyondCap);
  assert(pruned2.length === 201, `已决策候选收敛到 200 + pending 1（实际 ${pruned2.length}）`);
  assert(pruned2.some((c) => c.id === 'p2'), '大量已决策流水被淘汰时 pending 仍然保留');
  assert(pruned2.every((c) => c.id !== 'a0'), '淘汰的是最旧的已决策候选');
}

// ── 5. 长期记忆不受日志式清理影响（红线） ────────────────────────────────────
{
  const dir = freshDir();
  const store = createMemoryStore({ stateDir: dir });
  for (let i = 0; i < 50; i++) {
    store.insert({
      id: `mem_${i}`, type: 'user', scope: { kind: 'global', id: '' }, scopeKey: 'global:',
      content: '长期记忆 ' + i, tags: [], createdAt: NOW - i * DAY, updatedAt: NOW - i * DAY, rev: 1, pinned: false
    });
  }
  const reloaded = createMemoryStore({ stateDir: dir });
  reloaded.load();
  assert(reloaded.count() === 50, '50 条旧时间戳记忆原样保留（无 TTL / 无日志式清理）');
  assert(reloaded.scanAuthorized(['global:']).length === 50, '全部记录仍可按授权分区检索');
}

console.log(failed ? `\n❌ ${passed} 通过，存在失败项` : `\n🎉 State Retention 全部通过（${passed} 组）`);
process.exit(failed ? 1 : 0);
