// D12 State Retention —— Social v2 运行状态的保留策略（纯函数，可独立测试）。
//
// 原则（与本项目 D12 红线一致）：
// - 消息缓冲 / 话题 / 印象属于「会话运行痕迹」，可以按 TTL 淘汰；
// - wakeConfig 等用户显式配置不属于运行痕迹，即使会话长期不活跃也不清；
// - 会话总数有硬上限兜底：超出时从「最不活跃」的会话开始整体丢弃（含 wakeConfig），
//   阈值取得宽（月级 TTL / 数百会话），正常用户永远触不到；
// - Long-Term Memory（memories.json）与这里无关，绝不适用日志式清理。
//
// 输入是 saveSocialV2State / saveMessageCardStore 组装好的纯数据对象，
// 本模块只做删减，不碰文件系统，便于对同一份状态做行为化断言。

const DAY_MS = 24 * 60 * 60 * 1000;

export const SOCIAL_RETENTION_DEFAULTS = Object.freeze({
  /** 会话消息缓冲的保留窗口：14 天不活跃的会话不再持久化消息缓冲。 */
  messageTtlMs: 14 * DAY_MS,
  /** 持久化会话总数硬上限（含休眠会话；超出从最不活跃开始整体丢弃）。 */
  maxConversations: 500,
  /** 卡片缓存（按会话）的保留窗口：7 天未活动的会话不再持久化卡片原文。 */
  cardTtlMs: 7 * DAY_MS,
  /** 卡片缓存会话数硬上限。 */
  maxCardConversations: 300
});

/** 会话的「最近活动时间」：收发、AI 回复、主动动作三者取最大。 */
function lastActivityOf(entry) {
  return Math.max(
    Number(entry?.lastIncomingAt) || 0,
    Number(entry?.lastAiReplyAt) || 0,
    Number(entry?.lastActionAt) || 0
  );
}

/** 卡片缓存条目没有时间戳时退化为 0（视为最旧，优先淘汰；卡片本就是可回源的缓存）。 */
function lastCardActivityOf(refs) {
  let latest = 0;
  for (const cards of Object.values(refs ?? {})) {
    for (const card of Array.isArray(cards) ? cards : []) {
      latest = Math.max(latest, Number(card?.time) || 0);
    }
  }
  return latest;
}

/**
 * social-v2.json 保留策略（原地修改传入的 conversations 对象）：
 * 1) 超过 messageTtlMs 未活跃的会话：清空消息性缓冲（recentMessages / unread /
 *    activeTopics / pendingThoughts / memberImpressions / seenForwardIds / wakeTimes /
 *    sendTimes / stickerCollectTimes），保留 wakeConfig 与标量状态；
 * 2) 总数超过 maxConversations：按最近活动从旧到新整体删除。
 */
export function applySocialConversationRetention(conversations, options = {}) {
  const {
    now = Date.now(),
    messageTtlMs = SOCIAL_RETENTION_DEFAULTS.messageTtlMs,
    maxConversations = SOCIAL_RETENTION_DEFAULTS.maxConversations
  } = options;
  if (!conversations || typeof conversations !== 'object') return { staleCleared: 0, dropped: 0 };

  const MESSAGE_BUFFERS = Object.freeze([
    'recentMessages', 'unread', 'activeTopics', 'pendingThoughts'
  ]);
  const MAP_BUFFERS = Object.freeze(['memberImpressions', 'seenForwardIds']);
  const RATE_BUFFERS = Object.freeze(['wakeTimes', 'sendTimes', 'stickerCollectTimes']);

  let staleCleared = 0;
  for (const entry of Object.values(conversations)) {
    if (!entry || typeof entry !== 'object') continue;
    const activity = lastActivityOf(entry);
    if (activity > 0 && now - activity > messageTtlMs) {
      for (const field of MESSAGE_BUFFERS) {
        if (Array.isArray(entry[field]) && entry[field].length) entry[field] = [];
      }
      for (const field of MAP_BUFFERS) {
        const value = entry[field];
        if (value && typeof value === 'object' && Object.keys(value).length) {
          entry[field] = Array.isArray(value) ? [] : {};
        }
      }
      for (const field of RATE_BUFFERS) {
        if (Array.isArray(entry[field]) && entry[field].length) entry[field] = [];
      }
      staleCleared += 1;
    }
  }

  let dropped = 0;
  const keys = Object.keys(conversations);
  if (keys.length > maxConversations) {
    const ordered = keys
      .map((key) => ({ key, activity: lastActivityOf(conversations[key]) }))
      .sort((a, b) => a.activity - b.activity);
    for (let i = 0; i < keys.length - maxConversations; i++) {
      delete conversations[ordered[i].key];
      dropped += 1;
    }
  }
  return { staleCleared, dropped };
}

/**
 * social-v2-cards.json 保留策略（原地修改）：
 * 1) 超过 cardTtlMs 没有新卡片的会话整体移除（卡片可经 OneBot 回源，是典型 cache）；
 * 2) 会话总数超过 maxCardConversations 时按最近卡片时间从旧到新移除。
 */
export function applySocialCardRetention(conversations, options = {}) {
  const {
    now = Date.now(),
    cardTtlMs = SOCIAL_RETENTION_DEFAULTS.cardTtlMs,
    maxCardConversations = SOCIAL_RETENTION_DEFAULTS.maxCardConversations
  } = options;
  if (!conversations || typeof conversations !== 'object') return { dropped: 0 };

  let dropped = 0;
  for (const [key, refs] of Object.entries(conversations)) {
    const activity = lastCardActivityOf(refs);
    if (activity > 0 && now - activity > cardTtlMs) {
      delete conversations[key];
      dropped += 1;
    }
  }
  const keys = Object.keys(conversations);
  if (keys.length > maxCardConversations) {
    const ordered = keys
      .map((key) => ({ key, activity: lastCardActivityOf(conversations[key]) }))
      .sort((a, b) => a.activity - b.activity);
    for (let i = 0; i < keys.length - maxCardConversations; i++) {
      delete conversations[ordered[i].key];
      dropped += 1;
    }
  }
  return { dropped };
}
