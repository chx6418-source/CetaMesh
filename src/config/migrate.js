// 旧配置迁移与默认值合并（TASK-D1-001 Unified Config Service）。
//
// migrateLegacyConfig 是旧 bridge.js loadConfig（2026-10-04 之前的合并逻辑）的
// 逐字段等价移植：默认值、旧字段别名（allow.privates / allow.group）、
// ownerQQ / 白名单规范化、socialV2.tools 与 socialV2.sticker.collect 的深度合并
// 全部保持原语义。scripts/test-config-service.mjs 用旧实现副本做黄金参照等价测试。
//
// 注意：返回值必须是普通可变对象——桥接运行期由控制台 API 直接改写 cfg 字段。

// 桥接默认模型：新建会话显式绑定它；config.json 显式写了 dsh.model 时以配置为准。
// 必须是官方目录里声明了 image 输入的模型——QQ 图片工具（qq_get_message_images /
// qq_get_sticker_image / qq_get_self_image）返回的图片，只有在会话当前模型声明
// image 输入时才会真正投递给模型；文本模型下 DSH 会把每张图替换成
// "[image unavailable: … does not declare image input]"，表现为「图片识别失效」。
// DeepSeek-V41-Flash（deepseek-flash）声明 inputModalities = text + image。
export const DEFAULT_MODEL = 'deepseek-flash';

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// socialV2.tools 默认开关：与旧 loadConfig 末段重合并列表一致（含 slangQuery / slangSubmit）。
// clickCardButton / setStickerRemark 默认关闭是安全红线，不得改动。
const SOCIAL_V2_TOOLS_DEFAULTS = Object.freeze({
  getPrompt: true,
  getUnread: true,
  getRecent: true,
  socialState: true,
  sendGroup: true,
  sendPrivate: true,
  reply: true,
  sendBurst: true,
  sendMessage: true,
  waitMessages: true,
  feedback: true,
  getMyRecent: true,
  getMessageDetail: true,
  getActiveMembers: true,
  setWakeConfig: true,
  markRead: true,
  memory: true,
  slangQuery: true,
  slangSubmit: true,
  getImages: true,
  getForwardMsg: true,
  getCardMsg: true,
  clickCardButton: false,
  sendPoke: true,
  listStickers: true,
  getStickerImage: true,
  sendSticker: true,
  setStickerRemark: false,
  stickerNote: true,
  collectSticker: true,
  getSelfImage: true
});

const SOCIAL_V2_STICKER_DEFAULTS = Object.freeze({
  enabled: true,             // 表情包体系总开关
  syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
  maxListCount: 100,         // qq_list_stickers 单次最大返回数
  includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
  promptMaxStickers: 8       // 提示里最多列出的常用表情数
});

const SOCIAL_V2_STICKER_COLLECT_DEFAULTS = Object.freeze({
  enabled: true,             // AI 收藏他人表情总开关
  maxPerMinute: 2,           // 每分钟最多收藏次数
  maxPerHour: 10,            // 每小时最多收藏次数
  maxRemarkChars: 20         // 收藏时备注最大长度
});

/**
 * 旧 config → 规范配置。raw 必须已是解析后的普通对象（loader.js 负责 fail-closed）。
 * ownerQQ 非法时抛错（fail-closed，与旧行为一致）。
 */
export function migrateLegacyConfig(raw) {
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      model: DEFAULT_MODEL,
      reasoningEffort: 'max',
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'whale-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'whale-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用"活跃超过时长后主动收尾退场"
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示"这里要分成下一条"
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'whale-chat-v2',
      provideRecommendations: true,
      tools: { ...SOCIAL_V2_TOOLS_DEFAULTS },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: { ...SOCIAL_V2_STICKER_DEFAULTS },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    ...SOCIAL_V2_TOOLS_DEFAULTS,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  // （等价于旧实现中重复 collect 键"后者生效"的最终结果，并消除该重复键告警。）
  cfg.socialV2.sticker = {
    ...SOCIAL_V2_STICKER_DEFAULTS,
    ...(cfg.socialV2.sticker ?? {}),
    collect: {
      ...SOCIAL_V2_STICKER_COLLECT_DEFAULTS,
      ...(cfg.socialV2?.sticker?.collect ?? {})
    }
  };

  return cfg;
}
