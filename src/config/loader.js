// 统一配置读取 / 原子写入原语（TASK-D1-001 Unified Config Service）。
//
// 语义与旧 bridge.js readJsonSafe / atomicWriteJson 对齐：
// - UTF-8 BOM 容错（Windows 下编辑器常见的 \uFEFF）；
// - required=true（桥接主配置）：文件缺失 / JSON 解析失败 / 根不是对象 → 抛
//   ConfigError，禁止带着损坏配置启动（fail-closed）；
// - required=false（MCP 工具等场景）：失败返回 fallback（默认 {}），由使用点
//   按"未配置"自行 fail-closed；
// - 错误消息文本与旧实现保持一致，避免破坏依赖该文案的日志/诊断。

import fs from 'node:fs';
import { parseJsonText, writeJsonAtomic } from '../storage/json-file.js';

export class ConfigError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 解析配置文本：BOM 容错由 Storage Primitive 统一处理；损坏或根不是对象时抛 ConfigError。 */
export function parseConfigText(text, { file = '<memory>' } = {}) {
  let parsed;
  try {
    parsed = parseJsonText(text, { file });
  } catch (error) {
    const cause = error?.cause ?? error;
    throw new ConfigError(
      'CONFIG_CORRUPT',
      `配置文件读取/解析失败：${file}（${cause?.message ?? cause}）`,
      { cause }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('CONFIG_NOT_OBJECT', `配置格式错误：${file}`);
  }
  return parsed;
}

/**
 * 读取原始配置对象（不做默认值合并，见 migrate.js）。
 * required=true：缺失 / 损坏抛 ConfigError；required=false：失败返回 fallback。
 */
export function readRawConfig(file, { required = true, fallback = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (!required) return fallback;
    throw new ConfigError(
      'CONFIG_MISSING',
      `配置文件读取/解析失败：${file}（${error?.message ?? error}）`,
      { cause: error }
    );
  }
  if (!required) {
    try {
      return parseConfigText(text, { file });
    } catch {
      return fallback;
    }
  }
  return parseConfigText(text, { file });
}

/**
 * MCP 工具语义：读不到 / 解析失败一律按"未配置"空对象处理。
 * 安全开关（clickCardButton / allowProcessControl 等）在使用点以 `!== true` 判断，
 * 空对象天然 fail-closed。
 */
export function readRawConfigOrEmpty(file) {
  return readRawConfig(file, { required: false, fallback: {} });
}

/**
 * 原子写 JSON：临时文件 + rename 由 Storage Primitive 统一提供
 * （crypto 随机临时名、0600、fsync、失败清理、Windows rename 重试），
 * 避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
 */
export function atomicWriteConfig(file, obj) {
  writeJsonAtomic(file, obj);
}
