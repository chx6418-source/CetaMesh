// CetaMesh Memory v1 —— 旧 QQ / socialV2 记忆的只读 Adapter（阶段 04）。
//
// 定位：QQ 是 Channel Adapter，不是 Core 中心。本文件是唯一认识 QQ 存储格式的地方，
// 把 state/social-v2.json 的 activeTopic / pendingThought / memberImpression 只读映射成
// CetaMesh Memory 记录，再经统一 Memory Runtime 落库；Runtime 本身不依赖 QQ。
//
// 硬约束：
// - 绝不修改、绝不删除 social-v2.json（测试用导入前后字节比对证明）；
// - 导入幂等：每条记录带稳定 origin.ref，已导入的跳过；
// - 旧 QQ Memory 的功能与数据都保留，Adapter 只是多一条进入统一 Memory 的通道。

import fs from 'node:fs';
import crypto from 'node:crypto';
import { memoryError } from '../types.js';

export const QQ_CATEGORY_TO_TYPE = Object.freeze({
  activeTopic: 'chat',
  pendingThought: 'working',
  memberImpression: 'user'
});

/** QQ 会话键（group:123 / private:456）→ CetaMesh chat Scope。 */
export function qqScopeForConversation(conversationKey) {
  const safe = String(conversationKey === null || conversationKey === undefined ? '' : conversationKey)
    .trim()
    .replace(/[:\s/\\]+/g, '-');
  return 'chat:qq-' + safe;
}

function refFor(conversationKey, category, identity) {
  const hash = crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 12);
  return 'qq:' + conversationKey + ':' + category + ':' + hash;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw memoryError('ADAPTER_READ_FAILED', 'QQ 记忆读取失败：' + file);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw memoryError('ADAPTER_READ_FAILED', 'QQ 记忆解析失败：' + file);
  }
}

/**
 * 纯读取映射：不改动源文件，不落库。
 * 返回 { source, entries: [{ ref, type, scope, content, tags, details, updatedAt }] }。
 */
export function readQqMemory(socialV2File, { now = () => Date.now() } = {}) {
  const raw = readJson(socialV2File);
  const conversations = raw && typeof raw === 'object' && raw.conversations && typeof raw.conversations === 'object'
    ? raw.conversations
    : {};
  const entries = [];
  const nowMs = now();

  for (const conversationKey of Object.keys(conversations)) {
    const state = conversations[conversationKey];
    if (!state || typeof state !== 'object') continue;
    const scope = qqScopeForConversation(conversationKey);

    for (const topic of Array.isArray(state.activeTopics) ? state.activeTopics : []) {
      const text = String(topic && topic.text ? topic.text : '').trim();
      if (!text) continue;
      const participants = Array.isArray(topic.participants) ? topic.participants.map(String).slice(0, 5) : [];
      entries.push({
        ref: refFor(conversationKey, 'activeTopic', text),
        type: QQ_CATEGORY_TO_TYPE.activeTopic,
        scope,
        content: text.slice(0, 200),
        tags: ['qq', 'activeTopic', ...participants],
        details: {
          conversation: conversationKey,
          category: 'activeTopic',
          lastMentionAt: Number(topic.lastMentionAt) || null,
          pendingQuestion: topic.pendingQuestion ? String(topic.pendingQuestion).slice(0, 200) : null
        },
        updatedAt: Number(topic.lastMentionAt) || null
      });
    }

    for (const thought of Array.isArray(state.pendingThoughts) ? state.pendingThoughts : []) {
      const text = String(thought && thought.text ? thought.text : '').trim();
      if (!text) continue;
      const expiresAt = Number(thought.expiresAt) || 0;
      // 已过期的短期想法不导入：它们在桥接侧也已失效。
      if (expiresAt && nowMs >= expiresAt) continue;
      const motivation = thought.motivation ? String(thought.motivation).slice(0, 40) : '';
      entries.push({
        ref: refFor(conversationKey, 'pendingThought', text),
        type: QQ_CATEGORY_TO_TYPE.pendingThought,
        scope,
        content: text.slice(0, 200),
        tags: ['qq', 'pendingThought', ...(motivation ? [motivation] : [])],
        details: {
          conversation: conversationKey,
          category: 'pendingThought',
          motivation: motivation || null,
          expiresAt: expiresAt || null
        },
        updatedAt: Number(thought.createdAt) || null
      });
    }

    const impressions = state.memberImpressions && typeof state.memberImpressions === 'object'
      ? state.memberImpressions
      : {};
    for (const name of Object.keys(impressions)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
      const impression = impressions[name] && typeof impressions[name] === 'object' ? impressions[name] : {};
      const traits = Array.isArray(impression.traits) ? impression.traits.map(String).filter(Boolean) : [];
      entries.push({
        ref: refFor(conversationKey, 'memberImpression', name),
        type: QQ_CATEGORY_TO_TYPE.memberImpression,
        scope,
        content: (traits.length ? traits.join('、') : '暂无记录').slice(0, 400),
        tags: ['qq', 'memberImpression', name],
        details: {
          conversation: conversationKey,
          category: 'memberImpression',
          target: name,
          interactionCount: Number(impression.interactionCount) || 0
        },
        updatedAt: null
      });
    }
  }

  return { source: socialV2File, entries };
}

export function createQqMemoryAdapter({ socialV2File, now = () => Date.now() } = {}) {
  if (!socialV2File || typeof socialV2File !== 'string') {
    throw new Error('createQqMemoryAdapter 需要 socialV2File');
  }
  return {
    socialV2File,
    read() {
      return readQqMemory(socialV2File, { now });
    },
    /**
     * 经统一 Memory Runtime 导入。principal 必须是用户主体：
     * 导入属于长期记忆写入，Agent 不得静默完成。
     */
    importInto({ runtime, principal, dryRun = false } = {}) {
      if (!runtime || typeof runtime.create !== 'function') {
        throw new Error('importInto 需要 Memory Runtime');
      }
      const { entries } = readQqMemory(socialV2File, { now });
      const known = new Set(runtime.listOriginRefs({ principal, adapter: 'qq' }).refs);
      const imported = [];
      const skipped = [];
      for (const entry of entries) {
        if (known.has(entry.ref)) {
          skipped.push(entry.ref);
          continue;
        }
        if (dryRun) {
          imported.push({ ref: entry.ref, dryRun: true });
          continue;
        }
        const memory = runtime.create({
          principal,
          type: entry.type,
          scope: entry.scope,
          content: entry.content,
          tags: entry.tags,
          source: 'qq-adapter',
          originRef: entry.ref
        });
        known.add(entry.ref);
        imported.push({ ref: entry.ref, id: memory.id });
      }
      return {
        source: socialV2File,
        scanned: entries.length,
        imported: imported.length,
        skipped: skipped.length,
        dryRun,
        details: { imported, skipped }
      };
    }
  };
}
