// 统一配置 Schema（TASK-D1-001 Unified Config Service）。
//
// 定位：
// - Zod schema 是 config.json 的校验契约，只做诊断（validateRawConfig 返回 issues），
//   不做改写——默认值合并与旧字段迁移在 migrate.js，与旧 loadConfig 行为等价；
// - 安全相关字段的类型与 fail-closed 语义在这里显式表达：布尔安全开关必须
//   显式 true 才视为开启（=== true 语义），缺失/类型错误在使用点一律关闭。
// - 未逐字段枚举的调参区块（wake/send/wait 等）按宽松 record 校验，
//   避免对既有安装引入新的启动失败面。

import { z } from 'zod';

// 安全红线默认值：新增安全开关时必须在这里登记 fail-closed 语义。
export const SECURITY_DEFAULTS = Object.freeze({
  // 私聊/群聊白名单均为空时是否放行所有目标（=== true 才开启）。
  allowAllWhenEmpty: false,
  // SnowLuma 进程启停控制（=== true 才开启）。
  allowProcessControl: false,
  // QQ 官方卡片按钮点击（高风险写操作，缺失或不为 true 一律关闭）。
  clickCardButton: false,
  // 表情包备注写入（默认关闭）。
  setStickerRemark: false
});

const idList = z.array(z.union([z.string(), z.number()]));
const jsonRecord = z.record(z.string(), z.unknown());

const dshSchema = z.looseObject({
  baseUrl: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  authCookie: z.string().optional(),
  homeDir: z.string().optional(),
  codingPreset: z.string().optional(),
  socialPreset: z.string().optional(),
  executable: z.string().optional(),
  customPaths: z.array(z.string()).optional()
});

const snowlumaSchema = z.looseObject({
  wsUrl: z.string().optional(),
  httpUrl: z.string().optional(),
  accessToken: z.string().optional(),
  httpAccessToken: z.string().optional(),
  launcherPath: z.string().optional(),
  homeDir: z.string().optional(),
  webUrl: z.string().optional(),
  customPaths: z.array(z.string()).optional(),
  allowProcessControl: z.boolean().optional()
});

const allowDenySchema = z.looseObject({
  private: idList.optional(),
  groups: idList.optional()
});

const slangSchema = z.looseObject({
  enabled: z.boolean().optional(),
  extractMinMessages: z.number().optional(),
  extractCooldownMs: z.number().optional(),
  inferenceThresholds: z.array(z.number()).optional(),
  injectMax: z.number().optional(),
  learnerPreset: z.string().optional(),
  workspaceTitle: z.string().optional(),
  autoResearch: z.boolean().optional()
});

const socialSchema = z.looseObject({
  enabled: z.boolean().optional(),
  maxReplyChars: z.number().optional(),
  mustReplyKeywords: z.array(z.string()).optional(),
  contextWindow: z.number().optional()
});

const socialV2Schema = z.looseObject({
  enabled: z.boolean().optional(),
  autoReplyCheckMs: z.number().optional(),
  agentPreset: z.string().optional(),
  provideRecommendations: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  turnIsolation: jsonRecord.optional(),
  wake: jsonRecord.optional(),
  send: jsonRecord.optional(),
  wait: jsonRecord.optional(),
  sticker: jsonRecord.optional(),
  proactive: jsonRecord.optional(),
  feedback: jsonRecord.optional(),
  context: jsonRecord.optional()
});

export const rawConfigSchema = z.looseObject({
  dsh: dshSchema.optional(),
  snowluma: snowlumaSchema.optional(),
  ownerQQ: z.union([z.number(), z.string(), z.null()]).optional(),
  sessionCwd: z.string().optional(),
  agentPreset: z.string().optional(),
  workspaceTitle: z.string().optional(),
  allow: allowDenySchema.optional(),
  deny: allowDenySchema.optional(),
  allowAllWhenEmpty: z.boolean().optional(),
  ackMessage: z.string().optional(),
  sendDelayMs: z.number().optional(),
  questionTimeoutMs: z.number().optional(),
  consolePort: z.number().optional(),
  consoleToken: z.string().optional(),
  security: z.looseObject({ interceptNotify: z.boolean().optional() }).optional(),
  slang: slangSchema.optional(),
  social: socialSchema.optional(),
  socialV2: socialV2Schema.optional(),
  fileSend: jsonRecord.optional(),
  ttsLocal: jsonRecord.optional(),
  kugou: jsonRecord.optional()
});

/** 诊断性校验：返回 { ok, issues }，不抛错、不改写配置。 */
export function validateRawConfig(raw) {
  const result = rawConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code ?? 'invalid',
      message: issue.message
    }))
  };
}

/**
 * 迁移产物的安全不变量：迁移层不得把未显式开启（原始值 !== true）的安全开关
 * 升级为 true —— 这是 fail-closed 红线。类型异常值按原样保留（与旧实现等价，
 * 使用点的 `=== true` / `!== true` 判断天然将其视为关闭），类型问题由
 * validateRawConfig 做诊断。发现破坏直接抛错，调用方不得吞掉。
 */
export function assertSecurityInvariants(cfg, raw = undefined) {
  const checkFlag = (rawValue, migratedValue, label) => {
    if (rawValue === undefined) {
      if (migratedValue === true) throw new Error(`安全不变量被破坏：${label} 未经配置即开启`);
      return;
    }
    if (rawValue !== true && migratedValue === true) {
      throw new Error(`安全不变量被破坏：${label} 的非 true 原始值被迁移升级为 true`);
    }
  };
  checkFlag(raw?.allowAllWhenEmpty, cfg.allowAllWhenEmpty, 'allowAllWhenEmpty');
  checkFlag(raw?.snowluma?.allowProcessControl, cfg.snowluma?.allowProcessControl, 'snowluma.allowProcessControl');
  checkFlag(raw?.socialV2?.tools?.clickCardButton, cfg.socialV2?.tools?.clickCardButton, 'socialV2.tools.clickCardButton');
  checkFlag(raw?.socialV2?.tools?.setStickerRemark, cfg.socialV2?.tools?.setStickerRemark, 'socialV2.tools.setStickerRemark');
  return true;
}
