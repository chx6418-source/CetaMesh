// 统一配置服务（TASK-D1-001 Unified Config Service）：config.json 的规范读写入口。
//
// 当前阶段边界（最小侵入、向后兼容）：
// - 桥接与 MCP 工具的"读取"已迁移到 loader.js + migrate.js（行为与旧实现等价）；
// - 控制台各写路径本阶段仍按原样直接读改写原始文件（保留未知字段与既有行为），
//   后续阶段逐个迁移到这里的 updateSection / writeFile。
// - updateSection 的"浅合并 section、原样保留兄弟字段"语义与控制台既有的
//   `file[section] = { ...(file[section] ?? {}), ...patch }` 写法一致。

import { readRawConfig, atomicWriteConfig } from './loader.js';
import { migrateLegacyConfig } from './migrate.js';
import { validateRawConfig } from './schema.js';

export { ConfigError, readRawConfig, readRawConfigOrEmpty, atomicWriteConfig, parseConfigText } from './loader.js';
export { migrateLegacyConfig, normalizeOwnerQQ, normalizeIdList, DEFAULT_MODEL } from './migrate.js';
export { validateRawConfig, assertSecurityInvariants, SECURITY_DEFAULTS, rawConfigSchema } from './schema.js';

export function createConfigService({ configFile } = {}) {
  if (!configFile || typeof configFile !== 'string') {
    throw new Error('createConfigService 需要 configFile（config.json 的绝对路径）');
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  return {
    configFile,

    /**
     * fail-closed 读取并迁移：文件缺失 / JSON 损坏 / 根不是对象 → ConfigError。
     * 返回 { config, raw, issues }；issues 是 Zod 诊断（不阻断启动，与旧行为一致）。
     */
    load() {
      const raw = readRawConfig(configFile, { required: true });
      return {
        config: migrateLegacyConfig(raw),
        raw,
        issues: validateRawConfig(raw).issues
      };
    },

    /** 读取原始文件对象（不做迁移；等价于旧 readJsonSafe(CONFIG_FILE, null, true)）。 */
    readRaw() {
      return readRawConfig(configFile, { required: true });
    },

    /**
     * 读取-改写-原子落盘。默认 merge=true 浅合并指定 section；merge=false 整节替换。
     * 未知字段与兄弟 section 原样保留。
     */
    updateSection(section, patch, { merge = true } = {}) {
      if (typeof section !== 'string' || !section) throw new Error('updateSection 需要 section 名');
      if (!isPlainObject(patch)) throw new Error('updateSection 的 patch 必须是普通对象');
      const raw = readRawConfig(configFile, { required: true });
      const current = isPlainObject(raw[section]) ? raw[section] : {};
      raw[section] = merge ? { ...current, ...patch } : { ...patch };
      atomicWriteConfig(configFile, raw);
      return raw;
    },

    /** 整文件原子替换（保留给策略写这类需要精确控制全文的场景）。 */
    writeFile(nextRaw) {
      if (!isPlainObject(nextRaw)) throw new Error('writeFile 的内容必须是普通对象');
      atomicWriteConfig(configFile, nextRaw);
    }
  };
}
