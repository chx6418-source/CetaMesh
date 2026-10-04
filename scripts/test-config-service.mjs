// CetaMesh Desktop — 统一配置服务回归测试（TASK-D1-001 Unified Config Service）。
// 用法：node scripts/test-config-service.mjs
//
// 覆盖范围：
//   1. 黄金等价：migrateLegacyConfig 与抽取前 bridge.js loadConfig 的输出逐字段一致；
//   2. 安全不变量：allowAllWhenEmpty / socialV2.tools.clickCardButton / setStickerRemark 默认 fail-closed；
//   3. loader fail-closed：BOM 容错、缺失 / 损坏 / 根非对象、readRawConfigOrEmpty 空对象语义；
//   4. service：updateSection 浅合并保留兄弟与未知字段、writeFile、load 的 fail-closed。
//
// 本测试不读取仓库 config.json，不访问网络 / DSH / SnowLuma / QQ。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepStrictEqual } from 'node:assert/strict';

import {
  ConfigError,
  atomicWriteConfig,
  parseConfigText,
  readRawConfig,
  readRawConfigOrEmpty
} from '../src/config/loader.js';
import { DEFAULT_MODEL as MIGRATED_DEFAULT_MODEL, migrateLegacyConfig } from '../src/config/migrate.js';
import { SECURITY_DEFAULTS, assertSecurityInvariants, validateRawConfig } from '../src/config/schema.js';
import { createConfigService } from '../src/config/service.js';

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name + (extra ? ' — ' + extra : ''));
  } else {
    failed += 1;
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};
const checkEqual = (name, actual, expected) => {
  try {
    deepStrictEqual(actual, expected);
    check(name, true);
  } catch (error) {
    check(name, false, String(error.message).split('\n').slice(0, 10).join(' | '));
  }
};
const capture = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, name: error?.name, code: error?.code, message: String(error?.message ?? error) };
  }
};

// ── 黄金参照（只读）：抽取前 bridge.js 的 loadConfig 实现 ──────────────────
// 来源：main@d0ded2d:src/bridge.js 的 normalizeOwnerQQ / normalizeIdList /
// DEFAULT_MODEL / loadConfig 原文副本。它不是运行时代码，仅用于证明
// src/config/migrate.js 的抽取没有改变任何字段语义。

function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

const DEFAULT_MODEL = 'deepseek-flash';

function legacyLoadConfig(file) {
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
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
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
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
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
      tools: {
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
      },
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
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
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
    getSelfImage: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  return cfg;
}

// ── 1. 黄金等价：迁移结果必须与抽取前实现完全一致 ──────────────────────────
const FIXTURES = {
  '空配置': {},
  '旧别名 allow.privates / allow.group / deny.privates / deny.group': {
    allow: { privates: [123, '456', 'not-a-number'], group: ['789'] },
    deny: { privates: ['1'], group: [2] }
  },
  '显式 dsh.model 与未知字段': {
    dsh: { model: 'custom-model', reasoningEffort: 'low' },
    sessionCwd: 'D:/work',
    unknownSection: { keep: true }
  },
  'socialV2 缺 tools 与 sticker.collect': {
    socialV2: { enabled: false, sticker: { maxListCount: 7 } }
  },
  'socialV2.tools 部分覆盖': {
    socialV2: { tools: { clickCardButton: true, sendGroup: false } }
  },
  'socialV2.sticker.collect 部分覆盖': {
    socialV2: { sticker: { collect: { maxPerHour: 3 } } }
  },
  '安全开关显式开启': {
    allowAllWhenEmpty: true,
    snowluma: { allowProcessControl: true },
    socialV2: { tools: { setStickerRemark: true } }
  },
  '安全开关类型错误（字符串）': { allowAllWhenEmpty: 'yes' },
  'ownerQQ 数字': { ownerQQ: 10001 },
  'ownerQQ 空字符串': { ownerQQ: '' },
  '完整配置块（slang / social / 安全通知）': {
    ownerQQ: '10002',
    consolePort: 3200,
    security: { interceptNotify: false },
    slang: { enabled: false, injectMax: 3 },
    social: { enabled: false, contextWindow: 5 },
    ttsLocal: { voice: 'x' }
  }
};

for (const name of Object.keys(FIXTURES)) {
  const fixture = JSON.parse(JSON.stringify(FIXTURES[name]));
  const before = JSON.parse(JSON.stringify(fixture));
  const expected = legacyLoadConfig(fixture);
  const actual = migrateLegacyConfig(fixture);
  checkEqual('黄金等价 ' + name, actual, expected);
  checkEqual('迁移不修改输入 ' + name, fixture, before);
}

const THROWING_FIXTURES = {
  'ownerQQ 非数字': { ownerQQ: 'abc' },
  'ownerQQ 负数': { ownerQQ: -1 },
  'ownerQQ 零': { ownerQQ: 0 }
};
for (const name of Object.keys(THROWING_FIXTURES)) {
  const legacy = capture(() => legacyLoadConfig(JSON.parse(JSON.stringify(THROWING_FIXTURES[name]))));
  const migrated = capture(() => migrateLegacyConfig(JSON.parse(JSON.stringify(THROWING_FIXTURES[name]))));
  check('fail-closed 抛错等价 ' + name, legacy.threw && migrated.threw,
    'legacy=' + legacy.threw + ' migrated=' + migrated.threw);
  check('fail-closed 文案一致 ' + name, legacy.message === migrated.message,
    legacy.message + ' vs ' + migrated.message);
}

// ── 2. 安全不变量（默认必须 fail-closed） ────────────────────────────────
const defaults = migrateLegacyConfig({});
check('默认 allowAllWhenEmpty 为 false', defaults.allowAllWhenEmpty === false);
check('默认 clickCardButton 为 false', defaults.socialV2.tools.clickCardButton === false);
check('默认 setStickerRemark 为 false', defaults.socialV2.tools.setStickerRemark === false);
check('安全开关类型错误不开启', migrateLegacyConfig({ allowAllWhenEmpty: 'yes' }).allowAllWhenEmpty === false);
check('缺失 tools 时安全开关仍为 false',
  migrateLegacyConfig({ socialV2: { tools: {} } }).socialV2.tools.clickCardButton === false);
check('缺失 socialV2 时安全开关仍为 false',
  migrateLegacyConfig({ socialV2: {} }).socialV2.tools.setStickerRemark === false);
check('显式 true 被尊重',
  migrateLegacyConfig({ socialV2: { tools: { clickCardButton: true } } }).socialV2.tools.clickCardButton === true);
check('DEFAULT_MODEL 未漂移', MIGRATED_DEFAULT_MODEL === 'deepseek-flash' && defaults.dsh.model === 'deepseek-flash');
check('dsh.baseUrl 默认未漂移', defaults.dsh.baseUrl === 'http://127.0.0.1:3080');
check('SECURITY_DEFAULTS 全部 fail-closed', Object.values(SECURITY_DEFAULTS).every((value) => value === false));
check('assertSecurityInvariants 接受默认配置', capture(() => assertSecurityInvariants(defaults)).threw === false);
// assertSecurityInvariants(cfg, raw) 的真实契约：检测「原始值未开启、迁移后却为 true」的
// fail-open 漂移，而不是对迁移结果再做类型校验（类型已由 migrate/schema 保证）。
check('assertSecurityInvariants 接受默认配置与空 raw',
  capture(() => assertSecurityInvariants(defaults, {})).threw === false);
check('assertSecurityInvariants 拒绝未经配置即开启（fail-open 漂移）',
  capture(() => assertSecurityInvariants({ ...defaults, allowAllWhenEmpty: true }, {})).threw === true);
check('assertSecurityInvariants 拒绝非 true 原始值被升级为 true',
  capture(() => assertSecurityInvariants({ ...defaults, allowAllWhenEmpty: true }, { allowAllWhenEmpty: 'yes' })).threw === true);
check('assertSecurityInvariants 拒绝 clickCardButton 未经配置即开启',
  capture(() => assertSecurityInvariants(
    { ...defaults, socialV2: { ...defaults.socialV2, tools: { ...defaults.socialV2.tools, clickCardButton: true } } },
    {}
  )).threw === true);
checkEqual('schema 合法配置无 issue', validateRawConfig({ ownerQQ: 10001, dsh: { model: 'x' } }).issues, []);
checkEqual('schema 空配置 ok', validateRawConfig({}).ok, true);
check('schema 报告错误类型', validateRawConfig({ ownerQQ: {} }).ok === false);

// ── 3. loader：fail-closed 与 BOM 容错 ──────────────────────────────────
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-config-test-'));
try {
  const file = path.join(tempDir, 'config.json');

  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ ownerQQ: 10001 }), 'utf8');
  checkEqual('readRawConfig BOM 容错', readRawConfig(file), { ownerQQ: 10001 });
  checkEqual('parseConfigText BOM 容错', parseConfigText('\uFEFF{"a":1}'), { a: 1 });

  fs.writeFileSync(file, '{ not json', 'utf8');
  const corrupt = capture(() => readRawConfig(file));
  check('损坏配置 fail-closed', corrupt.threw && corrupt.name === 'ConfigError', corrupt.name);
  check('损坏配置 code=CONFIG_CORRUPT', corrupt.code === 'CONFIG_CORRUPT', String(corrupt.code));
  checkEqual('MCP 语义：损坏返回空对象', readRawConfigOrEmpty(file), {});

  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  const arrayRoot = capture(() => readRawConfig(file));
  check('根为数组 fail-closed', arrayRoot.threw && arrayRoot.code === 'CONFIG_NOT_OBJECT', String(arrayRoot.code));
  checkEqual('MCP 语义：根为数组返回空对象', readRawConfigOrEmpty(file), {});

  const missing = path.join(tempDir, 'missing.json');
  const absent = capture(() => readRawConfig(missing));
  check('缺失配置 fail-closed', absent.threw && absent.name === 'ConfigError', absent.name);
  check('缺失配置 code=CONFIG_MISSING', absent.code === 'CONFIG_MISSING', String(absent.code));
  check('缺失配置抛 ConfigError 实例', capture(() => readRawConfig(missing)).value === undefined);
  checkEqual('MCP 语义：缺失返回空对象', readRawConfigOrEmpty(missing), {});
  checkEqual('required=false 返回 fallback', readRawConfig(missing, { required: false, fallback: { x: 1 } }), { x: 1 });

  // ── 4. Config Service 读写边界 ───────────────────────────────────────
  const serviceFile = path.join(tempDir, 'service.json');
  atomicWriteConfig(serviceFile, { consolePort: 3100, unknown: { keep: 1 }, dsh: { model: 'a' } });
  const service = createConfigService({ configFile: serviceFile });

  const loaded = service.load();
  check('service.load 迁移默认值', loaded.config.consolePort === 3100 && loaded.config.dsh.model === 'a');
  check('service.load 保留未知 section', loaded.raw.unknown.keep === 1);
  checkEqual('service.load issues 为空', loaded.issues, []);

  service.updateSection('dsh', { reasoningEffort: 'low' });
  const afterMerge = service.readRaw();
  check('updateSection 浅合并保留兄弟字段',
    afterMerge.dsh.model === 'a' && afterMerge.dsh.reasoningEffort === 'low');
  check('updateSection 保留未知 section 与其它字段', afterMerge.unknown.keep === 1 && afterMerge.consolePort === 3100);

  service.updateSection('dsh', { model: 'b' }, { merge: false });
  checkEqual('updateSection merge=false 整节替换', service.readRaw().dsh, { model: 'b' });

  service.writeFile({ fresh: true });
  checkEqual('writeFile 整文件替换', service.readRaw(), { fresh: true });

  check('updateSection 拒绝非对象 patch', capture(() => service.updateSection('dsh', null)).threw === true);
  check('updateSection 要求 section 名', capture(() => service.updateSection('', {})).threw === true);
  check('createConfigService 要求 configFile', capture(() => createConfigService({})).threw === true);

  fs.writeFileSync(serviceFile, 'broken', 'utf8');
  const brokenLoad = capture(() => service.load());
  check('service.load 对损坏文件 fail-closed', brokenLoad.threw && brokenLoad.code === 'CONFIG_CORRUPT', String(brokenLoad.code));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('统一配置服务回归全部通过（TASK-D1-001）');
